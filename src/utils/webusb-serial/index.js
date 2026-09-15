/**
 * Multi-chip WebUSB serial entry.
 * Dispatches by VID/PID after navigator.usb.requestDevice().
 */

import { logWebUsb } from '../serial-log.js';
import {
  hasWebUsbSupport,
  attachDisconnectLogger,
  claimBulkInterface,
  releaseAndClose,
  WebUsbSerialPort,
} from './transport.js';
import ch341 from './ch341.js';
import cp210x from './cp210x.js';
import pl2303 from './pl2303.js';
import ftdi from './ftdi.js';

export { hasWebUsbSupport };

const drivers = [ch341, cp210x, pl2303, ftdi];

export function supportedUsbFilters() {
  const out = [];
  const seen = new Set();
  for (const d of drivers) {
    for (const f of d.filters) {
      const key = `${f.vendorId}:${f.productId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ vendorId: f.vendorId, productId: f.productId });
    }
  }
  return out;
}

export function pickDriver(vid, pid) {
  for (const d of drivers) {
    if (typeof d.matches === 'function' ? d.matches(vid, pid) : false) return d;
  }
  // Fallback: filter table
  for (const d of drivers) {
    if (d.filters.some((f) => f.vendorId === vid && f.productId === pid)) return d;
  }
  return null;
}

/**
 * Request any supported USB-serial cable and open a SerialPort-compatible port.
 * @param {number} [baudRate=38400]
 * @returns {Promise<WebUsbSerialPort>}
 */
export async function requestWebUsbSerialPort(baudRate = 38400) {
  if (!hasWebUsbSupport()) {
    throw new Error('WebUSB is not available');
  }

  logWebUsb(
    `requestWebUsbSerialPort baud=${baudRate} isSecureContext=${typeof isSecureContext !== 'undefined' ? isSecureContext : 'n/a'}`
  );

  let device;
  try {
    device = await navigator.usb.requestDevice({ filters: supportedUsbFilters() });
  } catch (e) {
    logWebUsb(`requestDevice 失败: ${e && e.name} ${e && e.message}`);
    throw e;
  }

  logWebUsb(
    `requestDevice ok vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)}`
  );
  attachDisconnectLogger(device);

  const driver = pickDriver(device.vendorId, device.productId);
  if (!driver) {
    try {
      await device.close();
    } catch {}
    const err = new Error(
      `Unsupported USB serial chip (vid=0x${device.vendorId.toString(16)} pid=0x${device.productId.toString(16)})`
    );
    throw err;
  }

  let eps;
  try {
    eps = await claimBulkInterface(device);
  } catch (e) {
    throw e;
  }

  try {
    const meta = (await driver.configure(device, eps, baudRate)) || {};
    logWebUsb(`${driver.name} 初始化完成 baud=${baudRate} meta=${JSON.stringify(meta)}`);
    return new WebUsbSerialPort(device, eps, {
      chip: driver.name,
      meta,
      transformRx: driver.transformRx || null,
      setSignals: driver.setSignals ? (dev, e, s) => driver.setSignals(dev, e, s) : null,
      getSignals: driver.getSignals ? (dev, e) => driver.getSignals(dev, e) : null,
      beforeClose: driver.beforeClose ? (dev, e) => driver.beforeClose(dev, e) : null,
      sendZlp: driver.name === 'CH341',
    });
  } catch (e) {
    logWebUsb(`${driver.name} 初始化失败: ${e && e.name} ${e && e.message}`);
    await releaseAndClose(device, eps);
    throw e;
  }
}

export { WebUsbSerialPort };
