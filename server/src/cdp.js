'use strict';
// Drives the kiosk Chrome over the DevTools protocol (localhost only):
// touch/mouse/keyboard injection, navigation, single-tab enforcement, page status.
const http = require('http');
const EventEmitter = require('events');
const WebSocket = require('ws');

function getJSON(url) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, (res) => {
      let d = '';
      res.on('data', (c) => (d += c));
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(3000, () => req.destroy(new Error('timeout')));
  });
}

const SPECIAL_KEYS = {
  Backspace: { code: 'Backspace', vk: 8 },
  Enter: { code: 'Enter', vk: 13, text: '\r' },
  Tab: { code: 'Tab', vk: 9 },
  Escape: { code: 'Escape', vk: 27 },
  ArrowLeft: { code: 'ArrowLeft', vk: 37 },
  ArrowUp: { code: 'ArrowUp', vk: 38 },
  ArrowRight: { code: 'ArrowRight', vk: 39 },
  ArrowDown: { code: 'ArrowDown', vk: 40 },
  Delete: { code: 'Delete', vk: 46 },
  Home: { code: 'Home', vk: 36 },
  End: { code: 'End', vk: 35 },
  PageUp: { code: 'PageUp', vk: 33 },
  PageDown: { code: 'PageDown', vk: 34 },
};

const EDITABLE_JS = `(() => {
  let e = document.activeElement;
  while (e && e.shadowRoot && e.shadowRoot.activeElement) e = e.shadowRoot.activeElement;
  if (!e) return false;
  if (e.isContentEditable) return true;
  const t = e.tagName;
  if (t === 'TEXTAREA') return true;
  if (t === 'IFRAME') return 'frame';
  if (t === 'INPUT') {
    const ty = (e.type || 'text').toLowerCase();
    return !['button','checkbox','radio','submit','range','color','file','image','reset','hidden'].includes(ty);
  }
  return false;
})()`;

class Chrome extends EventEmitter {
  constructor({ port, homeUrl, log }) {
    super();
    this.port = port;
    this.homeUrl = homeUrl;
    this.log = log;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.pages = new Map(); // targetId -> { sessionId, url, title, created }
    this.current = null; // targetId
    this.connected = false;
  }

