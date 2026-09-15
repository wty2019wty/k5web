/**
 * Shared WebUSB serial transport.
 * Chip drivers supply filters + configure/signal hooks; this module owns
 * open/claim/bulk streams and a SerialPort-compatible surface.
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
    this._writable = null;
    this._controlChain = Promise.resolve();
    this._transferInCount = 0;
    this._transferOutCount = 0;
    logWebUsb(
      `open: ${this.chip} iface=${eps.ifaceNum} epIn=${eps.epIn} epOut=${eps.epOut} meta=${JSON.stringify(this._meta || {})}`
    );
    this._readLoop();
  }

  get connected() {
    return this._opened;
  }

  get readable() {
    if (!this._opened) return null;
    if (!this._readable) {
      this._readable = new ReadableStream({
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
          if (this._rxWaiter) {
            this._rxWaiter.resolve();
            this._rxWaiter = null;
          }
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
            const zlp = await this._device.transferOut(this._epOut, new Uint8Array(0));
            if (zlp.status !== 'ok') {
              logWebUsb(`transferOut#${this._transferOutCount} ZLP failed status=${zlp.status}`);
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

  async _readLoop() {
    logWebUsb('读循环已启动');
    while (this._opened && this._device.opened) {
      try {
        const res = await this._device.transferIn(this._epIn, this._epInSize);
        if (!this._opened) break;
        this._transferInCount += 1;
        if (res.status !== 'ok') {
          logWebUsb(`transferIn#${this._transferInCount} status=${res.status}`);
          continue;
        }
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
        }
        break;
      }
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
