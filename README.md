# K5Web

- 世界业余无线电日 K5Web 正式开源，添加开源许可协议。
- 感谢所有 HAM 。

## 简介

K5Web 用于对兼容业余无线电台 UV-K5 写频、更新固件、写入星历等。

## 平台支持

| 平台 | 连接方式 | 状态 |
|------|----------|------|
| 桌面 Chrome / Edge / Opera | Web Serial API | 稳定，推荐 |
| 桌面 / 安卓 Chrome | Web Bluetooth (BLE-NUS 桥接器) | 可用，需 BLE-UART 桥接硬件 **实验性** |
| 安卓 Chrome（OTG + USB 串口写频线） | WebUSB + 多芯片驱动 | **实验性** |
| iOS / 其他浏览器 | — | 不支持 |

连接时会按 **Web Serial → WebUSB → 蓝牙 BLE** 的顺序自动回退（见 `src/utils/serial.js` 的 `connect()`）。

### 安卓 WebUSB（实验性）

当浏览器没有可用的 Web Serial 设备时，K5Web 会尝试通过 **WebUSB** 直接访问 USB 串口写频线（实现见 `src/utils/webusb-serial/`，逻辑对齐 Linux `ch341.c` / `cp210x.c` / `pl2303.c` / `ftdi_sio.c`）。

**支持芯片（WebUSB）：**

| 芯片 | 常见 VID:PID | 备注 |
|------|----------------|------|
| CH340 / CH341 | `1a86:7523` 等 | 最常见写频线 |
| CP210x | `10c4:ea60` 等 | |
| PL2303 | `067b:2303` | 山寨芯片兼容性不一 |
| FTDI FT232R / FT231X | `0403:6001` / `0403:6015` | 仅单口；读包会剥 2 字节状态头 |

**使用条件：**

- 安卓 Chrome 152.0.7977.75 (可以试试其他版本，可能不支持)
- 站点需 HTTPS
- 手机支持 USB Host，使用 OTG 线连接上述芯片的写频线
- 系统内核**不能**已占用该 USB 串口设备

**已知限制：**

- **实验性功能**：不同机型/ROM 差异大，可能出现 `claimInterface` 失败（内核驱动已绑定）、偶发传输错误或握手超时
- FTDI 多口芯片（FT2232 / FT4232）未实现
- 长时间刷固件请保持页面前台，避免安卓后台节流
- 问题反馈请附：手机型号、安卓版本、Chrome 版本、写频线芯片、控制台日志

诊断工具：仓库根目录 `android-webusb-ch341.html` 可单独用于验证手机能否通过 WebUSB 连接 CH340。

### 蓝牙 BLE（NUS 桥接器）（实验性）

当 USB 串口不可用（例如手机没有 OTG 线、或希望无线写频）时，可改用 **BLE-UART 桥接器**：把一块 ESP32-C3 变成「无线 USB-TTL 串口线」，手机/电脑浏览器通过 Web Bluetooth 连上它，即可像串口线一样与电台通信。

```
Chrome/Edge 网页 (Web Bluetooth)
        │  BLE GATT：写 RX / 通知 TX（NUS 布局）
        ▼
   ESP32-C3（ESP-IDF + NimBLE，NUS 桥接固件）
        │  UART（3.3V TTL）
        ▼
   UV-K5 / UV-K6 电台
```

