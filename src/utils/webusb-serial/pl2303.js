/**
 * Prolific PL2303 WebUSB chip driver, ported from linux
 * drivers/usb/serial/pl2303.c. Covers common HXA/HXD paths used by
 * cheap programming cables; vendor sequence is best-effort for clones.
 *
 * Control transfers use class + interface (bmRequestType 0x21 / 0xA1).
 */

import { ctrlInXfer, ctrlOutXfer } from './transport.js';

const PL = {
  // Linux: VENDOR_READ_REQUEST_TYPE 0xA1, VENDOR_WRITE_REQUEST_TYPE 0x21
  VENDOR_READ_TYPE: 'class',
  VENDOR_WRITE_TYPE: 'class',
  VENDOR_READ: 0x01,
  VENDOR_WRITE: 0x01,
  SET_LINE: 0x20,
  SET_CONTROL: 0x22,
  CONTROL_DTR: 0x01,
  CONTROL_RTS: 0x02,
};

const filters = [
  { vendorId: 0x067b, productId: 0x2303 },
  { vendorId: 0x067b, productId: 0x23a3 },
  { vendorId: 0x067b, productId: 0xaaa0 },
];

function matchFilter(vid, pid) {
  return filters.some((f) => f.vendorId === vid && f.productId === pid);
}

function encodeLineCoding(baudRate) {
  const buf = new Uint8Array(7);
  const dv = new DataView(buf.buffer);
  const baud = Math.max(75, Math.min(1228800, Math.round(baudRate) || 38400));
  dv.setUint32(0, baud, true); // dwDTERate
  buf[4] = 0; // bCharFormat: 1 stop bit
  buf[5] = 0; // bParityType: none
  buf[6] = 8; // bDataBits
  return { buf, baud };
}

async function vendorWrite(device, value, index) {
  await ctrlOutXfer(
    device,
    PL.VENDOR_WRITE_TYPE,
    'interface',
    PL.VENDOR_WRITE,
    value & 0xffff,
    index & 0xffff
  );
}

async function vendorRead(device, index, length = 1) {
  return ctrlInXfer(
    device,
    PL.VENDOR_READ_TYPE,
    'interface',
    PL.VENDOR_READ,
    0,
    index & 0xffff,
    length
  );
}

async function setLineCoding(device, buf) {
  await ctrlOutXfer(device, 'class', 'interface', PL.SET_LINE, 0, 0, buf);
}

async function setControl(device, lines) {
  await ctrlOutXfer(device, 'class', 'interface', PL.SET_CONTROL, lines, 0);
}

/**
 * Linux-style type-A/HXD bring-up. Failures on counterfeit chips are
 * swallowed so SET_LINE can still try the standard path.
 */
async function vendorInit(device, version0) {
  try {
    await vendorRead(device, 0x8484, 1);
    await vendorWrite(device, 0x0000, 0x0404);
    await vendorRead(device, 0x8484, 1);
    await vendorRead(device, 0x8383, 1);
    await vendorRead(device, 0x8484, 1);
    await vendorWrite(device, 0x0001, 0x0404);
    await vendorRead(device, 0x8484, 1);
    await vendorRead(device, 0x8383, 1);
  } catch {
    // Clones may reject vendor registers.
  }

  try {
    if (version0 !== null && version0 !== undefined) {
      const divisor = Math.max(1, Math.floor(12000000 / 38400));
      await vendorWrite(device, divisor & 0xff, 0x0000);
      await vendorWrite(device, (divisor >> 8) & 0xff, 0x0001);
    }
  } catch {}
}

const pl2303 = {
  name: 'PL2303',
  filters,

  matches(vid, pid) {
    return matchFilter(vid, pid);
  },

  async configure(device, _eps, baudRate) {
    let version0 = null;
    try {
      const ver = await vendorRead(device, 0x8484, 1);
      version0 = ver[0];
    } catch {}

    await vendorInit(device, version0);

    const { buf, baud } = encodeLineCoding(baudRate);
    try {
      await setLineCoding(device, buf);
    } catch (e) {
      throw new Error(`PL2303 SET_LINE failed: ${e && e.message ? e.message : e}`);
    }

    await setControl(device, PL.CONTROL_DTR | PL.CONTROL_RTS);

    return { version0, baud };
  },

  async setSignals(device, _eps, signals) {
    const v =
      (signals.dataTerminalReady ? PL.CONTROL_DTR : 0) |
      (signals.requestToSend ? PL.CONTROL_RTS : 0);
    await setControl(device, v);
  },

  async getSignals() {
    // PL2303 modem status is often unreliable across clones; report neutral.
    return {
      clearToSend: false,
      dataSetReady: false,
      dataCarrierDetect: false,
      ringIndicator: false,
    };
  },

  async beforeClose(device) {
    try {
      await setControl(device, 0);
    } catch {}
  },
};

export default pl2303;
