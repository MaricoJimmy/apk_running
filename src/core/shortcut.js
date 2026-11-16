'use strict';
/**
 * Lối tắt desktop + tạo ICO nhiều kích thước
 *
 * ICO dùng thẳng Electron nativeImage để co giãn và tự viết container ICO (định dạng DIB, tương thích mọi phiên bản Windows),
 * không phụ thuộc thư viện ảnh bên thứ ba nào, cũng không cần ImageMagick.
 */
const fs = require('fs');
const path = require('path');

const ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256];

function buildDib(bgra, size) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);           // biSize
  header.writeInt32LE(size, 4);          // biWidth
  header.writeInt32LE(size * 2, 8);      // biHeight = XOR + AND
  header.writeUInt16LE(1, 12);           // biPlanes
  header.writeUInt16LE(32, 14);          // biBitCount
  header.writeUInt32LE(0, 16);           // BI_RGB
  header.writeUInt32LE(size * size * 4, 20);

  // Bitmap XOR: từ dưới lên, trong hàng là BGRA
  const xor = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    const srcRow = (size - 1 - y) * size * 4;
    bgra.copy(xor, y * size * 4, srcRow, srcRow + size * 4);
  }
  // Mặt nạ AND: 1bpp, hàng căn theo 4 byte, toàn 0 (giao cho kênh alpha)
  const maskRow = Math.ceil(size / 32) * 4;
  const mask = Buffer.alloc(maskRow * size, 0);
  return Buffer.concat([header, xor, mask]);
}

/**
 * @param {Buffer} pngBuffer PNG kích thước bất kỳ
 * @returns {Buffer|null} nội dung file ICO
 */
function pngToIco(pngBuffer) {
  const { nativeImage } = require('electron');
  const base = nativeImage.createFromBuffer(pngBuffer);
  if (!base || base.isEmpty()) return null;

  const images = [];
  for (const s of ICO_SIZES) {
    const img = base.getSize().width >= s
      ? base.resize({ width: s, height: s, quality: 'best' })
      : base.resize({ width: s, height: s, quality: 'best' }); // phóng to ảnh nhỏ vẫn hơn thiếu kích thước
    const dib = buildDib(img.toBitmap(), s);
    images.push({ size: s, data: dib });
  }

  const dir = Buffer.alloc(6 + images.length * 16);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(images.length, 4);

  let offset = dir.length;
  images.forEach((img, i) => {
    const p = 6 + i * 16;
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, p);
    dir.writeUInt8(img.size >= 256 ? 0 : img.size, p + 1);
    dir.writeUInt8(0, p + 2);
    dir.writeUInt8(0, p + 3);
    dir.writeUInt16LE(1, p + 4);
    dir.writeUInt16LE(32, p + 6);
    dir.writeUInt32LE(img.data.length, p + 8);
    dir.writeUInt32LE(offset, p + 12);
    offset += img.data.length;
  });

  return Buffer.concat([dir, ...images.map((i) => i.data)]);
}

function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]/g, '_').replace(/\s+/g, ' ').trim().slice(0, 60) || 'Android App';
}

/**
 * PNG-in-ICO: từ Vista mục ICO cho phép nhúng thẳng PNG, không cần mã hóa lại, không mất alpha.
 * Icon APK thường là WebP/PNG kích thước lớn, đường DIB cũ ở đây sẽ thất bại toàn bộ.
 */
function pngBytesToIco(png) {
  if (!Buffer.isBuffer(png) || png.length < 24 || png.toString('ascii', 1, 4) !== 'PNG') return null;
  const w = png.readUInt32BE(16);
  const h = png.readUInt32BE(20);
  if (!w || !h || w > 1024 || h > 1024) return null;
  const dir = Buffer.alloc(22);
  dir.writeUInt16LE(0, 0);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(1, 4);
  dir.writeUInt8(w >= 256 ? 0 : w, 6);
  dir.writeUInt8(h >= 256 ? 0 : h, 7);
  dir.writeUInt8(0, 8);
  dir.writeUInt8(0, 9);
  dir.writeUInt16LE(1, 10);
  dir.writeUInt16LE(32, 12);
  dir.writeUInt32LE(png.length, 14);
  dir.writeUInt32LE(22, 18);
  return Buffer.concat([dir, png]);
}

