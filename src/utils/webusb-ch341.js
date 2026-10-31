/**
 * CH340/CH341 WebUSB serial port, ported from linux drivers/usb/serial/ch341.c.
 * Exposes a SerialPort-compatible surface so src/utils/serial.js can use it
 * on Android Chrome.
 *
 * 安卓策略：只要浏览器提供 WebUSB，就一律直接走这里，不再先尝试原生 Web Serial
 * （安卓上 Web Serial 驱动不了 CH340，而且先弹出串口选择框会消耗 user gesture，
 * 导致随后的 requestDevice() 抛 SecurityError）。桌面仍优先原生 Web Serial。
 * 详见 README「安卓 WebUSB（实验性）」。
 *
 * EXPERIMENTAL: Android WebUSB path. Not all phones/ROMs can claim CH340
 * (kernel ch341 may already own the interface). See README「平台支持」.
 */

import { logWebUsb, fmtHex } from './serial-log.js';

const CH341 = {
  REQ_READ_VERSION: 0x5f,
  REQ_WRITE_REG: 0x9a,
  REQ_READ_REG: 0x95,
  REQ_SERIAL_INIT: 0xa1,
  REQ_MODEM_CTRL: 0xa4,
  REG_PRESCALER: 0x12,
  REG_DIVISOR: 0x13,
  REG_LCR: 0x18,
  REG_LCR2: 0x25,
  REG_FLOW_CTL: 0x27,
  LCR_ENABLE_RX: 0x80,
  LCR_ENABLE_TX: 0x40,
  LCR_CS8: 0x03,
  BIT_RTS: 1 << 6,
  BIT_DTR: 1 << 5,
  BITS_MODEM_STAT: 0x0f,
  CLKRATE: 48000000,
};

// divisor 寄存器 bit 7：关闭 CH340/CH341 内部“攒满一个端点包才转发”的行为。
// Linux ch341.c 只在 version > 0x27 时置位，并注明“至少有一个 0x27 设备这个位是反的”。
// 这里按实测可用的实现无条件置位；若遇到 0x27 设备握手仍然超时，先排查这一位。
const DIVISOR_DISABLE_PACKET_BUFFERING = 1 << 7;

const SUPPORTED_USB = [
  { vendorId: 0x1a86, productId: 0x7523 },
  { vendorId: 0x1a86, productId: 0x7522 },
  { vendorId: 0x1a86, productId: 0x5523 },
  { vendorId: 0x4348, productId: 0x5523 },
  { vendorId: 0x2184, productId: 0x0057 },
  { vendorId: 0x9986, productId: 0x7523 },
];

function clkDiv(ps, fact) {
  return 1 << (12 - 3 * ps - fact);
}

function minRate(ps) {
  return CH341.CLKRATE / (clkDiv(ps, 1) * 512);
}

function ch341GetDivisor(speed) {
  const minBps = Math.ceil(CH341.CLKRATE / (clkDiv(0, 0) * 256));
  const maxBps = CH341.CLKRATE / (clkDiv(3, 0) * 2);
  speed = Math.min(Math.max(speed, minBps), maxBps);

  let fact = 1;
  let ps;
  for (ps = 3; ps >= 0; ps--) {
    if (speed > minRate(ps)) break;
  }
  if (ps < 0) throw new Error('Unsupported baud rate');

  let cdiv = clkDiv(ps, fact);
  let div = Math.floor(CH341.CLKRATE / (cdiv * speed));
  if (div < 9 || div > 255) {
    div = Math.floor(div / 2);
    cdiv *= 2;
    fact = 0;
  }
  if (div < 2) throw new Error('Unsupported baud rate');

  const left = (16 * CH341.CLKRATE) / (cdiv * div) - 16 * speed;
  const right = 16 * speed - (16 * CH341.CLKRATE) / (cdiv * (div + 1));
  if (left >= right) div++;
  if (fact === 1 && div % 2 === 0) {
    div = Math.floor(div / 2);
    fact = 0;
  }
  return ((0x100 - div) << 8) | (fact << 2) | ps;
}