  async connect() {
    try {
      const v = await getJSON(`http://127.0.0.1:${this.port}/json/version`);
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(v.webSocketDebuggerUrl, { perMessageDeflate: false });
        ws.once('open', resolve);
        ws.once('error', reject);
        ws.on('message', (m) => this.onMessage(m));
        ws.on('close', () => this.onClose());
        this.ws = ws;
      });
      this.connected = true;
      this.log('cdp connected: ' + v.Browser);
      await this.send('Target.setDiscoverTargets', { discover: true });
      const { targetInfos } = await this.send('Target.getTargets');
      for (const t of targetInfos.filter((t) => t.type === 'page')) await this.track(t);
      if (this.pages.size === 0) await this.send('Target.createTarget', { url: this.homeUrl });
    } catch (e) {
      this.connected = false;
      this.log('cdp connect failed: ' + e.message);
      setTimeout(() => this.connect(), 2000);
    }
  }

  onClose() {
    if (this.connected) this.log('cdp disconnected');
    this.connected = false;
    for (const { reject } of this.pending.values()) reject(new Error('cdp closed'));
    this.pending.clear();
    this.pages.clear();
    this.current = null;
    setTimeout(() => this.connect(), 1000);
  }

  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return reject(new Error('cdp not connected'));
      const id = ++this.seq;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(method + ' timeout')); }, 5000);
      this.pending.set(id, {
        resolve: (r) => { clearTimeout(timer); resolve(r); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      const msg = { id, method, params };
      if (sessionId) msg.sessionId = sessionId;
      this.ws.send(JSON.stringify(msg));
    });
  }

  onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      return msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result || {});
    }
    const { method, params } = msg;
    if (method === 'Target.targetCreated' && params.targetInfo.type === 'page') {
      this.track(params.targetInfo, true).catch((e) => this.log('track: ' + e.message));
    } else if (method === 'Target.targetInfoChanged') {
      const t = params.targetInfo;
      const p = this.pages.get(t.targetId);
      if (p) { p.url = t.url; p.title = t.title; if (t.targetId === this.current) this.emitStatus(); }
    } else if (method === 'Target.targetDestroyed') {
      this.pages.delete(params.targetId);
      if (this.current === params.targetId) {
        const rest = [...this.pages.entries()].sort((a, b) => b[1].created - a[1].created);
        this.current = rest.length ? rest[0][0] : null;
        if (!this.current) this.send('Target.createTarget', { url: this.homeUrl }).catch(() => {});
        else this.send('Target.activateTarget', { targetId: this.current }).catch(() => {});
        this.emitStatus();
      }
    }
  }

  // Attach to a page and make it current. Kiosk = one visible tab, so older tabs are closed
  // when a link opens a new one (target=_blank).
  async track(info, isNew = false) {
    if (this.pages.has(info.targetId)) return;
    const page = { sessionId: null, url: info.url, title: info.title, created: Date.now() };
    this.pages.set(info.targetId, page);
    const { sessionId } = await this.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
    page.sessionId = sessionId;
    await this.send('Page.enable', {}, sessionId).catch(() => {});
    await this.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId).catch(() => {});
    await this.send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
    this.current = info.targetId;
    await this.send('Target.activateTarget', { targetId: info.targetId }).catch(() => {});
    if (isNew) {
      for (const id of [...this.pages.keys()]) {
        if (id !== info.targetId) this.send('Target.closeTarget', { targetId: id }).catch(() => {});
      }
    }
    this.emitStatus();
  }

  sid() {
    const p = this.current && this.pages.get(this.current);
    if (!p || !p.sessionId) throw new Error('no active page');
    return p.sessionId;
  }

  emitStatus() {
    const p = this.current && this.pages.get(this.current);
    this.emit('status', { url: p ? p.url : '', title: p ? p.title : '' });
  }

  status() {
    const p = this.current && this.pages.get(this.current);
    return { connected: this.connected, url: p ? p.url : '', title: p ? p.title : '', tabs: this.pages.size };
  }

  // ---- input ----
  async touch(action, x, y) {
    const type = { down: 'touchStart', move: 'touchMove', up: 'touchEnd', cancel: 'touchCancel' }[action];
    if (!type) return;
    const touchPoints = type === 'touchEnd' || type === 'touchCancel'
      ? []
      : [{ x, y, id: 1, radiusX: 6, radiusY: 6, force: 1 }];
    await this.send('Input.dispatchTouchEvent', { type, touchPoints }, this.sid());
  }

  async mouse(action, x, y, button = 'left') {
    const type = { down: 'mousePressed', move: 'mouseMoved', up: 'mouseReleased' }[action];
    if (!type) return;
    const p = { type, x, y, button: type === 'mouseMoved' ? 'none' : button, clickCount: type === 'mouseMoved' ? 0 : 1 };
    if (type === 'mouseMoved' && this.mouseDown) { p.button = 'left'; p.buttons = 1; }
    if (type === 'mousePressed') this.mouseDown = true;
    if (type === 'mouseReleased') this.mouseDown = false;
    await this.send('Input.dispatchMouseEvent', p, this.sid());
  }

  async wheel(x, y, dx, dy) {
    await this.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy }, this.sid());
  }

  async text(s) {
    if (s) await this.send('Input.insertText', { text: String(s).slice(0, 2000) }, this.sid());
  }

  async key(name) {
    const sid = this.sid();
    const k = SPECIAL_KEYS[name];
    if (k) {
      const base = { key: name, code: k.code, windowsVirtualKeyCode: k.vk, nativeVirtualKeyCode: k.vk };
      await this.send('Input.dispatchKeyEvent', { type: k.text ? 'keyDown' : 'rawKeyDown', ...base, ...(k.text ? { text: k.text } : {}) }, sid);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);
      return;
    }
    if (typeof name === 'string' && name.length === 1) {
      // single printable key with shortcut semantics (YouTube: k = play/pause, f = fullscreen, ...)
      const up = name.toUpperCase();
      const vk = /[A-Z0-9]/.test(up) ? up.charCodeAt(0) : 0;
      const code = /[A-Z]/.test(up) ? 'Key' + up : /[0-9]/.test(up) ? 'Digit' + up : '';
      const base = { key: name, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
      await this.send('Input.dispatchKeyEvent', { type: 'keyDown', text: name, ...base }, sid);
      await this.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base }, sid);
    }
  }

  async editableFocused() {
    const r = await this.send('Runtime.evaluate', { expression: EDITABLE_JS, returnByValue: true }, this.sid());
    return r.result ? r.result.value : false;
  }

  // ---- navigation ----
  async nav(action, url) {
    const sid = this.sid();
    if (action === 'back') return this.history(-1);
    if (action === 'forward') return this.history(1);
    if (action === 'reload') return this.send('Page.reload', {}, sid);
    if (action === 'home') return this.send('Page.navigate', { url: this.homeUrl }, sid);
    // The remote browser exists only to sign in to Google/YouTube: refuse other destinations.
    if (action === 'go' && url) { const u = toUrl(url); if (signinAllowed(u)) return this.send('Page.navigate', { url: u }, sid); }
  }

  async history(delta) {
    const sid = this.sid();
    const h = await this.send('Page.getNavigationHistory', {}, sid);
    const e = h.entries[h.currentIndex + delta];
    if (e) await this.send('Page.navigateToHistoryEntry', { entryId: e.id }, sid);
  }
}

// Hosts the sign-in browser may be sent to (Google account sign-in and YouTube).
function signinAllowed(u) {
  try {
    const h = new URL(u).hostname;
    return new URL(u).protocol === 'https:' && /(^|\.)(google\.com|youtube\.com|gstatic\.com)$/.test(h);
  } catch { return false; }
}

// Bare words become a YouTube search; anything URL-ish is opened directly.
function toUrl(input) {
  const s = String(input).trim();
  if (/^https?:\/\//i.test(s)) return s;
  if (/^[\w-]+(\.[\w-]+)+(\/\S*)?$/.test(s) && !/\s/.test(s)) return 'https://' + s;
  return 'https://www.youtube.com/results?search_query=' + encodeURIComponent(s);
}

module.exports = { Chrome, toUrl, signinAllowed };
