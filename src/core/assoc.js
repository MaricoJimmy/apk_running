'use strict';
/**
 * Liên kết file .apk (chỉ ghi HKCU, không cần quyền quản trị)
 * Nhấp đúp apk → apkstart.exe "%1" → tự cài đặt → tự tạo lối tắt trên desktop
 */
const { execFileSync } = require('child_process');

const PROGID = 'ApkStart.apk';
const EXT = '.apk';
const CLASSES = 'HKCU\\Software\\Classes';
//「Chương trình mặc định cũ」trước khi liên kết được ghi ở đây, khi gỡ cài đặt sẽ trả lại nguyên vẹn, đừng làm mất liên kết của người dùng
const STORE_KEY = 'HKCU\\Software\\ApkStart';
const PREV_VALUE = 'assocPrev';

function reg(args) {
  try {
    execFileSync('reg', args, { windowsHide: true, stdio: 'pipe' });
    return true;
  } catch (_) {
    return false;
  }
}

/** Đọc giá trị mặc định của một khóa (REG_SZ), không đọc được thì trả chuỗi rỗng */
function regDefault(key) {
  try {
    const out = execFileSync('reg', ['query', key, '/ve'], { windowsHide: true, encoding: 'utf8' });
    const line = String(out).split(/\r?\n/).find((l) => /REG_SZ/i.test(l));
    const m = line && /REG_SZ\s+(.*)$/i.exec(line);
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

/** Đọc「giá trị mặc định trước khi liên kết」mà ta đã ghi lại */
function readPrev() {
  try {
    const out = execFileSync('reg', ['query', STORE_KEY, '/v', PREV_VALUE], { windowsHide: true, encoding: 'utf8' });
    const m = /REG_SZ\s+(.*)$/im.exec(String(out));
    return m ? m[1].trim() : '';
  } catch (_) {
    return '';
  }
}

function notifyShell() {
  const ps = `
$sig = '[DllImport("shell32.dll")] public static extern void SHChangeNotify(int eventId, int flags, IntPtr item1, IntPtr item2);';
try {
  $t = Add-Type -MemberDefinition $sig -Name 'ShNotify' -Namespace 'ApkStart' -PassThru -ErrorAction Stop;
  $t::SHChangeNotify(0x08000000, 0x0000, [IntPtr]::Zero, [IntPtr]::Zero);
} catch {}
`;
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      windowsHide: true, stdio: 'pipe', timeout: 8000,
    });
  } catch (_) { /* thông báo thất bại không ảnh hưởng bản thân việc liên kết */ }
}

/**
 * @param {string} exePath đường dẫn chương trình chính apkstart (ở chế độ dev là electron.exe)
 * @param {string} [iconPath] ico tùy chọn
 * @param {string} [extraArgs] ở chế độ dev cần truyền thư mục app trước, ví dụ "\"C:\\path\\apkstart\""
 */
function registerAssociation(exePath, iconPath, extraArgs) {
  const icon = iconPath || exePath;
  const command = `"${exePath}" ${extraArgs ? extraArgs + ' ' : ''}"%1"`;

  // Ghi nhớ chương trình mặc định của .apk trước khi liên kết: khi người dùng vốn đã cài công cụ Android khác, gỡ ApkStart
  // xong nên trả lại cho họ, chứ không biến .apk thành「không có chương trình mặc định」.
  const prev = regDefault(`${CLASSES}\\${EXT}`);
  if (prev && prev !== PROGID) {
    reg(['add', STORE_KEY, '/v', PREV_VALUE, '/d', prev, '/f']);
  } else if (!prev) {
    try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* vốn dĩ không có */ }
  }

  reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', PROGID, '/f']);
  reg(['add', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/t', 'REG_NONE', '/f']);

  reg(['add', `${CLASSES}\\${PROGID}`, '/ve', '/d', 'Gói ứng dụng Android', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}`, '/v', 'FriendlyTypeName', '/d', 'Gói ứng dụng Android', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\DefaultIcon`, '/ve', '/d', `"${icon}",0`, '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open`, '/ve', '/d', 'Cài vào ApkStart', '/f']);
  reg(['add', `${CLASSES}\\${PROGID}\\shell\\open\\command`, '/ve', '/d', command, '/f']);

  notifyShell();
  return { ok: true, progId: PROGID, previous: prev };
}

/**
 * Hủy liên kết.
 * Bản cũ vô điều kiện xóa trống giá trị mặc định của .apk (chú thích ghi「chỉ khi vẫn trỏ về chính chúng ta」, nhưng code không làm),
 * người dùng gỡ ApkStart sẽ xóa luôn liên kết .apk vốn có. Giờ:
 *  1) Có bản ghi trước khi liên kết → khôi phục nguyên vẹn;
 *  2) Không có bản ghi và giá trị mặc định hiện tại vẫn là của ta → mới xóa trống;
 *  3) Giá trị mặc định hiện tại là của người khác → không đụng một byte nào.
 */
function unregisterAssociation() {
  reg(['delete', `${CLASSES}\\${EXT}\\OpenWithProgids`, '/v', PROGID, '/f']);
  reg(['delete', `${CLASSES}\\${PROGID}`, '/f']);

  const prev = readPrev();
  const current = regDefault(`${CLASSES}\\${EXT}`);
  let restored = '';
  if (prev) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', prev, '/f']);
    restored = prev;
  } else if (current === PROGID) {
    reg(['add', `${CLASSES}\\${EXT}`, '/ve', '/d', '', '/f']);
  }
  try { execFileSync('reg', ['delete', STORE_KEY, '/v', PREV_VALUE, '/f'], { windowsHide: true, stdio: 'pipe' }); } catch (_) { /* ignore */ }
  notifyShell();
  return { ok: true, restored };
}

module.exports = { registerAssociation, unregisterAssociation, PROGID };
