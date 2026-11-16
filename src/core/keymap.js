'use strict';
/**
 * Lõi map phím (tính toán thuần, không phụ thuộc Electron / adb / agent — tiện unit test).
 *
 * Nhận sự kiện phím/chuột đã chuẩn hóa (mã kiểu KeyboardEvent.code), sinh ra các thao tác chạm đa điểm
 * dạng [{ id, x, y, up? }] theo pixel màn hình Android. Bên gọi (keymap-session) đẩy chúng qua TouchChannel.
 *
 * Trạng thái: 'unlocked' (mới mở game, chuột tự do) ↔ 'locked' (chuột xoay camera) ; 'disabled' (F12, tắt hẳn).
 * Ngón ảo: joystick = 1, camera = 2, phím thứ i trong controls = 3 + i.
 */

const JOY_ID = 1;
const CAM_ID = 2;

const VK = {
  Space: 0x20, Tab: 0x09, Escape: 0x1B, Backquote: 0xC0, Enter: 0x0D, Backspace: 0x08, CapsLock: 0x14,
  ShiftLeft: 0xA0, ShiftRight: 0xA1, ControlLeft: 0xA2, ControlRight: 0xA3, AltLeft: 0xA4, AltRight: 0xA5,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
};
for (let i = 0; i < 26; i += 1) VK[`Key${String.fromCharCode(65 + i)}`] = 0x41 + i;
for (let i = 0; i < 10; i += 1) VK[`Digit${i}`] = 0x30 + i;
for (let i = 1; i <= 12; i += 1) VK[`F${i}`] = 0x6F + i;
const CODE_BY_VK = new Map(Object.entries(VK).map(([c, v]) => [v, c]));

function codeToVk(code) { return VK[code] || 0; }
function vkToCode(vk) { return CODE_BY_VK.get(vk) || ''; }

