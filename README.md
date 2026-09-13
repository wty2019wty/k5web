# K5Web

- 世界业余无线电日 K5Web 正式开源，添加开源许可协议。
- 感谢所有 HAM 。

## 简介

K5Web 用于对兼容业余无线电台 UV-K5 写频、更新固件、写入星历等。

## 平台支持

| 平台 | 连接方式 | 状态 |
|------|----------|------|
| 桌面 Chrome / Edge / Opera | Web Serial API | 稳定，推荐 |
| 安卓 Chrome（OTG + CH340 写频线） | WebUSB + CH341 驱动 | **实验性** |
| iOS / 其他浏览器 | — | 不支持 |

### 安卓 WebUSB（实验性）

当浏览器没有可用的 Web Serial 设备时，K5Web 会尝试通过 **WebUSB** 直接访问 CH340/CH341 写频线（实现见 `src/utils/webusb-ch341.js`，逻辑对齐 Linux `ch341.c`）。

**使用条件：**

- 安卓 Chrome（不要用 WebView / 多数国产浏览器）
- 站点需 HTTPS
- 手机支持 USB Host，使用 OTG 线连接 CH340（`1a86:7523`）写频线
- 系统内核**不能**已占用该 USB 串口设备

**已知限制：**

- **实验性功能**：不同机型/ROM 差异大，可能出现 `claimInterface` 失败（内核 ch341 驱动已绑定）、偶发传输错误或握手超时
- 仅针对沁恒 CH340/CH341 系列；CP210x / FTDI / PL2303 线材未实现
- 长时间刷固件请保持页面前台，避免安卓后台节流
- 问题反馈请附：手机型号、安卓版本、Chrome 版本、写频线芯片、控制台日志

诊断工具：仓库根目录 `android-webusb-ch341.html` 可单独用于验证手机能否通过 WebUSB 连接电台。

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
