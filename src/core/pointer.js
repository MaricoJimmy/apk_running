'use strict';
/**
 * Ánh xạ phím chuột (tính toán thuần, không phụ thuộc Electron / adb, tiện unit test)
 *
 * Thứ được nhúng trong cửa sổ app là cửa sổ con Qt của Android Emulator, hành vi gốc là:
 *   Chuột trái = chạm ngón tay (đúng là「xác nhận」, không cần chúng ta can thiệp)
 *   Chuột phải = cũng coi là một lần chạm ngón tay (dễ chạm nhầm, phải chặn lại đổi thành「quay lại」)
 *   Con lăn = vuốt một ngón, nhưng Qt gửi riêng một sự kiện chạm cho mỗi nấc, hình ảnh sẽ bị giật
 *
 * Vì vậy ApkStart chỉ cài một hook cấp thấp trên một luồng riêng khi「cửa sổ app ở tiền cảnh」,
 * chặn chuột phải và con lăn; con lăn được gộp theo cửa sổ thời gian rồi dịch thành một lệnh `input swipe`,
 * vừa mượt vừa không phải mỗi lần cuộn lại khởi chạy một tiến trình adb.
 */

const WHEEL_NOTCH = 120;

function clamp(v, lo, hi) {
  const n = Number(v);
  if (!Number.isFinite(n)) return lo;
  return Math.max(lo, Math.min(hi, n));
}

function clampInt(v, lo, hi) { return Math.round(clamp(v, lo, hi)); }

/**
 * Đọc cài đặt, lấy các công tắc mà hook cần.
 * Khi cấu hình cũ không có các khóa này, di chuyển theo「chuột phải quay lại + con lăn mượt, tắt phím bên」.
 */
function pointerOptions(settings = {}) {
  const e = (settings && settings.engine) || {};
  const rightBack = e.mouseRightBack !== false;
  const wheel = e.mouseWheelMode === 'native' || e.mouseWheelMode === 'off'
    ? e.mouseWheelMode : 'smooth';
  const side = !!e.mouseSideButtons;
  return { rightBack, wheel, side, enabled: rightBack || wheel === 'smooth' || side };
}

/** Thu gọn cấu hình từ bất kỳ nguồn nào thành tổ hợp 0/1 mà agent dùng trực tiếp được */
function hookOptions(raw = {}) {
  let v = raw;
  // Tương thích cách viết boolean cũ: true = chỉ bật ánh xạ phím bên
  if (typeof v === 'boolean') v = { enabled: v, rightBack: false, wheel: 'off', side: v };
  if (typeof v === 'function') v = v();
  if (!v || typeof v !== 'object') v = {};
  const rightBack = !!v.rightBack;
  const wheel = v.wheel === 'smooth' || v.wheel === true;
  const side = !!v.side;
  const enabled = 'enabled' in v ? !!v.enabled : (rightBack || wheel || side);
  return {
    enabled,
    rightBack: enabled && rightBack,
    wheel: enabled && wheel,
    side: enabled && side,
  };
}

/** Chỉ cho phép lệnh input do chính chúng ta ghép nội bộ đi vào adb shell, chặn command injection */
const INPUT_RE = /^input (?:keyevent \d{1,3}|swipe -?\d+ -?\d+ -?\d+ -?\d+ \d{1,4}|tap -?\d+ -?\d+)$/;
function isInputCommand(cmd) { return INPUT_RE.test(String(cmd || '')); }

/**
 * Dịch một loạt dịch chuyển con lăn thành một cử chỉ vuốt.
 * @param {object} o { dx, dy, nx, ny, width, height } —— nx/ny là vị trí chuẩn hóa của con trỏ trong LCD
 * @returns {{x1:number,y1:number,x2:number,y2:number,duration:number}|null}
 */
