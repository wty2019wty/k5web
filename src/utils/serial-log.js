/**
 * 串口诊断日志：安卓上不方便开 devtools，把关键 USB / Serial 事件写进页面浮层，
 * 复现后截图/复制即可定位。控制台：window.__webusbDump() / __webusbClear() / __webusbVerbose(true)。
 */

const DEBUG_LOG = [];
const DEBUG_LOG_MAX = 800;
// 桌面走 Web Serial、安卓走 WebUSB；标题随连接方式更新。
let debugTransportLabel = 'WebUSB';
// DOM 渲染与日志收集解耦：默认收起时不碰 DOM，展开时按帧批量追加。
// 每收到一个数据块就同步 appendChild + scrollTop 会强制重排并阻塞主线程，
// 导致 CH340 的小接收 FIFO 溢出、静默丢字节。
let debugBodyEl = null;
let debugExpanded = false;
let debugPending = [];
let debugFlushScheduled = false;
// 高频逐块日志（每 1–8B 一次）默认关闭：fmtHex 字符串拼接发生在主线程上，
// 会挤占 USB 读循环、诱发丢字节。排查时调用 window.__webusbVerbose(true)。
let debugVerbose = false;

export function isDebugVerbose() {
    return debugVerbose;
}

export function setDebugVerbose(v) {
    debugVerbose = !!v;
}

/** @param {'webserial'|'webusb'} mode */
export function setDebugTransport(mode) {
    debugTransportLabel = mode === 'webserial' ? 'Web Serial' : 'WebUSB';
    try {
        if (typeof document === 'undefined') return;
        ensureDebugOverlay();
        const title = document.getElementById('__webusb_debug_title');
        if (title) title.textContent = `${debugTransportLabel} 日志`;
    } catch {}
}

function debugTimestamp() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}:${String(
        d.getSeconds()
    ).padStart(2, '0')}.${String(d.getMilliseconds()).padStart(3, '0')}`;
}

function flushDebugDom() {
    debugFlushScheduled = false;
    if (!debugExpanded || !debugBodyEl || debugPending.length === 0) {
        debugPending = [];
        return;
    }
    const frag = document.createDocumentFragment();
    for (const line of debugPending) {
        const div = document.createElement('div');
        div.textContent = line;
        frag.appendChild(div);
    }
    debugPending = [];
    debugBodyEl.appendChild(frag);
    while (debugBodyEl.childElementCount > DEBUG_LOG_MAX) {
        debugBodyEl.removeChild(debugBodyEl.firstElementChild);
    }
    debugBodyEl.scrollTop = debugBodyEl.scrollHeight;
}

function scheduleDebugFlush() {
    if (debugFlushScheduled) return;
    debugFlushScheduled = true;
    const raf = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : (cb) => setTimeout(cb, 16);
    raf(flushDebugDom);
}

function ensureDebugOverlay() {
    if (typeof document === 'undefined') return;
    if (debugBodyEl && debugBodyEl.isConnected) return;
    if (document.getElementById('__webusb_debug')) return;
    const box = document.createElement('div');
    box.id = '__webusb_debug';
    box.style.cssText = [
        'position:fixed', 'right:4px', 'bottom:4px', 'z-index:2147483647',
        'max-width:96vw', 'max-height:42vh', 'display:flex', 'flex-direction:column',
        'overflow:hidden',
        'background:rgba(0,0,0,0.82)', 'color:#7dff7d',
        'font:11px/1.35 monospace', 'white-space:pre-wrap', 'word-break:break-all',
        'padding:6px 8px', 'border-radius:6px', 'box-shadow:0 0 8px rgba(0,0,0,.5)',
    ].join(';');
    const bar = document.createElement('div');
    bar.style.cssText = 'display:flex;gap:8px;align-items:center;margin-bottom:4px;color:#fff;flex:0 0 auto';
    const title = document.createElement('span');
    title.id = '__webusb_debug_title';
    title.textContent = `${debugTransportLabel} 日志`;
    title.style.cssText = 'font-weight:bold';
    const copy = document.createElement('button');
    copy.textContent = '复制';
    copy.style.cssText = 'font:11px monospace;padding:1px 6px;cursor:pointer';
    copy.onclick = () => {
        const text = DEBUG_LOG.join('\n');
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(() => { copy.textContent = '已复制'; });
        } else {
            window.prompt('复制下面的日志：', text);
        }
    };
    const clear = document.createElement('button');
    clear.textContent = '清空';
    clear.style.cssText = 'font:11px monospace;padding:1px 6px;cursor:pointer';
    clear.onclick = () => {
        DEBUG_LOG.length = 0;
        debugPending = [];
        if (debugBodyEl) debugBodyEl.textContent = '';
    };
    const hide = document.createElement('button');
    hide.textContent = '展开';
    hide.style.cssText = 'font:11px monospace;padding:1px 6px;cursor:pointer';
    hide.onclick = () => {
        debugExpanded = !debugExpanded;
        if (debugBodyEl) debugBodyEl.style.display = debugExpanded ? 'block' : 'none';
        hide.textContent = debugExpanded ? '收起' : '展开';
        if (debugExpanded) {
            debugPending = DEBUG_LOG.slice();
            flushDebugDom();
        }
    };
    bar.append(title, copy, clear, hide);
    const body = document.createElement('div');
    body.style.cssText = 'display:none;overflow:auto;flex:1 1 auto;min-height:0;max-height:36vh';
    box.append(bar, body);
    document.body.appendChild(box);
    debugBodyEl = body;
    debugExpanded = false;
}

export function fmtHex(bytes, max = 32) {
    if (!bytes) return '';
    const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const part = Array.from(arr.subarray(0, max)).map((b) => b.toString(16).padStart(2, '0')).join(' ');
    return arr.length > max ? `${part} …(${arr.length}B)` : `${part} (${arr.length}B)`;
}

export function logWebUsb(message) {
    const line = `${debugTimestamp()} ${message}`;
    DEBUG_LOG.push(line);
    if (DEBUG_LOG.length > DEBUG_LOG_MAX) DEBUG_LOG.splice(0, DEBUG_LOG.length - DEBUG_LOG_MAX);
    try {
        if (typeof document !== 'undefined') {
            ensureDebugOverlay();
            if (debugExpanded) {
                debugPending.push(line);
                scheduleDebugFlush();
            }
        }
    } catch {}
}

if (typeof window !== 'undefined') {
    window.__webusbDump = () => DEBUG_LOG.join('\n');
    window.__webusbClear = () => { DEBUG_LOG.length = 0; debugPending = [];
        if (debugBodyEl) debugBodyEl.textContent = ''; };
    window.__webusbLog = DEBUG_LOG;
    window.__webusbVerbose = setDebugVerbose;
}
