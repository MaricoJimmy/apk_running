'use strict';
/**
 * Cửa sổ ứng dụng: một ứng dụng Android đang chạy = một cửa sổ Windows gọn gàng.
 *
 * Trong cửa sổ chỉ có một thanh tiêu đề 38px ở trên (Xoay / Thu nhỏ / Phóng to / Đóng),
 * toàn bộ phần hình bên dưới là cửa sổ trình giả lập được nhúng vào (SetParent), nên không thấy màn hình chính Android,
 * không thấy thanh công cụ bên cạnh của trình giả lập, cũng không có thêm biểu tượng thứ hai trên thanh tác vụ.
 */
const { BrowserWindow, screen, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { hookOptions } = require('./pointer');
const { KeymapOverlay } = require('./overlay');
const { defaultTemplate } = require('./keymap');
const store = require('./store');

const TITLEBAR_H = 38;
/**
 * Cửa sổ trình giả lập có sẵn lề xám 8px bốn phía (khoảng trống viền của Qt),
 * còn hình LCD thật bắt đầu từ +8px. Phóng to cửa sổ con thêm 16px và dịch lên trái 8px,
 * thì viền xám này bị đẩy ra ngoài vùng client, hình ảnh lấp kín gọn gàng bốn phía.
 */
const EMU_PAD = 8;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function iconUrl(p) {
  if (!p || !fs.existsSync(p)) return '';
  return `file:///${p.replace(/\\/g, '/').replace(/ /g, '%20')}?v=${fs.statSync(p).mtimeMs}`;
}

class AppWindow {
  constructor({ agent, setOrientation, mouseHook = false, pointerConfig = null, keymap = null }) {
    this.agent = agent;
    // Phiên map phím (keymap-session.js): bật khi cửa sổ ở tiền cảnh, tắt khi blur / đóng / xoay
    this.keymap = keymap;
    this.setOrientation = setOrientation || null;
    // Hook chuột toàn cục chỉ cài khi "cửa sổ ứng dụng ở tiền cảnh + bật ít nhất một ánh xạ".
    // pointerConfig truyền vào là hàm: đổi công tắc ở trang cài đặt thì lần focus kế tiếp có hiệu lực, không cần khởi động lại.
    this.mouseHook = mouseHook;
    this.pointerConfig = pointerConfig;
    this.win = null;
    this.pkg = null;
    this.state = { label: '', tip: '', ready: false, landscape: false };
    this._fitTimer = null;
    this._closedCb = null;
  }

  get isOpen() { return !!(this.win && !this.win.isDestroyed()); }

  /** Kích thước đích của nội dung cửa sổ ở chế độ dọc / ngang (tự co cho vừa màn hình) */
  static sizeFor(area, portrait, landscape) {
    const p = portrait || { w: 540, h: 960 };
    // Chừa đủ lề: thanh tiêu đề 38 + trên dưới mỗi bên 24, trái phải mỗi bên 40
    const availH = Math.max(360, (area.h || 1040) - TITLEBAR_H - 48);
    const availW = Math.max(300, (area.w || 1920) - 80);
    const k = landscape
      ? Math.min(availW / p.h, availH / p.w)
      : Math.min(availH / p.h, availW / p.w);
    const w = Math.round((landscape ? p.h : p.w) * k);
    const h = Math.round((landscape ? p.w : p.h) * k);
    // Bảo hiểm kép: tuyệt đối không vượt vùng khả dụng của màn hình, nếu không sẽ bị hệ thống cắt, trông như "có viền đen / không lấp đầy"
    return {
      w: Math.max(320, Math.min(w, Math.round(availW))),
      h: Math.max(360, Math.min(h, Math.round(availH))),
    };
  }

  _area() {
    const d = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
    const a = d.workArea || d.bounds;
    return { x: a.x, y: a.y, w: a.width, h: a.height };
  }

  _scale() {
    try {
      const b = this.win ? this.win.getBounds() : this._area();
      return screen.getDisplayMatching(b).scaleFactor || 1;
    } catch (_) {
      return 1;
    }
  }

  /**
   * Mở (hoặc dùng lại) cửa sổ ứng dụng.
   * @param {object} o { pkg, label, iconPath, portrait, fullscreen, onClosed }
   */
  open(o) {
    const { pkg, label, iconPath, portrait, fullscreen } = o;
    this._closedCb = o.onClosed || null;
    if (this.isOpen && this.pkg === pkg) {
      this.win.show();
      this.win.focus();
      return this.win;
    }
    this.close({ keepApp: true });

    this.pkg = pkg;
    this.portrait = portrait || { w: 540, h: 960 };
    this.state = { label: label || 'Ứng dụng', tip: 'Đang khởi động môi trường Android…', ready: false, landscape: false };

    const area = this._area();
    const size = AppWindow.sizeFor(area, this.portrait, false);
    const w = Math.max(320, size.w);
    const h = Math.max(420, size.h + TITLEBAR_H);

    const iconFile = iconPath && fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : undefined;

    this.win = new BrowserWindow({
      width: w,
      height: h,
      minWidth: 320,
      minHeight: 420,
      x: Math.round(area.x + (area.w - w) / 2),
      y: Math.round(area.y + (area.h - h) / 2),
      show: false,
      frame: false,
      thickFrame: true,
      resizable: true,
      maximizable: true,
      backgroundColor: '#0b0c0e',
      title: label || 'ApkStart',
      icon: iconFile,
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
        backgroundThrottling: false,
      },
    });

    this.win.loadFile(path.join(__dirname, '..', 'ui', 'shell.html'));
    // Tiêu đề trang sẽ đổi tiêu đề cửa sổ thành <title> của shell.html, thanh tác vụ sẽ không nhận ra là ứng dụng nào,
    // nên chặn ở đây, để tiêu đề OS luôn là tên ứng dụng (chú thích thanh tác vụ, Alt+Tab đều dựa vào nó).
    this.win.webContents.on('page-title-updated', (e) => {
      e.preventDefault();
      try { this.win.setTitle(label || 'ApkStart'); } catch (_) { /* cửa sổ có thể đã bị hủy */ }
    });
    this.win.once('ready-to-show', () => {
      this.win.show();
      this._push();
    });

    // Khi Electron phóng to, kích thước cửa sổ phải qua vài bước mới ổn định (hiệu ứng OS, tính lại DPI),
    // fit chống dội 40ms một lần thường bắt phải trạng thái giữa chừng, kết quả hình nhúng chỉ chiếm một dải góc trên trái,
    // bên phải trống một mảng lớn — chính là lỗi "phóng to xong không lấp đầy" trong ảnh chụp của người dùng.
    // Đổi thành căn khớp nhiều vòng liên tiếp cho hội tụ, mỗi vòng tính lại theo getContentBounds mới nhất.
    const refit = () => this.scheduleFit(6);
    this.win.on('resize', refit);
    this.win.on('move', refit);
    this.win.on('maximize', refit);
    this.win.on('unmaximize', refit);
    this.win.on('restore', () => {
      this.agent.show().catch(() => {});
      this.scheduleFit(6);
    });
    this.win.on('minimize', () => { this.agent.hide().catch(() => {}); if (this.overlay) this.overlay.hide(); });
    // Lớp phủ map phím phải bám theo vùng hình khi di chuyển / đổi cỡ / phóng to
    for (const ev of ['move', 'resize', 'maximize', 'unmaximize', 'restore']) this.win.on(ev, () => this.refreshOverlay());
    this.win.on('close', () => { this._closing = true; });
    this.win.on('closed', () => {
      if (this._selfClose) return;   // close() tự dọn dẹp sau khi park xong
      this.win = null;
      const pkg = this.pkg;
      this.pkg = null;
      this._closing = false;
      this._syncKeymap(false);
      this.overlay = null;   // cửa sổ con bị hủy cùng cửa sổ chủ
      // Các đường đóng không qua close() (Alt+F4, đóng từ thanh tác vụ, tắt máy) cũng phải dừng ứng dụng Android,
      // gỡ cửa sổ trình giả lập ra. Nếu không, cửa sổ biến mất nhưng ứng dụng vẫn chạy nền, người dùng bấm mở lại sẽ vì
      // "đang chạy rồi" mà chuyển thẳng sang, trông như "không đóng được".
      if (pkg && this._onCloseApp) {
        try { this._onCloseApp(pkg); } catch (_) { /* ignore */ }
      }
      Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(() => {
        if (this._closedCb) this._closedCb(pkg);
      });
    });
    // Chỉ cài hook toàn cục khi "cửa sổ ứng dụng thật sự ở tiền cảnh" và bật ít nhất một ánh xạ chuột;
    // mất focus/đóng thì gỡ ngay, tuyệt không để ApkStart làm chậm chuột của cả hệ thống khi chạy nền.
    this.win.on('focus', () => { this._syncHook(true); this._syncKeymap(true); });
    this.win.on('blur', () => { this._syncHook(false); this._syncKeymap(false); });

    if (fullscreen) this.win.maximize();
    return this.win;
  }

  /** Vùng hình LCD trên màn hình (DIP): vùng client trừ thanh tiêu đề */
  lcdRect() {
    const b = this.win.getContentBounds();
    return { x: b.x, y: b.y + TITLEBAR_H, width: b.width, height: b.height - TITLEBAR_H };
  }

  _overlayPayload() {
    const engine = store.getSettings().engine || {};
    const landscape = !!this.state.landscape;
    return {
      profile: this.pkg ? store.getKeymap(this.pkg) : null,
      template: defaultTemplate(landscape),
      labels: engine.keymapLabels !== false,
      disableKey: engine.keymapDisableKey || 'F12',
      landscape,
    };
  }

  _ensureOverlay() {
    if (!this.overlay || !this.overlay.win || this.overlay.win.isDestroyed()) this.overlay = new KeymapOverlay({ parent: this.win });
    return this.overlay;
  }

  /** Đồng bộ lớp phủ: đang chỉnh thì chỉ bám vị trí; không thì hiện nhãn phím (nếu game có bộ phím và bật nhãn) */
  refreshOverlay() {
    if (!this.isOpen || this.win.isMinimized()) return;
    if (this.overlay && this.overlay.isEditing) { this.overlay.setBounds(this.lcdRect()); return; }
    const p = this._overlayPayload();
    const want = !!(p.profile && p.labels && this.state.ready && !!p.profile.landscape === p.landscape);
    if (!want) { if (this.overlay) this.overlay.hide(); return; }
    const ov = this._ensureOverlay();
    ov.setBounds(this.lcdRect());
    ov.show('play', p);
  }

  openKeymapEditor() {
    if (!this.isOpen) return false;
    const ov = this._ensureOverlay();
    ov.setBounds(this.lcdRect());
    ov.show('edit', this._overlayPayload());
    return true;
  }

  closeKeymapEditor() {
    if (this.overlay) this.overlay.hide();
    if (!this.isOpen) return;
    this.refreshOverlay();
    // Trả focus cho cửa sổ game: sự kiện focus sẽ bật lại map phím với bộ phím vừa lưu
    this.win.focus();
  }

  _syncKeymap(active) {
    if (!this.keymap) return;
    if (active && this.pkg) this.keymap.activate(this.pkg).catch(() => {});
    else this.keymap.deactivate();
  }

  _pointerOptions() {
    const getter = this.pointerConfig || this.mouseHook;
    const raw = typeof getter === 'function' ? getter() : getter;
    return hookOptions(raw);
  }

  _syncHook(active) {
    const opts = this._pointerOptions();
    // Chế độ game/độ trễ thấp hoàn toàn không cài hook chuột toàn cục: WH_MOUSE_LL gọi lại đồng bộ
    // cho mọi sự kiện chuột trên desktop, làm tăng rõ độ trễ con trỏ; game FPS cần cửa sổ Qt nhận trực tiếp input gốc.
    const game = !!(store.getSettings().engine && store.getSettings().engine.priorityMode === 'game');
    const on = !!active && opts.enabled && !game;
    if (this.agent && typeof this.agent.setHook === 'function') {
      this.agent.setHook(on, opts).catch(() => {});
    }
  }

  /** Trang cài đặt đổi ánh xạ chuột: đồng bộ lại theo focus hiện tại (không cài lại luồng hook) */
  refreshPointer() {
    const focused = this.isOpen && !!this.win.isFocused();
    if (!focused) {
      // Cửa sổ không ở tiền cảnh: chỉ gỡ, đừng để hook chạy không ở nền
      if (this.agent && typeof this.agent.setHook === 'function') {
        this.agent.setHook(false).catch(() => {});
      }
      return;
    }
    this._syncHook(true);
  }

  setState(patch) {
    this.state = { ...this.state, ...patch };
    this._push();
    if (patch && 'ready' in patch) this.refreshOverlay();
  }

  _push() {
    if (!this.isOpen) return;
    try {
      this.win.webContents.send('shell:state', {
        ...this.state,
        iconUrl: this.iconUrl || '',
      });
    } catch (_) { /* cửa sổ có thể vừa đóng */ }
  }

  setIcon(p) { this.iconUrl = iconUrl(p); this._push(); }

  /**
   * Nhúng cửa sổ trình giả lập vào cửa sổ hiện tại, lấp đầy vùng dưới thanh tiêu đề.
   * Không tắt chế độ ẩn thường trực: nó bỏ qua cửa sổ "đã nhúng vào cửa sổ của ta", các cửa sổ khác (gồm cửa sổ console đen của qemu /
   * netsimd) tiếp tục bị ẩn — tắt đi lại cho chúng cơ hội hiện ra lần nữa.
   * Đôi khi cửa sổ trình giả lập chưa tạo xong (trên máy khôi phục snapshot quá nhanh), nên thử lại hai lần.
   */
  async embed() {
    if (!this.isOpen) return false;
    let last = null;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      if (!this.isOpen) return false;
      const hwnd = this._hwnd();
      if (!hwnd) return false;
      // eslint-disable-next-line no-await-in-loop
      const r = await this.agent.embed(hwnd, this._rect()).catch((e) => ({ ok: false, error: e.message }));
      last = r;
      if (r && r.ok) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(attempt < 2 ? 300 : 800);
    }
    // Đưa lý do thất bại ra ngoài: tầng trên ghi vào app.log, khi có sự cố nhìn là biết "không tìm thấy cửa sổ trình giả lập"
    // hay "SetParent thất bại", khỏi phải đoán.
    this.lastEmbedError = last ? (last.error || `emu=${last.emu}`) : 'no-response';
    return false;
  }

  async fitNow() {
    if (!this.isOpen) return;
    await this.agent.fit(this._rect()).catch(() => {});
  }

  /** Hình chữ nhật cửa sổ con trình giả lập cần chiếm (pixel vật lý, đã đẩy lề 8px ra ngoài vùng hiển thị) */
  _rect() {
    const sf = this._scale();
    const b = this.win.getContentBounds();
    const top = Math.round(TITLEBAR_H * sf);
    return {
      x: -EMU_PAD,
      y: top - EMU_PAD,
      w: Math.round(b.width * sf) + EMU_PAD * 2,
      h: Math.round((b.height - TITLEBAR_H) * sf) + EMU_PAD * 2,
      // Dải -EMU_PAD phía trên sẽ đè lên thanh tiêu đề, giao cho tác tử cửa sổ cắt bỏ (xem clipTop của agent.fit)
      clipTop: EMU_PAD,
    };
  }

  /**
   * @param {number} rounds số vòng căn khớp liên tiếp (khi kích thước cửa sổ đổi, mỗi vòng tính lại bounds mới nhất)
   */
  scheduleFit(rounds = 1) {
    if (!this.isOpen) return;
    if (this._fitTimer) clearTimeout(this._fitTimer);
    const run = async (left) => {
      await this.fitNow().catch(() => {});
      if (left > 1) {
        this._fitTimer = setTimeout(() => run(left - 1), 160);
      } else {
        this._fitTimer = null;
      }
    };
    this._fitTimer = setTimeout(() => run(Math.max(1, rounds)), 40);
  }

  _hwnd() {
    try {
      const buf = this.win.getNativeWindowHandle();
      const v = buf.length >= 8 ? buf.readBigUInt64LE(0) : BigInt(buf.readUInt32LE(0));
      return v.toString();
    } catch (_) {
      return null;
    }
  }

  /**
   * Chuyển ngang/dọc (nút xoay trên thanh tiêu đề) = thật sự đổi "tấm nền vật lý" sang ngang hoặc dọc.
   *
   * Vì sao bắt buộc làm vậy (những lỗi đã gặp):
   *   - Đổi wm size: chỉ đổi độ phân giải logic của Android, LCD vật lý của trình giả lập vẫn dọc,
   *     Qt dán hình vào góc trên trái -> hình nằm nghiêng 90°, chỉ chiếm một dải, viền đen bốn phía, tọa độ chạm lệch;
   *   - Đổi wm density: kích thước framebuffer không đổi, hình không lấp đầy, phóng to xong bên phải trống một mảng lớn;
   *   - adb emu rotate: chỉ xoay nội dung hình, trong hệ thống vẫn là dọc.
   * Cách duy nhất có được màn ngang "đúng chiều + lấp đầy" là đổi hw.lcd.width/height thành
   * 1280x720 rồi khởi động lại trình giả lập. Khởi động lại mất khoảng 30~60 giây, nên chỉ làm một lần và báo rõ cho người dùng.
   *
   * @param {(next:boolean)=>Promise<boolean>} [onRestart] hàm khởi động lại do tầng trên truyền vào
   */
  async rotate(onRestart) {
    if (!this.isOpen) return this.state.landscape;
    const next = !this.state.landscape;
    this._syncKeymap(false);
    this.setState({ tip: next ? 'Đang chuyển sang màn ngang (khởi động lại môi trường Android, khoảng 30-60 giây)…' : 'Đang chuyển về màn dọc (khởi động lại môi trường Android, khoảng 30-60 giây)…', ready: false });
    if (typeof onRestart === 'function') {
      const ok = await onRestart(next).catch(() => false);
      if (ok) {
        this.state.landscape = next;
        this._push();
        // Kích thước tấm nền đã đổi, tỉ lệ cửa sổ đổi theo; căn khớp vài vòng cho hội tụ
        for (let i = 0; i < 5; i += 1) {
          // eslint-disable-next-line no-await-in-loop
          await sleep(400);
          // eslint-disable-next-line no-await-in-loop
          await this.fitNow();
        }
        this.setState({ ready: true, tip: '' });
        return next;
      }
    }
    // Khi không có hàm khởi động lại (hoặc thất bại) thì lùi về cách density, ít nhất đổi được bố cục
    if (this.setOrientation) await this.setOrientation(next).catch(() => {});
    this.state.landscape = next;
    this.setState({ ready: true, tip: '' });
    return next;
  }

  /** Chuyển sang hướng chỉ định khi cần (toàn màn hình = ngang, cửa sổ = dọc) */
  async setLandscape(want) {
    if (!this.isOpen) return this.state.landscape;
    if (!!this.state.landscape === !!want) return this.state.landscape;
    return this.rotate();
  }

  toggleMaximize() {
    if (!this.isOpen) return;
    if (this.win.isMaximized()) this.win.unmaximize();
    else this.win.maximize();
    this.scheduleFit();
  }

  minimize() { if (this.isOpen) this.win.minimize(); }

  /**
   * Đóng cửa sổ. Mặc định dừng luôn ứng dụng Android này (tiết kiệm bộ nhớ), nhưng giữ engine để lần sau mở tức thì.
   *
   * Thứ tự rất quan trọng: phải "gỡ ra và giấu đi" cửa sổ trình giả lập khỏi cửa sổ chủ trước, rồi mới hủy cửa sổ chủ.
   * Làm ngược lại thì Windows sẽ gắn lại cửa sổ con khác tiến trình lên desktop và giữ nguyên trạng thái hiển thị,
   * trên desktop người dùng sẽ tự dưng xuất hiện một cửa sổ đen "Android Emulator - apkstart5554".
   */
  close({ keepApp = false } = {}) {
    if (!this.isOpen) return;
    const win = this.win;
    const pkg = this.pkg;
    this._syncHook(false);
    this._syncKeymap(false);
    if (!keepApp && pkg && this._onCloseApp) this._onCloseApp(pkg);
    this._selfClose = true;
    this.win = null;
    this.pkg = null;
    const done = () => {
      try { win.destroy(); } catch (_) { /* ignore */ }
      this._selfClose = false;
      this._closing = false;
      if (this._closedCb) this._closedCb(pkg);
    };
    Promise.resolve(this.agent && this.agent.park()).catch(() => {}).then(done, done);
  }

  onCloseApp(cb) { this._onCloseApp = cb; }
}

module.exports = { AppWindow, TITLEBAR_H };
