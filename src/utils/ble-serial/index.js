/**
 * Web Bluetooth (BLE) 串口传输层。
 *
 * 面向「BLE-UART 桥接器」：设备侧跑 NUS（Nordic UART Service），把 BLE 收到的
 * 字节原样转发到电台串口，反之亦然。参考桥接固件（ESP32-C3 / ESP-IDF）：
 *   https://github.com/wty2019wty/ESP32C3_NUS_BLE
 * 电台协议（0xABCD 帧）由 serial.js 统一处理；本模块还负责与桥接器协商 UART
 * 波特率（控制帧 "ESC B L BAUD=…" / "FLUSH"，兼容该固件的控制协议）。
 *
 * 对外暴露与 WebUSB/Web Serial 兼容的 SerialPort 表面：
 *   - readable  : ReadableStream<Uint8Array>（NUS 通知）
 *   - writable  : WritableStream<Uint8Array>（NUS 写特征，自动按 MTU 分片）
 *   - connected : 连接状态
 *   - close()   : 关闭连接
 *   - chip      : 供 serial.js 判定“整帧单次写出”
 */

import { logWebUsb, fmtHex, isDebugVerbose } from '../serial-log.js';

/* NUS UUID（与固件 ble_uart 组件一致） */
export const BLE_NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const BLE_NUS_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 网页 -> 设备（写）
export const BLE_NUS_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 设备 -> 网页（通知）

// 最小 ATT MTU(23) 对应的有效负载为 20 字节；按此分片可兼容任何桥接器。
const DEFAULT_CHUNK = 20;
// 单次连接内最多打印多少条原始收发日志（避免拖慢主线程、掩盖丢字节）
const MAX_VERBOSE_LOGS = 60;

/* 桥接器控制帧魔术前缀 "ESC B L"（与固件 ble_uart 一致） */
const BLE_MAGIC = Uint8Array.of(0x1b, 0x42, 0x4c);
// 桥接器在订阅/上电后主动上报 READY（如 "READY BAUD 115200"），据此前置配置 UART 波特率。
const BRIDGE_READY_TIMEOUT = 800;
const BRIDGE_PROBE_TIMEOUT = 500;
// 控制命令生效后给桥接器/电台留出的稳定时间
const BRIDGE_CFG_SETTLE = 200;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export function hasBleSupport() {
    return (
        typeof navigator !== 'undefined' &&
        !!navigator.bluetooth &&
        typeof navigator.bluetooth.requestDevice === 'function'
    );
}

/**
 * 与 WebUsbSerialPort 同构的 BLE 串口，供 serial.js 的读写逻辑直接复用。
 */
export class BleSerialPort {
    /**
     * @param {BluetoothDevice} device
     * @param {BluetoothRemoteGATTCharacteristic} writeChar  网页 -> 设备
     * @param {BluetoothRemoteGATTCharacteristic} notifyChar 设备 -> 网页
     * @param {{ chunkSize?: number, chip?: string }} [options]
     */
    constructor(device, writeChar, notifyChar, options = {}) {
        this._device = device;
        this._writeChar = writeChar;
        this._notifyChar = notifyChar;
        this._chunkSize = options.chunkSize || DEFAULT_CHUNK;
        // chip 为字符串会让 serial.js 走“整帧单次写出”路径；
        // 实际的分片交给本模块的 writable 处理。
        this.chip = options.chip || 'BLE-NUS';
        this.transport = 'ble';

        this._opened = true;
        this._rxQueue = [];
        this._rxWaiter = null;
        this._readable = null;
        this._writable = null;
        this._controller = null;
        this._rxCount = 0;
        this._txCount = 0;

        // NUS 写特征是否支持“无响应写”（吞吐更好）；否则退化为“有响应写”。
        const props = writeChar && writeChar.properties;
        this._useWriteWithoutResponse = !props || props.writeWithoutResponse === true;

        this._onNotify = (event) => {
            const dv = event.target.value;
            if (!dv) return;
            const bytes = new Uint8Array(dv.buffer, dv.byteOffset, dv.byteLength);
            if (!bytes.length) return;
            this._rxCount += 1;
            if (this._rxCount <= MAX_VERBOSE_LOGS || isDebugVerbose()) {
                logWebUsb(`BLE in#${this._rxCount} ${fmtHex(bytes)}`);
            }
            this._enqueue(bytes.slice());
        };

        this._onGattDisconnected = () => {
            if (!this._opened) return;
            logWebUsb('BLE gattserverdisconnected');
            this._opened = false;
            this._closeReadable();
        };

        notifyChar.addEventListener('characteristicvaluechanged', this._onNotify);
        device.addEventListener('gattserverdisconnected', this._onGattDisconnected);

        logWebUsb(
            `BLE open: ${this._device.name || '(未命名)'} chunk=${this._chunkSize} ` +
            `writeWithoutResponse=${this._useWriteWithoutResponse}`
        );
    }

