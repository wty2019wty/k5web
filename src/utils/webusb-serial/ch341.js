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

// divisor 寄存器 bit 7：关闭 CH340/CH341 内部“攒满一个端点包才转发”的行为。
// Linux ch341.c 只在 version > 0x27 时置位，并注明“至少有一个 0x27 设备这个位是反的”。
// 常见 CH340 上报的正是 0x27；这里按实测可用的实现无条件置位，若遇到 0x27 设备
// 握手仍然超时，先排查这一位。
const DIVISOR_DISABLE_PACKET_BUFFERING = 1 << 7;

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
    // 无条件置位 bit 7：不置位时短包（K5 握手回包只有 20 多字节）可能一直卡在
    // 芯片缓冲里，读侧永远超时。详见上方 DIVISOR_DISABLE_PACKET_BUFFERING 注释。
    val |= DIVISOR_DISABLE_PACKET_BUFFERING;
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
    // Linux 传的是 u8 取反后的 wValue（0xff9f），高字节也保持一致，避免某些克隆芯片
    // 把高位当成有效状态位。
    await ctrlOut(device, CH341.REQ_MODEM_CTRL, ~mcr & 0xffff, 0);
    await ctrlOut(
      device,
      CH341.REQ_WRITE_REG,
      (CH341.REG_FLOW_CTL << 8) | CH341.REG_FLOW_CTL,
      0x0000
    );

    // 读一下 Modem 状态寄存器做连通性检查，但只是诊断用途：部分克隆芯片不支持该
    // 读数（stall），不应因此让整次连接失败。失败详情 transport.ctrlIn 已经记过日志。
    try {
      await ctrlIn(device, CH341.REQ_READ_REG, 0x0706, 0, 2);
    } catch {}

    return { version };
  },

  async setSignals(device, _eps, signals) {
    const mcr =
      (signals.dataTerminalReady ? CH341.BIT_DTR : 0) |
      (signals.requestToSend ? CH341.BIT_RTS : 0);
    await ctrlOut(device, CH341.REQ_MODEM_CTRL, ~mcr & 0xffff, 0);
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
      await ctrlOut(device, CH341.REQ_MODEM_CTRL, 0xffff, 0);
    } catch {}
  },
};

export default ch341;
