/**
 * Shared WebUSB serial transport.
 * Chip drivers supply filters + configure/signal hooks; this module owns
 * open/claim/bulk streams and a SerialPort-compatible surface.
 *
 * 安卓策略：只要浏览器提供 WebUSB，就一律直接走这里，不再先尝试原生 Web Serial
 * （安卓上 Web Serial 驱动不了 CH340 这类厂商自定义设备，而且先弹出串口选择框会
 * 消耗 user gesture，导致随后的 requestDevice() 抛 SecurityError）。桌面仍优先
 * 原生 Web Serial。详见 README「安卓 WebUSB（实验性）」。
 *
 * EXPERIMENTAL: Android WebUSB path. Not all phones/ROMs can claim the interface
 * (kernel driver may already own it). See README「平台支持」.
 */

import { logWebUsb, fmtHex } from '../serial-log.js';

export function hasWebUsbSupport() {
  return typeof navigator !== 'undefined' && 'usb' in navigator;
}

/**
 * Vendor control OUT. Default matches CH341 (vendor + device).
 * CP210x uses vendor + interface.
 */
export async function ctrlOut(dev, request, value, index, data, opts = {}) {
  const setup = {
    requestType: opts.requestType || 'vendor',
    recipient: opts.recipient || 'device',
    request,
    value,
    index,
  };
  const res = data
    ? await dev.controlTransferOut(setup, data)
    : await dev.controlTransferOut(setup);
  if (res.status !== 'ok') {
    logWebUsb(
      `controlOut req=0x${request.toString(16)} ${setup.requestType}/${setup.recipient} status=${res.status}`
    );
    throw new Error(`USB control OUT 0x${request.toString(16)} failed: ${res.status}`);
  }
  logWebUsb(`controlOut req=0x${request.toString(16)} ${setup.requestType}/${setup.recipient} ok`);
}

/**
 * Vendor control IN. Default matches CH341 (vendor + device).
 */
export async function ctrlIn(dev, request, value, index, length, opts = {}) {
  const res = await dev.controlTransferIn(
    {
      requestType: opts.requestType || 'vendor',
      recipient: opts.recipient || 'device',
      request,
      value,
      index,
    },
    length
  );
  if (res.status !== 'ok') {
    logWebUsb(
      `controlIn req=0x${request.toString(16)} ${opts.requestType || 'vendor'}/${opts.recipient || 'device'} status=${res.status}`
    );
    throw new Error(`USB control IN 0x${request.toString(16)} failed: ${res.status}`);
  }
  const out = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  logWebUsb(
    `controlIn req=0x${request.toString(16)} ${opts.requestType || 'vendor'}/${opts.recipient || 'device'} ${fmtHex(out, 8)}`
  );
  return out;
}

/** Explicit requestType (class/vendor) + recipient control OUT (PL2303). */
export async function ctrlOutXfer(dev, requestType, recipient, request, value, index, data) {
  const setup = { requestType, recipient, request, value, index };
  const res = data
    ? await dev.controlTransferOut(setup, data)
    : await dev.controlTransferOut(setup);
  if (res.status !== 'ok') {
    logWebUsb(
      `controlOutXfer type=0x${requestType.toString(16)} recip=${recipient} req=0x${request.toString(16)} status=${res.status}`
    );
    throw new Error(
      `USB control OUT type=0x${requestType.toString(16)} req=0x${request.toString(16)} failed: ${res.status}`
    );
  }
  logWebUsb(
    `controlOutXfer type=0x${requestType.toString(16)} recip=${recipient} req=0x${request.toString(16)} ok`
  );
}

export async function ctrlInXfer(dev, requestType, recipient, request, value, index, length) {
  const res = await dev.controlTransferIn(
    { requestType, recipient, request, value, index },
    length
  );
  if (res.status !== 'ok') {
    logWebUsb(
      `controlInXfer type=0x${requestType.toString(16)} recip=${recipient} req=0x${request.toString(16)} status=${res.status}`
    );
    throw new Error(
      `USB control IN type=0x${requestType.toString(16)} req=0x${request.toString(16)} failed: ${res.status}`
    );
  }
  const out = new Uint8Array(res.data.buffer, res.data.byteOffset, res.data.byteLength);
  logWebUsb(
    `controlInXfer type=0x${requestType.toString(16)} recip=${recipient} req=0x${request.toString(16)} ${fmtHex(out, 8)}`
  );
  return out;
}

export function parseEndpoints(dev) {
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

export class WebUsbSerialPort {
  /**
   * @param {USBDevice} device
   * @param {ReturnType<typeof parseEndpoints>} eps
   * @param {{
   *   chip: string,
   *   meta?: object,
   *   transformRx?: ((bytes: Uint8Array) => Uint8Array | null) | null,
   *   setSignals?: (device: USBDevice, eps: object, signals: object) => Promise<void>,
   *   getSignals?: (device: USBDevice, eps: object) => Promise<object>,
   *   beforeClose?: (device: USBDevice, eps: object) => Promise<void>,
   *   sendZlp?: boolean,
   * }} options
   */
  constructor(device, eps, options) {
    this._device = device;
    this._iface = eps.ifaceNum;
    this._epIn = eps.epIn;
    this._epOut = eps.epOut;
    this._epInSize = eps.epInSize;
    this._epOutSize = eps.epOutSize;
    this._eps = eps;
    this._options = options || {};
    this.chip = this._options.chip || 'USB-serial';
    this._meta = this._options.meta || null;
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
    logWebUsb(
      `open: ${this.chip} iface=${eps.ifaceNum} epIn=${eps.epIn} epOut=${eps.epOut} meta=${JSON.stringify(this._meta || {})}`
    );
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
          const data = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
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
          // CH340 holds a full-size final bulk packet until a short/ZLP arrives.
          if (
            this._options.sendZlp &&
            data.length > 0 &&
            data.length % this._epOutSize === 0
          ) {
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
    if (typeof this._options.setSignals !== 'function') return;
    await this._control(async () => {
      await this._options.setSignals(this._device, this._eps, signals);
    });
  }

  async getSignals() {
    if (typeof this._options.getSignals !== 'function') {
      return {
        clearToSend: false,
        dataSetReady: false,
        dataCarrierDetect: false,
        ringIndicator: false,
      };
    }
    return this._control(async () => this._options.getSignals(this._device, this._eps));
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
      if (typeof this._options.beforeClose === 'function') {
        try {
          await this._options.beforeClose(this._device, this._eps);
        } catch {}
      }
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
          let bytes = new Uint8Array(
            res.data.buffer,
            res.data.byteOffset,
            res.data.byteLength
          );
          if (typeof this._options.transformRx === 'function') {
            bytes = this._options.transformRx(bytes);
            if (!bytes || !bytes.length) continue;
          }
          const chunk = bytes.slice();
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

export function attachDisconnectLogger(device) {
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
}

/**
 * Claim bulk interface and return endpoints.
 * @param {USBDevice} device
 */
export async function claimBulkInterface(device) {
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
      'USB interface is claimed by the system driver. WebUSB cannot use this device on this phone.'
    );
    err.cause = e;
    throw err;
  }
  return eps;
}

export async function releaseAndClose(device, eps) {
  try {
    if (eps && eps.ifaceNum != null) {
      await device.releaseInterface(eps.ifaceNum);
    }
  } catch {}
  try {
    await device.close();
  } catch {}
}