function lcr8n1() {
  return CH341.LCR_ENABLE_RX | CH341.LCR_ENABLE_TX | CH341.LCR_CS8;
}

async function ctrlOut(dev, request, value, index, data) {
  const setup = {
    requestType: 'vendor',
    recipient: 'device',
    request,
    value,
    index,
  };
  const res = data
    ? await dev.controlTransferOut(setup, data)
    : await dev.controlTransferOut(setup);
  if (res.status !== 'ok') {
    logWebUsb(`controlOut 0x${request.toString(16)} status=${res.status}`);
    throw new Error(`USB control OUT 0x${request.toString(16)} failed: ${res.status}`);
  }
  logWebUsb(`controlOut 0x${request.toString(16)} ok`);
}

async function ctrlIn(dev, request, value, index, length) {
  const res = await dev.controlTransferIn(
    {
      requestType: 'vendor',
      recipient: 'device',
      request,
      value,
      index,
    },
    length
  );
  if (res.status !== 'ok') {
    logWebUsb(`controlIn 0x${request.toString(16)} status=${res.status}`);
    throw new Error(`USB control IN 0x${request.toString(16)} failed: ${res.status}`);
  }
  const out = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  logWebUsb(`controlIn 0x${request.toString(16)} ${fmtHex(out, 8)}`);
  return out;
}

function parseEndpoints(dev) {
  const cfg = dev.configuration;
  if (!cfg) throw new Error('USB configuration missing');

  let ifaceNum = null;
  let alt = null;
  for (const iface of cfg.interfaces) {
    for (const a of iface.alternates) {
      if (a.interfaceClass === 0xff || a.interfaceClass === 2) {
        ifaceNum = iface.interfaceNumber;
        alt = a;
        break;
      }
    }
    if (ifaceNum !== null) break;
  }
  if (ifaceNum === null) {
    ifaceNum = cfg.interfaces[0].interfaceNumber;
    alt = cfg.interfaces[0].alternates[0];
  }

  let epIn = null;
  let epOut = null;
  for (const ep of alt.endpoints) {
    if (ep.type === 'bulk' && ep.direction === 'in') epIn = ep;
    else if (ep.type === 'bulk' && ep.direction === 'out') epOut = ep;
  }
  if (!epIn || !epOut) throw new Error('USB bulk endpoints missing');

  return {
    ifaceNum,
    epIn: epIn.endpointNumber,
    epOut: epOut.endpointNumber,
    epInSize: epIn.packetSize || 32,
    epOutSize: epOut.packetSize || 32,
  };
}

async function ch341Configure(dev, baudRate) {
  const verBuf = await ctrlIn(dev, CH341.REQ_READ_VERSION, 0, 0, 2);
  const version = verBuf[0];

  await ctrlOut(dev, CH341.REQ_SERIAL_INIT, 0, 0);

  let val = ch341GetDivisor(baudRate);
  // 对齐实测可用的实现（以及 uvstudio 已验证的版本）：无条件置位 bit 7。
  // 该位用于关闭 CH340/CH341 内部“攒满一个端点包才转发”的行为；不置位时短包
  // （K5 握手报文只有 20 多字节）可能一直卡在芯片里，读侧永远超时。
  //
  // 注意与 Linux 的差异：ch341.c 写的是 `if (version > 0x27) val |= BIT(7);`，
  // 并注明“至少有一个 version 0x27 的设备这个位是反的”。常见 CH340 上报的正是
  // 0x27，所以这里不再按版本号判断；如果遇到 0x27 设备握手仍然超时，先检查这一位。
  val |= DIVISOR_DISABLE_PACKET_BUFFERING;
  await ctrlOut(
    dev,
    CH341.REQ_WRITE_REG,
    (CH341.REG_DIVISOR << 8) | CH341.REG_PRESCALER,
    val
  );
  if (version >= 0x30) {
    await ctrlOut(
      dev,
      CH341.REQ_WRITE_REG,
      (CH341.REG_LCR2 << 8) | CH341.REG_LCR,
      lcr8n1()
    );
  }

  const mcr = CH341.BIT_DTR | CH341.BIT_RTS;
  // Linux 传的是 u8 取反后的 wValue（0xff9f），高字节也保持一致，避免某些克隆芯片
  // 把高位当成有效状态位。
  await ctrlOut(dev, CH341.REQ_MODEM_CTRL, ~mcr & 0xffff, 0);
  await ctrlOut(
    dev,
    CH341.REQ_WRITE_REG,
    (CH341.REG_FLOW_CTL << 8) | CH341.REG_FLOW_CTL,
    0x0000
  );

  // 读一下 Modem 状态寄存器做连通性检查，但只是诊断用途：部分克隆芯片不支持该
  // 读数（stall），不应因此让整次连接失败。
  try {
    await ctrlIn(dev, CH341.REQ_READ_REG, 0x0706, 0, 2);
  } catch (e) {
    logWebUsb(`读 MSR 失败（忽略）: ${e && e.message}`);
  }

  return version;
}