/**
 * Icon APK bất kỳ → ICO. Ba tầng dự phòng, đảm bảo lối tắt luôn có icon:
 *  1) Electron giải mã trực tiếp được (PNG/JPEG thật) → ICO DIB nhiều kích thước;
 *  2) callback decode (renderer dùng Chromium giải mã WebP) → PNG-in-ICO;
 *  3) icon giữ chỗ thương hiệu → PNG-in-ICO.
 */
async function iconToIco(raw, { decode, onFallback } = {}) {
  const fail = (why) => { try { if (onFallback) onFallback(why); } catch (_) { /* ignore */ } };
  if (!Buffer.isBuffer(raw) || !raw.length) { fail('empty'); return null; }
  try {
    const { nativeImage } = require('electron');
    const img = nativeImage.createFromBuffer(raw);
    if (img && !img.isEmpty()) {
      const ico = pngToIco(img.toPNG());
      if (ico) return ico;
    }
  } catch (_) { /* không phải PNG/JPEG, chuyển tầng tiếp theo */ }

  if (typeof decode === 'function') {
    try {
      const png = await decode(raw);
      const ico = pngBytesToIco(png);
      if (ico) return ico;
      fail('decode-output-invalid');
    } catch (_) { fail('webp-decode-failed'); }
  } else {
    fail('no-decoder');
  }
  try {
    const { drawAppIcon } = require('./png');
    const ico = pngBytesToIco(drawAppIcon(256));
    if (ico) { fail('placeholder'); return ico; }
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Tạo lối tắt desktop
 *
 * writeShortcutLink trả về true không có nghĩa file thật sự đã ghi xuống đĩa: phần mềm bảo mật chặn,
 * thư mục desktop bị chuyển hướng sang ổ mạng chưa đăng nhập đều có thể「thành công mà không có file」. Vì vậy ghi xong phải
 * đọc lại một lần, đảm bảo đường dẫn bên gọi nhận được là lối vào thực sự tồn tại.
 *
 * @param {object} opt { shortcutPath, target, args, iconIcoPath, description, cwd }
 */
function writeShortcut(opt) {
  const { shell } = require('electron');
  const dir = path.dirname(opt.shortcutPath);
  try {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`Thư mục lối tắt không ghi được: ${dir} (${e.message})`);
  }
  if (fs.existsSync(opt.shortcutPath)) {
    try { fs.unlinkSync(opt.shortcutPath); } catch (_) { /* ignore */ }
  }
  const ok = shell.writeShortcutLink(opt.shortcutPath, 'create', {
    target: opt.target,
    args: opt.args || '',
    icon: opt.iconIcoPath || opt.target,
    iconIndex: 0,
    description: opt.description || '',
    cwd: opt.cwd || path.dirname(opt.target),
    appUserModelId: opt.appUserModelId,
  });
  if (!ok) throw new Error('Tạo lối tắt thất bại (writeShortcutLink trả về false)');
  if (!fs.existsSync(opt.shortcutPath)) {
    throw new Error(`Lối tắt chưa được ghi xuống đĩa: ${opt.shortcutPath}`);
  }
  return opt.shortcutPath;
}

function removeShortcut(p) {
  try {
    if (p && fs.existsSync(p)) fs.unlinkSync(p);
    return true;
  } catch (_) {
    return false;
  }
}

module.exports = {
  pngToIco, pngBytesToIco, iconToIco,
  writeShortcut, removeShortcut, safeFileName, ICO_SIZES,
};
