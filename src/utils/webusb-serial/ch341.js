/**
 * CH340/CH341 WebUSB chip driver, ported from linux drivers/usb/serial/ch341.c.
 */

import { ctrlIn, ctrlOut } from './transport.js';

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

const filters = [
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

function matchFilter(vid, pid) {
  return filters.some((f) => f.vendorId === vid && f.productId === pid);
}

const ch341 = {
  name: 'CH341',
  filters,

  matches(vid, pid) {
    return matchFilter(vid, pid);
  },

  async configure(device, _eps, baudRate) {
    const verBuf = await ctrlIn(device, CH341.REQ_READ_VERSION, 0, 0, 2);
    const version = verBuf[0];

    await ctrlOut(device, CH341.REQ_SERIAL_INIT, 0, 0);

    let val = ch341GetDivisor(baudRate);
    if (version > 0x27) val |= 1 << 7;
    await ctrlOut(
      device,
      CH341.REQ_WRITE_REG,
      (CH341.REG_DIVISOR << 8) | CH341.REG_PRESCALER,
      val
    );
    if (version >= 0x30) {
      await ctrlOut(
        device,
        CH341.REQ_WRITE_REG,
        (CH341.REG_LCR2 << 8) | CH341.REG_LCR,
        lcr8n1()
      );
    }

    const mcr = CH341.BIT_DTR | CH341.BIT_RTS;
    await ctrlOut(device, CH341.REQ_MODEM_CTRL, ~mcr & 0xff, 0);
    await ctrlOut(
      device,
      CH341.REQ_WRITE_REG,
      (CH341.REG_FLOW_CTL << 8) | CH341.REG_FLOW_CTL,
      0x0000
    );

    await ctrlIn(device, CH341.REQ_READ_REG, 0x0706, 0, 2);

    return { version };
  },

  async setSignals(device, _eps, signals) {
    const mcr =
      (signals.dataTerminalReady ? CH341.BIT_DTR : 0) |
      (signals.requestToSend ? CH341.BIT_RTS : 0);
    await ctrlOut(device, CH341.REQ_MODEM_CTRL, ~mcr & 0xff, 0);
  },

  async getSignals(device) {
    const st = await ctrlIn(device, CH341.REQ_READ_REG, 0x0706, 0, 2);
    const msr = ~st[0] & CH341.BITS_MODEM_STAT;
    return {
      clearToSend: !!(msr & 0x01),
      dataSetReady: !!(msr & 0x02),
      dataCarrierDetect: !!(msr & 0x08),
      ringIndicator: !!(msr & 0x04),
    };
  },

  async beforeClose(device) {
    try {
      await ctrlOut(device, CH341.REQ_MODEM_CTRL, 0xff, 0);
    } catch {}
  },
};

export default ch341;