class WebUsbCh341Port {
  constructor(device, eps, version) {
    this._device = device;
    this._iface = eps.ifaceNum;
    this._epIn = eps.epIn;
    this._epOut = eps.epOut;
    this._epInSize = eps.epInSize;
    this._epOutSize = eps.epOutSize;
    this._version = version;
    this._opened = true;
    this._rxQueue = [];
    this._rxWaiter = null;
    this._readable = null;
    this._readController = null;
    this._writable = null;
    this._controlChain = Promise.resolve();
    this._transferInCount = 0;
    this._transferOutCount = 0;
    // 读循环异常退出（设备掉线、端点反复 stall）后置位：后续 readable 直接返回 null，
    // 让上层立刻失败，而不是每次读都等满超时。
    this._readFailed = false;
    this._readError = null;
    this.chip = 'CH341';
    logWebUsb(`open: CH341 version=0x${version.toString(16)} iface=${eps.ifaceNum} epIn=${eps.epIn} epOut=${eps.epOut}`);
    this._readLoop();
  }

  get connected() {
    return this._opened;
  }

  get readable() {
    if (!this._opened || this._readFailed) return null;
    if (!this._readable) {
      this._readable = new ReadableStream({
        start: (controller) => {
          this._readController = controller;
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
          // 不要清空 _rxQueue：队列里的字节还没交给上层 reader，丢掉会让下一次读取
          // 从半帧中间开始（K5 协议会因此错位）。只唤醒挂起的 pull。
          if (this._rxWaiter) {
            this._rxWaiter.resolve();
            this._rxWaiter = null;
          }
          this._readController = null;
          this._readable = null;
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
          const data =
            chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
          let offset = 0;
          while (offset < data.length) {
            const slice = data.subarray(offset, offset + this._epOutSize);
            this._transferOutCount += 1;
            const res = await this._device.transferOut(this._epOut, slice);
            if (res.status !== 'ok') {
              logWebUsb(`transferOut#${this._transferOutCount} 失败 status=${res.status}`);
              throw new Error(`USB bulk OUT failed: ${res.status}`);
            }
            logWebUsb(`transferOut#${this._transferOutCount} ${fmtHex(slice)}`);
            offset += slice.length;
          }
          // Full-size final bulk packet stays buffered on CH340 until a short/ZLP arrives.
          if (data.length > 0 && data.length % this._epOutSize === 0) {
            this._transferOutCount += 1;
            let zlp = null;
            try {
              zlp = await this._device.transferOut(this._epOut, new Uint8Array(0));
            } catch (e) {
              // 某些 Chrome 版本直接拒绝空 transferOut（抛 TypeError/NotSupportedError）。
              // 这是 API 限制而不是 USB 传输失败，数据已经写出去了，不能因此判整帧失败。
              logWebUsb(`transferOut#${this._transferOutCount} ZLP 被拒绝（忽略）: ${e && e.message}`);
              console.warn('WebUSB ZLP rejected by browser; tail may stay buffered:', e);
            }
            // 真正发起了传输却返回非 ok，说明 USB 层失败：最后一段数据很可能仍留在
            // 芯片缓冲里。必须抛错，否则上层只会在等 ACK 时超时，看不到根因。
            if (zlp && zlp.status !== 'ok') {
              logWebUsb(`transferOut#${this._transferOutCount} ZLP 失败 status=${zlp.status}`);
              throw new Error(`USB bulk OUT ZLP failed: ${zlp.status}`);
            }
          }
        },
      });
    }
    return this._writable;
  }