**桥接硬件/固件项目：** [wty2019wty/ESP32C3_NUS_BLE](https://github.com/wty2019wty/ESP32C3_NUS_BLE)

- 基于 ESP-IDF 官方 `ble_uart_service` 例程的 `common/ble_uart` 组件（即标准 NUS 的 GATT 布局），明文免配对
- 支持网页端动态修改波特率、`B2U`/`U2B`/`DROP` 计数与 `SELFTEST` 环回自检，便于排障

**GATT / UUID（与 `ble_uart` 组件一致，K5Web 实现见 `src/utils/ble-serial/`）：**

| 用途 | UUID | 属性 |
|------|------|------|
| Service（NUS） | `6e400001-b5a3-f393-e0a9-e50e24dcca9e` | — |
| RX（网页 → 设备） | `6e400002-b5a3-f393-e0a9-e50e24dcca9e` | Write / Write Without Response |
| TX（设备 → 网页） | `6e400003-b5a3-f393-e0a9-e50e24dcca9e` | Notify |

**接线（与上述项目默认一致）：**

| ESP32-C3 | 电台 (DUT) |
|----------|------------|
| GPIO4（`BRIDGE_UART_TX`） | 电台 **RX** |
| GPIO5（`BRIDGE_UART_RX`） | 电台 **TX** |
| GND | GND |

> C3 为 **3.3V TTL**
> 默认使用 **UART1**，避开 UART0 控制台；引脚/端口/默认波特率可在 `idf.py menuconfig → BLE <-> UART 桥接配置` 修改。

**使用条件：**

- 安卓 Chrome 152.0.7977.75 (可以试试其他版本，可能不支持)
- 站点需 HTTPS（`http://localhost` 亦可）
- 桌面 / 安卓的 Chrome / Edge，且支持 Web Bluetooth
- 打开系统蓝牙，广播名形如 `C3-UART-XXXX`
- iOS Safari 不支持 Web Bluetooth

**行为说明：**

- 电台数据为**字节透传**；此外 K5Web 会识别桥接器的控制帧（魔术前缀 `ESC B L`，即 `0x1B 0x42 0x4C`）：
  - 连接后自动下发 `BAUD=<波特率>` + `FLUSH`，把桥接器 UART 切到本次连接所需波特率（常规写频 `38400`，UVE5 刷机 `115200`），**无需手动配置**
  - 若未收到桥接器主动上报的 `READY`，会先用 `STATUS` 探测一次；对端不是 ESC-BL 桥接器（普通 NUS 透传设备）时不会下发任何控制命令
- 网页 → 设备按协商 ATT MTU 分片发送：默认「自动」，先按最大负载 509 字节（桥接固件 MTU 512 − 写命令头 3）发送，写失败则 509→256→128→64→32→20 逐级降级并记住本次可用值；也可在设置里手动固定档位
- 自动回退时，若浏览器的“用户手势”已过期，会提示**再次点击“连接”**即可直接用蓝牙连接
- 长时间刷固件请保持页面前台，避免浏览器后台节流

**排障建议：**

- 连接后若握手失败，先在桥接器自带网页点「读取状态」或看日志里的 `STATUS BAUD … B2U … U2B … DROP …`：
  - `B2U` 不涨 → 网页 → 设备方向未转发
  - `U2B` 恒为 0 → 设备 → 网页方向未通（检查 TX/RX 是否接反、是否落在 GPIO9 等 strapping 脚）
  - `DROP` 持续增长 → BLE 写得太快，桥接缓冲溢出；可加大 `BRIDGE_BUF_SIZE` 或降速
- 上电默认波特率为 `115200`；K5Web 会在连接时自动改为所需值，若手动用过其它工具，复位桥接器即可恢复默认

## 讨论
- QQ 群：957225277  （K5Web相关）
- QQ 群：201308015  （固件相关）
- Telegram Group: https://t.me/losehu
- Matrix Group: https://matrix.to/#/#losehu:mozilla.org

## 功能列表

- 固件版本检测
- EEPROM 大小检测
- 信道管理
- 启动画面文字管理
- MDC 本地侧音控制（仅支持我的 LTS 固件）
- 备份/还原 EEPROM
- 固件升级
- 开机图片（LOSEHU 固件）
- 字库写入（LOSEHU 固件）
- 星历写入（LOSEHU 固件）
- DTMF ID 设置
- 收音机频道管理
- MDC 联系人管理（LOSEHU 固件）

## 开发
### 安装依赖
```
npm install
```
### 开发
```
npm run dev
```
### 编译
```
npm run build
```

## 关联项目
### 星历计算接口：
    https://github.com/silenty4ng/k5sat

### 我的固件：
    https://github.com/silenty4ng/uv-k5-firmware-chinese-lts 

### 蓝牙 BLE 串口桥接器（ESP32-C3 / NUS）：
    https://github.com/wty2019wty/ESP32C3_NUS_BLE

## 感谢项目
- https://github.com/whosmatt/uvmod
- https://github.com/egzumer/uvtools
- https://github.com/losehu/uv-k5-firmware-custom
- https://github.com/selevo/WebUsbSerialTerminal
- https://github.com/fagci/uvk5-manager
- https://github.com/hank9999/K5_Tools
- https://github.com/kk7ds/chirp

## 开源协议

```
Copyright (c) 2024 Silent YANG

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Star History

[![Star History Chart](https://api.star-history.com/svg?repos=silenty4ng/k5web&type=Date)](https://star-history.com/#silenty4ng/k5web&Date)

## 饿饿饭饭
<img src="https://github.com/silenty4ng/k5web/blob/master/public/mm_facetoface_collect_qrcode_1714392837792.png?raw=true"  width="300" /> <img src="https://github.com/silenty4ng/k5web/blob/master/public/1722745910257.jpg?raw=true"  width="300" />

TRON / TRX：TPaSnHJ2cRCQjjv7TyAFJDamb3mZSSz1At
