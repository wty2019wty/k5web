/**
 * Silicon Labs CP210x WebUSB chip driver, ported from linux
 * drivers/usb/serial/cp210x.c (IFC_ENABLE / SET_BAUDRATE / SET_LINE_CTL /
 * SET_MHS / GET_MDMSTS). Bulk payload has no extra framing.
 *
 * Control transfers use vendor + interface (bmRequestType 0x41 / 0xC1).
 */

import { ctrlIn, ctrlOut } from './transport.js';

const CP210x = {
  IFC_ENABLE: 0x00,
  SET_BAUDRATE: 0x1e,
  SET_LINE_CTL: 0x03,
  GET_LINE_CTL: 0x04,
  SET_BREAK: 0x05,
  SET_MHS: 0x07,
  GET_MDMSTS: 0x08,
  SET_FLOW: 0x13,
  GET_FLOW: 0x14,
  UART_ENABLE: 0x0001,
  UART_DISABLE: 0x0000,
  // 8 data bits, no parity, 1 stop bit
  LINE_CTL_8N1: 0x0800,
  // SET_MHS: bit0 DTR, bit1 RTS (1 = asserted)
  MHS_DTR: 0x0001,
  MHS_RTS: 0x0002,
  // GET_MDMSTS (1 byte)
  MDMSTS_CTS: 0x10,
  MDMSTS_DSR: 0x20,
  MDMSTS_RI: 0x40,
  MDMSTS_DCD: 0x80,
};

const IFACE = { requestType: 'vendor', recipient: 'interface' };

const filters = [
  { vendorId: 0x10c4, productId: 0xea60 },
  { vendorId: 0x10c4, productId: 0xea70 },
  { vendorId: 0x10c4, productId: 0xea71 },
  { vendorId: 0x10c4, productId: 0xea7b },
];

function matchFilter(vid, pid) {
  return filters.some((f) => f.vendorId === vid && f.productId === pid);
}

const cp210x = {
  name: 'CP210x',
  filters,

  matches(vid, pid) {
    return matchFilter(vid, pid);
  },

  async configure(device, eps, baudRate) {
    const index = eps?.ifaceNum ?? 0;

    await ctrlOut(device, CP210x.IFC_ENABLE, CP210x.UART_ENABLE, index, undefined, IFACE);

    // Most CP210x variants take the baud rate itself in wValue.
    const baud = Math.max(300, Math.min(2000000, Math.round(baudRate) || 38400));
    await ctrlOut(device, CP210x.SET_BAUDRATE, baud & 0xffff, index, undefined, IFACE);

    await ctrlOut(device, CP210x.SET_LINE_CTL, CP210x.LINE_CTL_8N1, index, undefined, IFACE);

    try {
      await ctrlOut(device, CP210x.SET_FLOW, 0x0000, index, undefined, IFACE);
    } catch {
      // Optional on some clones.
    }

    // Assert DTR+RTS, matching CH341 open behaviour.
    await ctrlOut(
      device,
      CP210x.SET_MHS,
      CP210x.MHS_DTR | CP210x.MHS_RTS,
      index,
      undefined,
      IFACE
    );

    // Smoke-test modem status.
    await ctrlIn(device, CP210x.GET_MDMSTS, 0, index, 1, IFACE);

    return { baud, index };
  },

  async setSignals(device, eps, signals) {
    const index = eps?.ifaceNum ?? 0;
    const mhs =
      (signals.dataTerminalReady ? CP210x.MHS_DTR : 0) |
      (signals.requestToSend ? CP210x.MHS_RTS : 0);
    await ctrlOut(device, CP210x.SET_MHS, mhs, index, undefined, IFACE);
  },

  async getSignals(device, eps) {
    const index = eps?.ifaceNum ?? 0;
    const st = await ctrlIn(device, CP210x.GET_MDMSTS, 0, index, 1, IFACE);
    const b = st[0];
    return {
      clearToSend: !!(b & CP210x.MDMSTS_CTS),
      dataSetReady: !!(b & CP210x.MDMSTS_DSR),
      dataCarrierDetect: !!(b & CP210x.MDMSTS_DCD),
      ringIndicator: !!(b & CP210x.MDMSTS_RI),
    };
  },

  async beforeClose(device, eps) {
    const index = eps?.ifaceNum ?? 0;
    try {
      await ctrlOut(device, CP210x.SET_MHS, 0, index, undefined, IFACE);
    } catch {}
    try {
      await ctrlOut(device, CP210x.IFC_ENABLE, CP210x.UART_DISABLE, index, undefined, IFACE);
    } catch {}
  },
};

export default cp210x;