  getInfo() {
    return {
      usbVendorId: this._device.vendorId,
      usbProductId: this._device.productId,
    };
  }

  async setSignals(signals) {
    // Best-effort DTR/RTS; CH341 handshake uses ~mcr
    await this._control(async () => {
      const mcr =
        (signals.dataTerminalReady ? CH341.BIT_DTR : 0) |
        (signals.requestToSend ? CH341.BIT_RTS : 0);
      await ctrlOut(this._device, CH341.REQ_MODEM_CTRL, ~mcr & 0xffff, 0);
    });
  }

  async getSignals() {
    return this._control(async () => {
      const st = await ctrlIn(this._device, CH341.REQ_READ_REG, 0x0706, 0, 2);
      const msr = ~st[0] & CH341.BITS_MODEM_STAT;
      return {
        clearToSend: !!(msr & 0x01),
        dataSetReady: !!(msr & 0x02),
        dataCarrierDetect: !!(msr & 0x08),
        ringIndicator: !!(msr & 0x04),
      };
    });
  }

  async close() {
    if (!this._opened) return;
    logWebUsb('close()');
    this._opened = false;
    try {
      if (this._readable) {
        try {
          await this._readable.cancel();
        } catch {}
        this._readable = null;
      }
      this._readController = null;
      if (this._writable) {
        try {
          await this._writable.abort();
        } catch {}
        this._writable = null;
      }
      try {
        await ctrlOut(this._device, CH341.REQ_MODEM_CTRL, 0xffff, 0);
      } catch {}
      try {
        await this._device.releaseInterface(this._iface);
      } catch {}
      try {
        await this._device.close();
      } catch {}
    } catch (e) {
      console.warn('WebUSB close error', e);
    }
  }

  _control(fn) {
    const run = this._controlChain.then(fn, fn);
    this._controlChain = run.then(
      () => {},
      () => {}
    );
    return run;
  }

  _enqueue(bytes) {
    if (this._rxWaiter) {
      const { controller, resolve } = this._rxWaiter;
      this._rxWaiter = null;
      controller.enqueue(bytes);
      resolve();
      return;
    }
    this._rxQueue.push(bytes);
  }

  // 读循环意外停止时调用：标记端口不可再读，并让当前挂起的 read() 立刻以错误结束。
  // 注意不能把 _opened 置 false，否则 serial.js 的 disconnect() 会因为
  // (port.readable || port.connected) 为假而跳过 close()，留下未释放的 USB 设备。
  _markReadFailed(error) {
    if (this._readFailed) return;
    this._readFailed = true;
    this._readError = error;
    logWebUsb(`读循环已终止: ${error && error.message}`);
    console.warn('WebUSB read loop stopped:', error);
    // 直接把流置为 errored，这样即使当前没有挂起的 read()，下一次 read() 也会立即失败。
    if (this._readController) {
      try { this._readController.error(error); } catch {}
    }
    if (this._rxWaiter) {
      const { resolve } = this._rxWaiter;
      this._rxWaiter = null;
      try { resolve(); } catch {}
    }
  }