    get connected() {
        return (
            this._opened &&
            !!this._device &&
            !!this._device.gatt &&
            this._device.gatt.connected === true
        );
    }

    get readable() {
        if (!this._opened) return null;
        if (!this._readable) {
            this._readable = new ReadableStream({
                start: (controller) => {
                    this._controller = controller;
                },
                pull: (controller) => {
                    if (this._rxQueue.length) {
                        controller.enqueue(this._rxQueue.shift());
                        return;
                    }
                    return new Promise((resolve) => {
                        this._rxWaiter = { controller, resolve };
                    });
                },
                cancel: () => {
                    this._rxQueue = [];
                    this._resolveWaiter();
                    this._readable = null;
                    this._controller = null;
                },
            });
        }
        return this._readable;
    }

    get writable() {
        if (!this._opened) return null;
        if (!this._writable) {
            this._writable = new WritableStream({
                write: async (chunk) => {
                    const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
                    if (!data.length) return;
                    for (let offset = 0; offset < data.length; offset += this._chunkSize) {
                        if (!this._opened) throw new Error('BLE 已断开');
                        const slice = data.subarray(offset, offset + this._chunkSize);
                        this._txCount += 1;
                        if (this._txCount <= MAX_VERBOSE_LOGS || isDebugVerbose()) {
                            logWebUsb(`BLE out#${this._txCount} ${fmtHex(slice)}`);
                        }
                        await this._writeChunk(slice);
                    }
                },
                abort: () => {
                    this._writable = null;
                },
            });
        }
        return this._writable;
    }

    getInfo() {
        return {
            bluetoothName: (this._device && this._device.name) || '',
            bluetoothId: (this._device && this._device.id) || '',
            chip: this.chip,
        };
    }

    async close() {
        if (!this._opened && !this._readable) return;
        logWebUsb('BLE close()');
        this._opened = false;

        try {
            this._notifyChar.removeEventListener('characteristicvaluechanged', this._onNotify);
        } catch {}
        try {
            this._device.removeEventListener('gattserverdisconnected', this._onGattDisconnected);
        } catch {}
        try {
            if (this._notifyChar) await this._notifyChar.stopNotifications();
        } catch {}
        this._closeReadable();
        try {
            if (this._writable) {
                await this._writable.abort();
                this._writable = null;
            }
        } catch {}
        try {
            if (this._device && this._device.gatt && this._device.gatt.connected) {
                this._device.gatt.disconnect();
            }
        } catch {}
    }

    async _writeChunk(slice) {
        if (this._useWriteWithoutResponse) {
            await this._writeChar.writeValueWithoutResponse(slice);
        } else {
            await this._writeChar.writeValue(slice);
        }
    }

    /**
     * 向桥接器发送一条控制命令（如 "BAUD=38400" / "FLUSH"）。
     * 控制帧格式与 index.html 一致：MAGIC("ESC B L") + 命令文本，无换行。
     * 桥接器按 BLE 写包解析命令，因此命令需尽量单包发出。
     */
    async sendBridgeCommand(text) {
        const body = new TextEncoder().encode(text);
        const frame = new Uint8Array(BLE_MAGIC.length + body.length);
        frame.set(BLE_MAGIC, 0);
        frame.set(body, BLE_MAGIC.length);
        logWebUsb(`BLE bridge >> ${text}`);
        for (let offset = 0; offset < frame.length; offset += this._chunkSize) {
            await this._writeChunk(frame.subarray(offset, offset + this._chunkSize));
        }
    }

    /** 已收到的通知中是否出现桥接器控制帧（魔术前缀 "ESC B L"）。 */
    hasBridgeFrame() {
        for (const chunk of this._rxQueue) {
            for (let i = 0; i + BLE_MAGIC.length <= chunk.length; i++) {
                if (
                    chunk[i] === BLE_MAGIC[0] &&
                    chunk[i + 1] === BLE_MAGIC[1] &&
                    chunk[i + 2] === BLE_MAGIC[2]
                ) {
                    return true;
                }
            }
        }
        return false;
    }

