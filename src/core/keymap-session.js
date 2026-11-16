'use strict';
/**
 * Phiên map phím của cửa sổ game đang ở tiền cảnh: nối sự kiện của tác tử cửa sổ (kd/ku/mb/mm/kmlost)
 * vào lõi KeymapEngine, và đẩy thao tác chạm ra kênh chạm (TouchChannel).
 *
 * Kích hoạt khi cửa sổ app được focus, tắt khi blur / đóng / xoay — xem appwin.js.
 */
const { KeymapEngine, codeToVk, vkToCode } = require('./keymap');

class KeymapSession {
  /**
   * @param {{agent:object, touch:()=>({send:Function}|null), store:{getKeymap:Function},
   *          screen:()=>Promise<{w:number,h:number,landscape:boolean}>, onBack:Function,
   *          notify:(msg:string)=>void, settings:()=>object}} o
   */
  constructor({ agent, touch, store, screen, onBack, notify, settings }) {
    this.touch = touch;
    this.store = store;
    this.screen = screen;
    this.onBack = onBack || (() => {});
    this.notify = notify || (() => {});
    this.settings = settings || (() => ({}));
    this.engine = null;
    this.pkg = null;
    this._handlers = {
      kd: (m) => this._key(m.vk, true),
      ku: (m) => this._key(m.vk, false),
      mb: (m) => { if (this.engine) this._after(() => this.engine.mouseButton(m.b === 1 ? 'Mouse1' : 'Mouse2', m.d === 1)); },
      mm: (m) => { if (this.engine) this.engine.mouseMove(m.dx, m.dy); },
      kmlost: () => { if (this.engine) { this.engine.reset(); this._sync(); } },
    };
    this.agent = null;
    this.setAgent(agent);
  }

  /** Gắn tác tử (tác tử cũ thoát thì main.js tạo cái mới và gọi lại hàm này) */
  setAgent(agent) {
    if (this.agent) for (const [ev, fn] of Object.entries(this._handlers)) this.agent.removeListener(ev, fn);
    this.agent = agent;
    if (agent) for (const [ev, fn] of Object.entries(this._handlers)) agent.on(ev, fn);
    if (this.engine) { this.engine.reset(); this._sync(); }
  }

  get active() { return !!this.engine; }

  async activate(pkg) {
    this.pkg = pkg;
    const profile = pkg && this.store.getKeymap(pkg);
    if (!profile) return false;
    const scr = await this.screen();
    if (!!profile.landscape !== !!scr.landscape) {
      this.notify(`Bộ phím của game này dành cho màn ${profile.landscape ? 'ngang' : 'dọc'}, đã tạm tắt map phím.`);
      return false;
    }
    const engineSettings = (this.settings() || {}).engine || {};
    this.engine = new KeymapEngine({
      profile,
      screen: { w: scr.w, h: scr.h },
      emit: (t) => { const ch = this.touch(); if (ch) ch.send(t); },
      onLock: () => this._sync(),
      onBack: this.onBack,
      disableKey: engineSettings.keymapDisableKey || 'F12',
    });
    await this._sync();
    return true;
  }

  deactivate() {
    if (this.engine) this.engine.reset();
    this.engine = null;
    if (this.agent) this.agent.setKeymap(false).catch(() => {});
  }

  /** Bộ phím vừa được lưu ở trình chỉnh: nạp lại nếu đang chạy */
  async reloadProfile() {
    const pkg = this.pkg;
    if (!this.engine || !pkg) return false;
    this.deactivate();
    return this.activate(pkg);
  }

  _key(vk, down) {
    if (!this.engine) return;
    const code = vkToCode(vk);
    if (!code) return;
    this._after(() => (down ? this.engine.keyDown(code) : this.engine.keyUp(code)));
  }

  /** Chạy fn rồi đồng bộ lại agent nếu trạng thái đổi (khóa/nhả/tắt → danh sách phím nuốt khác) */
  _after(fn) {
    const before = this.engine.state;
    fn();
    if (this.engine && this.engine.state !== before) this._sync();
  }

  _sync() {
    if (!this.engine || !this.agent) return Promise.resolve();
    const vks = this.engine.swallowCodes().map(codeToVk).filter(Boolean);
    return this.agent.setKeymap(true, { locked: this.engine.state === 'locked', vks }).catch(() => {});
  }
}

module.exports = { KeymapSession };
