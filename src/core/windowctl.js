'use strict';
/**
 * Biến cửa sổ Qt của Android Emulator thành「mỗi app một cửa sổ native」.
 *
 * Vì sao không chiếu màn hình: ở chế độ headless SurfaceFlinger không phát VSYNC (thực tế screenrecord 3 giây chỉ được 2 khung),
 * chiếu màn hình bằng phần mềm vừa giật vừa ăn CPU. Emulator có cửa sổ vốn đã là 60fps native + chuột bàn phím native,
 * ở đây chỉ làm vài thao tác Win32「đổi tiêu đề / đổi icon / đặt kích thước / toàn màn hình」, chi phí gần như bằng 0.
 *
 * PowerShell là thành phần có sẵn của Windows, script là ASCII thuần, tiêu đề không phải ASCII được truyền qua JSON UTF-8,
 * tránh Windows PowerShell 5.1 đọc .ps1 theo ANSI gây lỗi font.
 * Mọi thất bại đều hạ cấp âm thầm: cửa sổ vẫn dùng được, chỉ là không đổi tên/toàn màn hình.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const SCRIPT = path.join(__dirname, 'win', 'windowctl.ps1');
const TIMEOUT = 8000;

function parseOut(text) {
  const out = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const i = line.indexOf('=');
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** @param {object} params { pid, action, title, icon, bounds } */
function call(params) {
  return new Promise((resolve) => {
    if (process.platform !== 'win32' || !fs.existsSync(SCRIPT) || !params || params.pid === undefined) {
      resolve(null);
      return;
    }
    const json = path.join(os.tmpdir(),
      `apkstart-wctl-${crypto.randomBytes(4).toString('hex')}.json`);
    try {
      fs.writeFileSync(json, JSON.stringify(params), 'utf8');
    } catch (_) { resolve(null); return; }

    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-File', SCRIPT, json,
    ], { timeout: TIMEOUT, windowsHide: true, maxBuffer: 1024 * 64 }, (err, stdout) => {
      try { fs.unlinkSync(json); } catch (_) { /* ignore */ }
      if (err) { resolve(null); return; }
      const r = parseOut(stdout);
      resolve(r.OK === '1' ? r : null);
    });
  });
}

/** Đọc vị trí cửa sổ hiện tại, dùng để「ghi nhớ kích thước cửa sổ của từng app」 */
async function getBounds(pid) {
  const r = await call({ pid, action: 'get' });
  if (!r || !Number(r.W) || !Number(r.H)) return null;
  return {
    x: Number(r.X) || 0, y: Number(r.Y) || 0,
    w: Number(r.W), h: Number(r.H),
    maximized: r.MAX === '1',
  };
}

/**
 * Khiến cửa sổ runtime hiển thị như app hiện tại.
 * @param {object} o { pid, label, icon, mode:'window'|'fullscreen', bounds, screen }
 */
async function present(o) {
  const { pid, label, icon, mode, bounds, screen } = o || {};
  // pid=0 là đầu vào hợp lệ: khi dùng lại emulator do tiến trình khác khởi chạy thì không có handle, giao cho script tìm cửa sổ theo tên tiến trình
  if (pid === undefined || pid === null) return null;
  return call({
    pid,
    action: mode === 'fullscreen' ? 'fullscreen' : 'window',
    title: label || '',
    icon: icon && fs.existsSync(icon) ? icon : '',
    bounds: bounds || null,
    screen: mode === 'fullscreen' ? (screen || null) : null,
  });
}

async function focus(pid) { return call({ pid, action: 'focus' }); }

/** Báo Explorer làm mới icon/lối tắt, tránh icon desktop mới tạo phải bấm F5 mới hiện */
async function refreshShell() { return call({ pid: 0, action: 'refresh' }); }

module.exports = { call, getBounds, present, focus, refreshShell, SCRIPT };