  async _readLoop() {
    logWebUsb('读循环已启动');
    let stallRetries = 0;
    while (this._opened && this._device.opened) {
      try {
        const res = await this._device.transferIn(this._epIn, this._epInSize);
        if (!this._opened) break;
        this._transferInCount += 1;
        if (res.status === 'stall') {
          // endpoint halt：必须 clearHalt 才能继续，否则这里会变成忙等死循环。
          logWebUsb(`transferIn#${this._transferInCount} stall，clearHalt`);
          try {
            await this._device.clearHalt('in', this._epIn);
          } catch (e) {
            logWebUsb(`clearHalt 失败: ${e && e.message}`);
            this._readError = e;
            break;
          }
          stallRetries += 1;
          if (stallRetries > 8) {
            this._readError = new Error('WebUSB IN endpoint keeps stalling');
            break;
          }
          continue;
        }
        if (res.status !== 'ok') {
          logWebUsb(`transferIn#${this._transferInCount} status=${res.status}`);
          // 短暂的协议错误可以继续，连续失败就退出，避免空转。
          if (++stallRetries > 8) {
            this._readError = new Error(`WebUSB transferIn keeps failing (status=${res.status})`);
            break;
          }
          continue;
        }
        stallRetries = 0;
        if (res.data && res.data.byteLength) {
          const bytes = new Uint8Array(
            res.data.buffer,
            res.data.byteOffset,
            res.data.byteLength
          );
          const chunk = bytes.slice();
          // 只记录前若干次，避免日志淹没。
          if (this._transferInCount <= 60) {
            logWebUsb(`transferIn#${this._transferInCount} ${fmtHex(chunk)}`);
          }
          this._enqueue(chunk);
        }
      } catch (e) {
        if (this._opened) {
          logWebUsb(`transferIn 错误: ${e && e.name} ${e && e.message}`);
          console.warn('WebUSB bulk IN error', e);
          this._readError = e;
        }
        break;
      }
    }
    // 正常 close() 会把 _opened 置 false，此时不需要额外处理。
    if (this._opened) {
      this._markReadFailed(
        this._readError ||
          new Error('WebUSB read loop stopped (device disconnected or endpoint unavailable)')
      );
    }
  }
}

export function hasWebUsbSupport() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/**
 * Request a CH340/CH341 device and open it.
 * @param {number} baudRate
 * @returns {Promise<WebUsbCh341Port>}
 */
export async function requestWebUsbCh341Port(baudRate = 38400) {
  if (!hasWebUsbSupport()) {
    throw new Error('WebUSB is not available');
  }

  logWebUsb(`requestWebUsbCh341Port baud=${baudRate} isSecureContext=${typeof isSecureContext !== 'undefined' ? isSecureContext : 'n/a'}`);

  let device;
  try {
    device = await navigator.usb.requestDevice({ filters: SUPPORTED_USB });
  } catch (e) {
    logWebUsb(`requestDevice 失败: ${e && e.name} ${e && e.message}`);
    throw e;
  }
  logWebUsb(`requestDevice ok vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)}`);
  // 某些安卓 Chrome / polyfill 的 USBDevice 没有 EventTarget 接口，不能直接 addEventListener。
  try {
    if (typeof device.addEventListener === 'function') {
      device.addEventListener('disconnect', () => {
        logWebUsb('device disconnect 事件');
      });
    } else if (navigator.usb && typeof navigator.usb.addEventListener === 'function') {
      navigator.usb.addEventListener('disconnect', (event) => {
        if (event && event.device === device) {
          logWebUsb('device disconnect 事件');
        }
      });
    }
  } catch {}
  await device.open();
  if (device.configuration === null) {
    await device.selectConfiguration(1);
  }

  const eps = parseEndpoints(device);
  try {
    await device.claimInterface(eps.ifaceNum);
    logWebUsb(`claimInterface(${eps.ifaceNum}) ok`);
  } catch (e) {
    logWebUsb(`claimInterface(${eps.ifaceNum}) 失败: ${e && e.name} ${e && e.message}`);
    try {
      await device.close();
    } catch {}
    const err = new Error(
      'USB interface is claimed by the system driver (kernel ch341). WebUSB cannot use this device on this phone.'
    );
    err.cause = e;
    throw err;
  }

  try {
    const version = await ch341Configure(device, baudRate);
    logWebUsb(`CH341 初始化完成 version=0x${version.toString(16)} baud=${baudRate}`);
    return new WebUsbCh341Port(device, eps, version);
  } catch (e) {
    logWebUsb(`CH341 初始化失败: ${e && e.name} ${e && e.message}`);
    try {
      await device.releaseInterface(eps.ifaceNum);
    } catch {}
    try {
      await device.close();
    } catch {}
    throw e;
  }
}
