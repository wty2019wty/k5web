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

import { logWebUsb, fmtHex, isDebugVerbose, addDebugControl } from '../serial-log.js';

/* NUS UUID（与固件 ble_uart 组件一致） */
export const BLE_NUS_SERVICE = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
export const BLE_NUS_WRITE = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // 网页 -> 设备（写）
export const BLE_NUS_NOTIFY = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // 设备 -> 网页（通知）

// BLE 写分片档位（字节）。实际可用负载 = 协商 MTU - 3：
//   - 默认 MTU 23 -> 20 字节（兼容性下限）
//   - 桥接器请求 MTU 512（ESP32C3_NUS_BLE/sdkconfig.defaults），大包可显著提速（刷机尤其明显）
// 档位：512 / 256 / 128 / 64 / 32 / 20；或 "auto"：从 512 逐级降级并记住本次可用值。
export const BLE_CHUNK_OPTIONS = [512, 256, 128, 64, 32, 20];
export const BLE_CHUNK_AUTO = 'auto';
const CHUNK_STORAGE_KEY = 'k5web.bleChunkSize';
// 本次会话内“自动”模式已确认可用的最大分片：重连时直接用它，省去再次降级。
let autoChunkHint = null;

/** 读取用户选择的 BLE 写分片档位（localStorage 持久化；默认 auto）。 */
export function getBleChunkSetting() {
    try {
        const value = localStorage.getItem(CHUNK_STORAGE_KEY);
        if (value === BLE_CHUNK_AUTO) return BLE_CHUNK_AUTO;
        const num = Number(value);
        if (BLE_CHUNK_OPTIONS.includes(num)) return num;
    } catch {}
    return BLE_CHUNK_AUTO;
}

/** 保存 BLE 写分片档位到 localStorage。 */
export function setBleChunkSetting(value) {
    try {
        if (value === BLE_CHUNK_AUTO) {
            localStorage.setItem(CHUNK_STORAGE_KEY, BLE_CHUNK_AUTO);
        } else if (BLE_CHUNK_OPTIONS.includes(Number(value))) {
            localStorage.setItem(CHUNK_STORAGE_KEY, String(Number(value)));
        }
    } catch {}
}

/** 生成降级阶梯：auto 从 512 起；固定档从所选值起，仍允许向下（不高于所选值）。 */
function buildChunkLadder(setting) {
    if (setting === BLE_CHUNK_AUTO) {
        const start =
            autoChunkHint && BLE_CHUNK_OPTIONS.includes(autoChunkHint)
                ? autoChunkHint
                : BLE_CHUNK_OPTIONS[0];
        return BLE_CHUNK_OPTIONS.filter((v) => v <= start);
    }
    const fixed = BLE_CHUNK_OPTIONS.includes(setting) ? setting : BLE_CHUNK_OPTIONS[0];
    return [fixed, ...BLE_CHUNK_OPTIONS.filter((v) => v < fixed)];
}

// 把「写分片」选择器挂到串口日志浮层的工具栏，连接前即可快速切换（下次连接生效）。
// 仅在 BLE 传输模式下显示，Web Serial / WebUSB 时隐藏。
let chunkStatusEl = null; // 工具栏上显示“本次连接实际生效分片”的节点
let lastEffectiveChunk = null; // 最近一次生效的分片，浮层重建后用于回填
function updateChunkStatus(size) {
    lastEffectiveChunk = size || null;
    if (!chunkStatusEl) return;
    try {
        chunkStatusEl.textContent = size ? `生效 ${size}B` : '';
    } catch {}
}
addDebugControl(() => {
    if (typeof document === 'undefined') return null;
    const wrap = document.createElement('label');
    wrap.style.cssText = 'display:flex;align-items:center;gap:2px;color:#fff';
    wrap.append('分片');
    const select = document.createElement('select');
    select.style.cssText = 'font:11px monospace;padding:0 2px';
    for (const value of BLE_CHUNK_OPTIONS) {
        const opt = document.createElement('option');
        opt.value = String(value);
        opt.textContent = String(value);
        select.appendChild(opt);
    }
    const autoOpt = document.createElement('option');
    autoOpt.value = BLE_CHUNK_AUTO;
    autoOpt.textContent = '自动';
    select.appendChild(autoOpt);
    select.value = String(getBleChunkSetting());
    select.onchange = () => {
        const raw = select.value;
        const value = raw === BLE_CHUNK_AUTO ? BLE_CHUNK_AUTO : Number(raw);
        setBleChunkSetting(value);
        logWebUsb(
            `BLE 写分片已设为 ${value === BLE_CHUNK_AUTO ? '自动' : `${value}B`}（下次连接生效）`
        );
    };
    wrap.appendChild(select);
    // 本次连接实际生效的分片（连接时和降级时更新）。
    const status = document.createElement('span');
    status.style.cssText = 'opacity:.85';
    status.textContent = lastEffectiveChunk ? `生效 ${lastEffectiveChunk}B` : '';
    wrap.appendChild(status);
    chunkStatusEl = status;
    return wrap;
}, (mode) => mode === 'ble');
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
     * @param {{ chunkSize?: number | 'auto', chip?: string }} [options]
     */
    constructor(device, writeChar, notifyChar, options = {}) {
        this._device = device;
        this._writeChar = writeChar;
        this._notifyChar = notifyChar;
        const chunkSetting = options.chunkSize || getBleChunkSetting();
        this._autoMode = chunkSetting === BLE_CHUNK_AUTO;
        this._chunkLadder = buildChunkLadder(chunkSetting);
        this._chunkIndex = 0;
        this._chunkSize = this._chunkLadder[0];
        updateChunkStatus(this._chunkSize);
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
                    let offset = 0;
                    while (offset < data.length) {
                        if (!this._opened) throw new Error('BLE 已断开');
                        const size = Math.min(this._chunkSize, data.length - offset);
                        const slice = data.subarray(offset, offset + size);
                        this._txCount += 1;
                        if (this._txCount <= MAX_VERBOSE_LOGS || isDebugVerbose()) {
                            logWebUsb(`BLE out#${this._txCount} ${fmtHex(slice)}`);
                        }
                        try {
                            await this._writeChunk(slice);
                            // “自动”模式记住已确认可用的整档分片，重连时直接复用。
                            if (this._autoMode && size === this._chunkSize) {
                                autoChunkHint = this._chunkSize;
                            }
                            offset += size;
                        } catch (error) {
                            // 实际可用负载 = 协商 MTU - 3。大 MTU 时大包更快，但小 MTU/旧版
                            // Chrome 会拒绝超大写入；此处按档位逐级降级（512→256→…→20），
                            // 避免整次传输因一次大包失败而中断。
                            if (this._chunkIndex < this._chunkLadder.length - 1) {
                                this._chunkIndex += 1;
                                this._chunkSize = this._chunkLadder[this._chunkIndex];
                                updateChunkStatus(this._chunkSize);
                                logWebUsb(
                                    `BLE 写入 ${size}B 失败(${error?.name || error})，降为 ${this._chunkSize}B 重试`
                                );
                                continue;
                            }
                            throw error;
                        }
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