function wheelToSwipe({ dx = 0, dy = 0, nx = 0.5, ny = 0.5, width = 900, height = 1600 } = {}) {
  const w = clampInt(width, 240, 4096);
  const h = clampInt(height, 320, 4096);
  const vertical = Math.abs(Number(dy) || 0) >= Math.abs(Number(dx) || 0);
  const delta = vertical ? (Number(dy) || 0) : (Number(dx) || 0);
  if (!delta) return null;

  // Một nấc con lăn = vuốt khoảng 30% chiều rộng màn hình; cuộn nhanh liên tục gộp thành một lần vuốt dài hơn (tối đa 78% chiều rộng)
  const steps = clamp(Math.abs(delta) / WHEEL_NOTCH, 0.6, 6);
  const axis = vertical ? h : w;
  const span = clamp(Math.round(axis * 0.30 * steps), 80, Math.round(axis * 0.78));
  const half = Math.round(span / 2);
  const cx = clampInt(clamp(nx, 0, 1) * w, 8, w - 8);
  const cy = clampInt(clamp(ny, 0, 1) * h, 8, h - 8);

  let x1 = cx, y1 = cy, x2 = cx, y2 = cy;
  if (vertical) {
    // dy > 0 (lăn lên/ra xa) → ngón tay vuốt xuống, nội dung cuộn về phía đầu
    const dir = delta > 0 ? 1 : -1;
    y1 = clampInt(cy - half * dir, 1, h - 1);
    y2 = clampInt(cy + half * dir, 1, h - 1);
  } else {
    // dx > 0 (con lăn ngang sang phải) → ngón tay vuốt sang trái
    const dir = delta > 0 ? -1 : 1;
    x1 = clampInt(cx - half * dir, 1, w - 1);
    x2 = clampInt(cx + half * dir, 1, w - 1);
  }
  const duration = clampInt(100 + 22 * steps, 100, 240);
  return { x1, y1, x2, y2, duration };
}

function swipeToCommand(swipe) {
  if (!swipe) return '';
  return `input swipe ${swipe.x1} ${swipe.y1} ${swipe.x2} ${swipe.y2} ${swipe.duration}`;
}

/**
 * Bộ gộp con lăn: mọi lần cuộn trong một cửa sổ thời gian chỉ tạo ra một lệnh vuốt.
 * Việc chèn là bất đồng bộ (input swipe trong adb shell phải chạy hết cả cử chỉ), trong lúc đó tiếp tục cộng dồn,
 * xong rồi mới gửi bù một lần, tránh lệnh xếp hàng trong shell khiến càng cuộn càng giật.
 */
class WheelRouter {
  constructor({ inject, getSize, flushMs = 80 } = {}) {
    this.inject = inject || (() => Promise.resolve());
    this.getSize = getSize || (() => ({ width: 900, height: 1600 }));
    this.flushMs = flushMs;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    this._timer = null;
    this._busy = false;
    this._closed = false;
  }

  push(ev = {}) {
    if (this._closed) return;
    const dx = Number(ev.dx) || 0;
    const dy = Number(ev.dy) || 0;
    if (!dx && !dy) return;
    this._acc.dx += dx;
    this._acc.dy += dy;
    this._acc.nx = clamp(ev.nx, 0, 1);
    this._acc.ny = clamp(ev.ny, 0, 1);
    this._schedule();
  }

  _schedule() {
    if (this._closed || this._timer) return;
    this._timer = setTimeout(() => {
      this._timer = null;
      this._flush();
    }, this.flushMs);
    if (this._timer.unref) this._timer.unref();
  }

  _take() {
    const b = this._acc;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
    return (b.dx || b.dy) ? b : null;
  }

  async flush() { return this._flush(); }

  async _flush() {
    if (this._closed || this._busy) return;
    const batch = this._take();
    if (!batch) return;
    this._busy = true;
    try {
      const size = await this.getSize();
      const cmd = swipeToCommand(wheelToSwipe({ ...batch, width: size.width, height: size.height }));
      if (cmd && isInputCommand(cmd)) await this.inject(cmd);
    } catch (_) { /* chèn input thất bại không được ảnh hưởng hook chuột */ }
    finally {
      this._busy = false;
      if (!this._closed && (this._acc.dx || this._acc.dy)) this._schedule();
    }
  }

  dispose() {
    this._closed = true;
    if (this._timer) clearTimeout(this._timer);
    this._timer = null;
    this._acc = { dx: 0, dy: 0, nx: 0.5, ny: 0.5 };
  }
}

module.exports = {
  WHEEL_NOTCH, clamp, pointerOptions, hookOptions,
  isInputCommand, wheelToSwipe, swipeToCommand, WheelRouter,
};
