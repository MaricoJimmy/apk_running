'use strict';
/**
 * Lớp phủ map phím: một cửa sổ Electron trong suốt đặt khớp trên vùng hình của cửa sổ game.
 *
 * Vì sao phải là cửa sổ riêng: vùng hình là cửa sổ Qt của emulator được nhúng bằng SetParent (cửa sổ con native),
 * HTML trong cửa sổ app không vẽ đè lên được. Cửa sổ con có `parent` luôn nằm trên cửa sổ chủ và các cửa sổ con của nó.
 *
 *  - play: chỉ vẽ nhãn phím mờ, xuyên chuột (setIgnoreMouseEvents), không nhận focus.
 *  - edit: nhận chuột + bàn phím để kéo thả / gán phím (trình chỉnh, src/ui/keymap.html).
 */
const { BrowserWindow } = require('electron');
const path = require('path');

class KeymapOverlay {
  constructor({ parent }) {
    this.parent = parent;
    this.mode = null;
    this.payload = null;
    this.win = new BrowserWindow({
      parent,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      skipTaskbar: true,
      hasShadow: false,
      focusable: false,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: path.join(__dirname, '..', 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        spellcheck: false,
      },
    });
    this.win.loadFile(path.join(__dirname, '..', 'ui', 'keymap.html'));
    this.win.webContents.on('did-finish-load', () => this._push());
  }

  get isEditing() { return this.mode === 'edit' && this.isVisible; }

  get isVisible() { return !!(this.win && !this.win.isDestroyed() && this.win.isVisible()); }

  /**
   * @param {'play'|'edit'} mode
   * @param {object} payload dữ liệu cho trang: { profile, template, labels, disableKey, landscape }
   */
  show(mode, payload) {
    if (!this.win || this.win.isDestroyed()) return;
    this.mode = mode;
    this.payload = payload;
    const edit = mode === 'edit';
    this.win.setIgnoreMouseEvents(!edit);
    this.win.setFocusable(edit);
    this._push();
    if (edit) { this.win.show(); this.win.focus(); } else this.win.showInactive();
  }

  hide() {
    if (!this.win || this.win.isDestroyed()) return;
    this.mode = null;
    this.win.hide();
  }

  /** rect = vùng hình LCD trên màn hình (DIP) */
  setBounds(rect) {
    if (!this.win || this.win.isDestroyed() || !rect || rect.width < 10 || rect.height < 10) return;
    this.win.setBounds({
      x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height),
    });
  }

  _push() {
    if (!this.win || this.win.isDestroyed() || !this.mode) return;
    this.win.webContents.send('keymap:mode', { mode: this.mode, ...(this.payload || {}) });
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
  }
}

module.exports = { KeymapOverlay };
