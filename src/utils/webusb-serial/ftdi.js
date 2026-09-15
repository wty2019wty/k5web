/**
 * FTDI FT232R / FT231X WebUSB driver, ported from linux
 * drivers/usb/serial/ftdi_sio.c (single-port / first-channel subset).
 *
 * Every bulk IN packet is prefixed with 2 modem-status bytes on these
 * chips; transformRx strips them.
 */

import { ctrlIn, ctrlOut } from './transport.js';

const FTDI = {
  RESET: 0x00,
  MODEM_CTRL: 0x01,
  SET_FLOW_CTRL: 0x02,
  SET_BAUD_RATE: 0x03,
  SET_DATA: 0x04,
  GET_MODEM_STATUS: 0x05,
  SET_LATENCY_TIMER: 0x09,
  RESET_SIO: 0x0000,
  // 8 data bits, no parity, 1 stop
  LINE_8N1: 0x0008,
  // MODEM_CTRL: low byte = level, high byte = mask of bits to change
  DTR_HIGH: 0x0101,
  DTR_LOW: 0x0100,
  RTS_HIGH: 0x0202,
  RTS_LOW: 0x0200,
  // GET_MODEM_STATUS byte0
  CTS: 0x10,
  DSR: 0x20,
  RI: 0x40,
  RLSD: 0x80,
  STATUS_BYTES: 2,
};

const filters = [
  { vendorId: 0x0403, productId: 0x6001 }, // FT232R
  { vendorId: 0x0403, productId: 0x6015 }, // FT231X / FT230X
];

function matchFilter(vid, pid) {
  return filters.some((f) => f.vendorId === vid && f.productId === pid);
}

/**
 * FT232BM/R/X baud → encoded divisor.
 * Mirrors linux ftdi_232bm_baud_base_to_divisor() with base clock 3 MHz.
 * Result is split into wValue (low 16) / wIndex (high 16).
 */
function encodeBaudDivisor(baud) {
  const base = 3000000;
  const divfrac = [0, 3, 2, 4, 1, 5, 6, 7];
  if (baud > 3000000) baud = 3000000;
  if (baud < 1200) baud = 1200;

  let divisor3 = Math.trunc((base * 8) / baud);
  if ((divisor3 & 7) === 7) {
    divisor3 = Math.trunc(divisor3 / 8) * 8 + 8;
  } else {
    divisor3 = divisor3 - (divisor3 & 7);
  }
  if (divisor3 < 8) divisor3 = 8;

  let encoded = (divisor3 >> 3) | (divfrac[divisor3 & 7] << 14);
  if (encoded === 1) encoded = 0;
  else if (encoded === 0x4001) encoded = 1;

  return {
    value: encoded & 0xffff,
    index: (encoded >> 16) & 0xffff,
  };
}

const ftdi = {
  name: 'FTDI',
  filters,

  matches(vid, pid) {
    return matchFilter(vid, pid);
  },

  /** Strip the 2-byte modem status prefix FTDI prepends on bulk IN. */
  transformRx(bytes) {
    if (!bytes || bytes.length <= FTDI.STATUS_BYTES) return null;
    return bytes.subarray(FTDI.STATUS_BYTES);
  },

  async configure(device, eps, baudRate) {
    const iface = eps?.ifaceNum ?? 0;

    await ctrlOut(device, FTDI.RESET, FTDI.RESET_SIO, iface);

    const baud = Math.max(1200, Math.min(3000000, Math.round(baudRate) || 38400));
    const div = encodeBaudDivisor(baud);
    await ctrlOut(device, FTDI.SET_BAUD_RATE, div.value, div.index);

    await ctrlOut(device, FTDI.SET_DATA, FTDI.LINE_8N1, iface);

    // Lower latency timer so short K5 frames are not batched for 16 ms.
    try {
      await ctrlOut(device, FTDI.SET_LATENCY_TIMER, 1, iface);
    } catch {}

    await ctrlOut(device, FTDI.MODEM_CTRL, FTDI.DTR_HIGH | FTDI.RTS_HIGH, iface);
    await ctrlIn(device, FTDI.GET_MODEM_STATUS, 0, iface, 2);

    return { baud, divisor: div, iface };
  },

  async setSignals(device, eps, signals) {
    const iface = eps?.ifaceNum ?? 0;
    const value =
      (signals.dataTerminalReady ? FTDI.DTR_HIGH : FTDI.DTR_LOW) |
      (signals.requestToSend ? FTDI.RTS_HIGH : FTDI.RTS_LOW);
    await ctrlOut(device, FTDI.MODEM_CTRL, value, iface);
  },

  async getSignals(device, eps) {
    const iface = eps?.ifaceNum ?? 0;
    const st = await ctrlIn(device, FTDI.GET_MODEM_STATUS, 0, iface, 2);
    const b0 = st[0];
    return {
      clearToSend: !!(b0 & FTDI.CTS),
      dataSetReady: !!(b0 & FTDI.DSR),
      dataCarrierDetect: !!(b0 & FTDI.RLSD),
      ringIndicator: !!(b0 & FTDI.RI),
    };
  },

  async beforeClose(device, eps) {
    const iface = eps?.ifaceNum ?? 0;
    try {
      await ctrlOut(device, FTDI.MODEM_CTRL, FTDI.DTR_LOW | FTDI.RTS_LOW, iface);
    } catch {}
  },
};

export default ftdi;