    /** 等待桥接器控制帧出现，用于判定对方是否为 ESC-BL 桥接器。 */
    async waitForBridgeFrame(timeoutMs) {
        const deadline = Date.now() + timeoutMs;
        while (Date.now() < deadline) {
            if (this.hasBridgeFrame()) return true;
            if (!this._opened) return false;
            await sleep(30);
        }
        return this.hasBridgeFrame();
    }

    /**
     * 配置桥接器：把 UART 波特率切到 baudRate 并清空链路残留。
     * 仅在确认对端是 ESC-BL 桥接器时调用，避免污染普通 NUS 透传设备。
     * @returns {Promise<boolean>} 是否完成了配置
     */
    async configureBridge(baudRate) {
        if (!(await this.waitForBridgeFrame(BRIDGE_READY_TIMEOUT))) {
            // 未见 READY，主动探测一次（部分固件需收到命令才回包）
            try {
                await this.sendBridgeCommand('STATUS');
            } catch {}
            if (!(await this.waitForBridgeFrame(BRIDGE_PROBE_TIMEOUT))) {
                logWebUsb('BLE 未检测到桥接器控制帧，按普通 NUS 透传处理');
                return false;
            }
        }
        await this.sendBridgeCommand(`BAUD=${baudRate}`);
        await sleep(BRIDGE_CFG_SETTLE);
        try {
            await this.sendBridgeCommand('FLUSH');
            await sleep(BRIDGE_CFG_SETTLE);
        } catch {}
        logWebUsb(`BLE 桥接器 UART 波特率已设为 ${baudRate}`);
        return true;
    }

    _resolveWaiter() {
        if (this._rxWaiter) {
            const { resolve } = this._rxWaiter;
            this._rxWaiter = null;
            try { resolve(); } catch {}
        }
    }

    _enqueue(bytes) {
        if (!this._opened) return;
        if (this._rxWaiter) {
            const { controller, resolve } = this._rxWaiter;
            this._rxWaiter = null;
            controller.enqueue(bytes);
            resolve();
            return;
        }
        this._rxQueue.push(bytes);
    }

    /** 让挂起的 read() 以 done 结束，readPacket 会据此抛出“流已关闭”。 */
    _closeReadable() {
        this._rxQueue = [];
        this._resolveWaiter();
        try {
            if (this._controller) this._controller.close();
        } catch {}
        this._readable = null;
        this._controller = null;
    }
}

/**
 * 弹出系统蓝牙选择框并连接 NUS 设备，返回 SerialPort 兼容对象。
 * 连接后会尝试把桥接器 UART 波特率配置为 baudRate（默认 38400，即 UV-K5/K6 标准）。
 * 注意：requestDevice 必须在用户手势（点击）中调用。
 * @param {{ chunkSize?: number, baudRate?: number, configureBridge?: boolean }} [options]
 * @returns {Promise<BleSerialPort>}
 */
export async function requestBleSerialPort(options = {}) {
    if (!hasBleSupport()) {
        throw new Error('Web Bluetooth is not available');
    }
    if (typeof isSecureContext !== 'undefined' && !isSecureContext) {
        throw new Error('Web Bluetooth 需要安全上下文（https 或 localhost）');
    }

    logWebUsb('BLE requestDevice service=NUS');
    const device = await navigator.bluetooth.requestDevice({
        filters: [{ services: [BLE_NUS_SERVICE] }],
        optionalServices: [BLE_NUS_SERVICE],
    });
    logWebUsb(`BLE requestDevice ok name=${device.name || '(未命名)'} id=${device.id}`);

    const server = await device.gatt.connect();
    const service = await server.getPrimaryService(BLE_NUS_SERVICE);
    const writeChar = await service.getCharacteristic(BLE_NUS_WRITE);
    const notifyChar = await service.getCharacteristic(BLE_NUS_NOTIFY);

    // 先构造端口（挂上通知监听），再开启通知，避免漏掉最初的通知。
    const port = new BleSerialPort(device, writeChar, notifyChar, options);
    try {
        await notifyChar.startNotifications();
    } catch (error) {
        await port.close();
        throw error;
    }

    // 桥接器默认可能是 115200，而电台是 38400；必须切成目标波特率，否则握手超时。
    if (options.configureBridge !== false) {
        try {
            await port.configureBridge(options.baudRate || 38400);
        } catch (error) {
            logWebUsb(`BLE 桥接器配置失败（继续尝试）: ${error?.name || ''} ${error?.message || error}`);
        }
    }
    return port;
}
