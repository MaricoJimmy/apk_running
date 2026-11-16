'use strict';
/**
 * Ghi log nhẹ + xoay vòng.
 *
 * Trước đây app.log / emulator.log chỉ append, dùng lâu sẽ lớn mãi:
 * log kernel mỗi lần emulator khởi động đã vài chục KB, một ngày bật tắt hơn chục lần, cộng thêm
 * output verbose của qemu, vài tháng là vài trăm MB —— ổ đĩa bị ăn dần âm thầm như vậy đó.
 * Ở đây xoay vòng theo kích thước, chỉ giữ một bản sao lưu .1.log, giới hạn do「giới hạn log」trong cài đặt quyết định.
 */
const fs = require('fs');
const path = require('path');

const counters = new Map();

function rotate(file, limitKB) {
  try {
    const st = fs.statSync(file);
    if (st.size < limitKB * 1024) return false;
    const bak = file.replace(/\.log$/i, '.1.log');
    // Khi tên file không kết thúc bằng .log thì bak sẽ trùng file gốc: xóa trước rồi rename là mất luôn log.
    // Bỏ qua rõ ràng trường hợp biên này, thà log lớn một chút cũng không được mất.
    if (path.resolve(bak) === path.resolve(file)) return false;
    try { fs.rmSync(bak, { force: true }); } catch (_) { /* ignore */ }
    fs.renameSync(file, bak);
    return true;
  } catch (_) {
    return false;
  }
}

/**
 * @param {string} file log đích
 * @param {string} line một dòng nội dung (tự thêm xuống dòng)
 * @param {number} [limitKB] vượt kích thước này thì xoay vòng
 */
function append(file, line, limitKB = 2048) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const n = (counters.get(file) || 0) + 1;
    counters.set(file, n);
    // Kiểm tra một lần mỗi khi tiến trình khởi động, sau đó cứ 200 dòng kiểm tra một lần (statSync rất rẻ, nhưng không cần làm mỗi dòng)
    if (n === 1 || n % 200 === 0) rotate(file, Math.max(256, Number(limitKB) || 2048));
    fs.appendFileSync(file, line.endsWith('\n') ? line : `${line}\n`);
    return true;
  } catch (_) {
    return false;
  }
}

/** Dọn dẹp khi khởi động: xoay vòng trước các log quá lớn (không xét bộ đếm) */
function trimNow(file, limitKB = 2048) {
  return rotate(file, Math.max(256, Number(limitKB) || 2048));
}

module.exports = { append, rotate, trimNow };