/** Bố cục mẫu kiểu PUBG Mobile (tỉ lệ 0–1 của màn hình Android); người dùng kéo lại cho khớp game. */
function defaultTemplate(landscape) {
  const k = (id, key, x, y, label, extra = {}) => ({ id, type: 'key', key, x, y, label, ...extra });
  return {
    version: 1,
    landscape: !!landscape,
    sensitivity: 1.0,
    controls: [
      { id: 'joy', type: 'joystick', x: 0.14, y: 0.72, r: 0.16, keys: { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD' } },
      { id: 'cam', type: 'camera', x: 0.70, y: 0.40, w: 0.56, h: 0.60 },
      k('fire', 'Mouse1', 0.80, 0.52, 'Bắn'),
      k('aim', 'Mouse2', 0.92, 0.42, 'Ngắm'),
      k('jump', 'Space', 0.88, 0.64, 'Nhảy'),
      k('crouch', 'KeyC', 0.82, 0.82, 'Ngồi'),
      k('prone', 'KeyZ', 0.92, 0.84, 'Nằm'),
      k('reload', 'KeyR', 0.70, 0.74, 'Nạp đạn'),
      k('pick', 'KeyF', 0.60, 0.60, 'Nhặt'),
      k('bag', 'Tab', 0.06, 0.30, 'Túi đồ', { releaseMouse: true }),
      k('map', 'KeyM', 0.95, 0.12, 'Bản đồ'),
      k('gun1', 'Digit1', 0.50, 0.90, 'Súng 1'),
      k('gun2', 'Digit2', 0.57, 0.90, 'Súng 2'),
    ],
  };
}

/** Vector hướng joystick: mỗi trục −1/0/1, đường chéo chuẩn hóa về độ dài 1; hai phím ngược nhau triệt tiêu. */
function joystickVector(down, keys) {
  const x = (down.has(keys.right) ? 1 : 0) - (down.has(keys.left) ? 1 : 0);
  const y = (down.has(keys.down) ? 1 : 0) - (down.has(keys.up) ? 1 : 0);
  const len = Math.hypot(x, y);
  return len ? { x: x / len, y: y / len } : { x: 0, y: 0 };
}

class KeymapEngine {
  constructor({ profile, screen, emit, onLock, onBack, disableKey = 'F12' }) {
    this.profile = profile;
    this.screen = screen;
    this.emit = emit || (() => {});
    this.onLock = onLock || (() => {});
    this.onBack = onBack || (() => {});
    this.disableKey = disableKey;
    this.controls = (profile && profile.controls) || [];
    this.joy = this.controls.find((c) => c.type === 'joystick') || null;
    this.cam = this.controls.find((c) => c.type === 'camera') || null;
    this._state = 'unlocked';
    this._joyDown = new Set();   // phím hướng đang giữ
    this._joyActive = false;
    this._cam = null;            // {x,y} vị trí ngón camera đang chạm
    this._keys = new Map();      // control.id -> finger id đang giữ
  }

  get state() { return this._state; }

  _px(c) { return { x: c.x * this.screen.w, y: c.y * this.screen.h }; }

  _setLocked(locked) {
    const want = locked ? 'locked' : 'unlocked';
    if (this._state === want) return;
    this._state = want;
    if (!locked) this._liftCamera();
    this.onLock(!!locked);
  }

  _liftCamera() {
    if (!this._cam) return;
    this.emit([{ id: CAM_ID, x: this._cam.x, y: this._cam.y, up: true }]);
    this._cam = null;
  }

  _updateJoystick() {
    const c = this._px(this.joy);
    const v = joystickVector(this._joyDown, this.joy.keys);
    if (!v.x && !v.y) {
      if (this._joyActive) {
        this._joyActive = false;
        this.emit([{ id: JOY_ID, x: c.x, y: c.y, up: true }]);
      }
      return;
    }
    if (!this._joyActive) {
      this._joyActive = true;
      this.emit([{ id: JOY_ID, x: c.x, y: c.y }]);
    }
    const r = this.joy.r * this.screen.h;
    this.emit([{ id: JOY_ID, x: c.x + v.x * r, y: c.y + v.y * r }]);
  }

  _isJoyKey(code) {
    if (!this.joy) return false;
    const k = this.joy.keys;
    return code === k.up || code === k.left || code === k.down || code === k.right;
  }

  _press(code) {
    let hit = false;
    this.controls.forEach((c, i) => {
      if (c.type !== 'key' || c.key !== code) return;
      hit = true;
      if (this._keys.has(c.id)) return; // lặp phím do giữ
      const id = 3 + i;
      this._keys.set(c.id, id);
      const p = this._px(c);
      this.emit([{ id, x: p.x, y: p.y }]);
      if (c.releaseMouse) this._setLocked(this._state !== 'locked');
    });
    return hit;
  }

  _release(code) {
    let hit = false;
    this.controls.forEach((c) => {
      if (c.type !== 'key' || c.key !== code || !this._keys.has(c.id)) return;
      hit = true;
      const p = this._px(c);
      this.emit([{ id: this._keys.get(c.id), x: p.x, y: p.y, up: true }]);
      this._keys.delete(c.id);
    });
    return hit;
  }

  keyDown(code) {
    if (code === this.disableKey) {
      if (this._state === 'disabled') this._state = 'unlocked';
      else { this.reset(); this._state = 'disabled'; }
      return true;
    }
    if (this._state === 'disabled') return false;
    if (code === 'Backquote') { this._setLocked(this._state !== 'locked'); return true; }
    if (code === 'Escape') { this.onBack(); this._setLocked(this._state !== 'locked'); return true; }
    if (this._isJoyKey(code)) {
      if (!this._joyDown.has(code)) { this._joyDown.add(code); this._updateJoystick(); }
      return true;
    }
    return this._press(code);
  }

  keyUp(code) {
    if (code === this.disableKey) return true;
    if (this._state === 'disabled') return false;
    if (code === 'Backquote' || code === 'Escape') return true;
    if (this._isJoyKey(code)) {
      if (!this._joyDown.has(code)) return false;
      this._joyDown.delete(code);
      this._updateJoystick();
      return true;
    }
    return this._release(code);
  }

  mouseButton(code, down) {
    if (!down) return this._release(code);
    if (this._state !== 'locked') return false;
    return this._press(code);
  }

  mouseMove(dx, dy) {
    if (this._state !== 'locked' || !this.cam) return;
    const s = Number(this.profile.sensitivity) || 1;
    const c = this._px(this.cam);
    const hw = (this.cam.w * this.screen.w) / 2;
    const hh = (this.cam.h * this.screen.h) / 2;
    const inside = (p) => Math.abs(p.x - c.x) <= hw && Math.abs(p.y - c.y) <= hh;
    if (!this._cam) {
      this._cam = { x: c.x, y: c.y };
      this.emit([{ id: CAM_ID, x: c.x, y: c.y }]);
    }
    let next = { x: this._cam.x + dx * s, y: this._cam.y + dy * s };
    if (!inside(next)) {
      // Chạm mép: nhấc ngón, đặt lại ở tâm vùng rồi áp phần dịch chuyển (kẹp trong vùng)
      this.emit([{ id: CAM_ID, x: this._cam.x, y: this._cam.y, up: true }]);
      this.emit([{ id: CAM_ID, x: c.x, y: c.y }]);
      next = {
        x: Math.max(c.x - hw, Math.min(c.x + hw, c.x + dx * s)),
        y: Math.max(c.y - hh, Math.min(c.y + hh, c.y + dy * s)),
      };
    }
    this._cam = next;
    this.emit([{ id: CAM_ID, x: next.x, y: next.y }]);
  }

  /** Nhấc mọi ngón, nhả chuột (dùng khi mất focus, tắt map phím, tác tử báo mất tiền cảnh) */
  reset() {
    if (this._joyActive) {
      const c = this._px(this.joy);
      this.emit([{ id: JOY_ID, x: c.x, y: c.y, up: true }]);
      this._joyActive = false;
    }
    this._joyDown.clear();
    for (const code of [...new Set(this.controls.filter((c) => c.type === 'key').map((c) => c.key))]) this._release(code);
    this._liftCamera();
    if (this._state === 'locked') this._setLocked(false);
    this._state = 'unlocked';
  }

  /** Mã phím agent phải nuốt ở trạng thái hiện tại (không gồm nút chuột) */
  swallowCodes() {
    if (this._state === 'disabled') return [this.disableKey];
    const set = new Set([this.disableKey, 'Backquote', 'Escape']);
    if (this.joy) Object.values(this.joy.keys).forEach((k) => set.add(k));
    this.controls.forEach((c) => { if (c.type === 'key' && !/^Mouse/.test(c.key)) set.add(c.key); });
    return [...set];
  }
}

module.exports = { defaultTemplate, vkToCode, codeToVk, joystickVector, KeymapEngine };
