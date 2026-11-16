'use strict';
/**
 * Dọn phần sót lại của phiên bản cũ.
 *
 * Người dùng nâng cấp ApkStart thường gặp「cài nhiều phiên bản, gỡ không sạch」: bản portable mỗi lần đổi phiên bản lại thêm một
 * thư mục ApkStart-vX.Y.Z-win64-portable; bản cài NSIS sau khi nâng cấp có thể để lại mục gỡ cài đặt
 * trỏ tới thư mục đã xóa; quá trình cập nhật còn để lại một đống gói tạm trong thư mục dữ liệu.
 *
 * Ở đây chỉ dọn những gì **chứng minh được là an toàn**:
 *   - chỉ nhận thư mục phiên bản cũ「thực sự có ApkStart.exe bên trong」, và tuyệt đối không đụng vào bản đang chạy;
 *   - chỉ xóa mục gỡ cài đặt trong registry có「InstallLocation không còn tồn tại」(vốn đã là mục chết);
 *   - chỉ xóa file tạm trong bộ nhớ đệm cập nhật của chính mình và lối tắt Start Menu/desktop trỏ tới đích không tồn tại.
 * Bước nào không chắc chắn thì bỏ qua, và trả nguyên nhân thật về cho giao diện.
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const EXE = 'ApkStart.exe';

function dirSize(p) {
  let n = 0;
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { return; }
    for (const e of list) {
      const f = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(f);
        else n += fs.statSync(f).size;
      } catch (_) { /* bị chiếm/không có quyền, bỏ qua */ }
    }
  };
  walk(p);
  return n;
}

function norm(p) {
  try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); }
}

/**
 * Tìm thư mục phiên bản cũ trong một số thư mục「có thể chứa chương trình」.
 *
 * Trước đây chỉ quét thư mục cha của exe hiện tại + LOCALAPPDATA\Programs + ProgramFiles, kết quả người dùng
 * giải nén bản portable ra nơi khác (E:\Downloads, desktop, thư mục dự án nào đó) thì không bao giờ quét tới —— đây chính là
 * nguyên nhân「không dọn được phiên bản cũ trong thư mục khác」. Giờ dò theo nhiều đường:
 *   - vị trí cài đặt thường gặp;
 *   - tầng nông dưới gốc mỗi ổ đĩa (nhiều bản portable để thẳng ở D:\ApkStart-…);
 *   - thư mục chứa exe thật mà các lối tắt hiện có trên desktop / Start Menu trỏ tới (chính xác nhất, người dùng đã cài thì chắc chắn có).
 */
function candidateRoots(installDir) {
  const roots = new Set();
  const add = (p) => { if (p) roots.add(p); };
  add(path.dirname(installDir));
  const local = process.env.LOCALAPPDATA;
  if (local) add(path.join(local, 'Programs'));
  add(process.env.ProgramFiles);
  add(process.env['ProgramFiles(x86)']);
  const home = os.homedir();
  if (home) {
    add(path.join(home, 'Downloads'));
    add(path.join(home, 'Desktop'));
    add(path.join(home, 'Documents'));
  }
  try {
    for (const drv of ['C:\\', 'D:\\', 'E:\\', 'F:\\', 'G:\\', 'H:\\']) {
      if (fs.existsSync(drv)) add(drv.replace(/\\+$/, ''));
    }
  } catch (_) { /* ignore */ }
  return [...roots];
}

/**
 * Từ lối tắt (.lnk / .desktop) tra ngược thư mục thật chứa ApkStart.exe.
 * Đây là cách dò đáng tin nhất: chỉ cần người dùng từng tạo icon desktop hoặc mục Start Menu, đường dẫn đích nằm trong đó,
 * bất kể nó ở ổ nào, thư mục sâu đến đâu.
 */
function rootsFromShortcuts() {
  const dirs = new Set();
  const homes = [os.homedir(), process.env.APPDATA, process.env.LOCALAPPDATA]
    .filter(Boolean);
  const linkDirs = [];
  for (const h of homes) {
    linkDirs.push(path.join(h, 'Desktop'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs'));
    linkDirs.push(path.join(h, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'ApkStart'));
  }
  for (const d of linkDirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!/\.(lnk|desktop)$/i.test(e.name)) continue;
      const full = path.join(d, e.name);
      try {
        if (/\.desktop$/i.test(e.name)) {
          const txt = fs.readFileSync(full, 'utf8');
          const m = /^Exec=(.+)$/m.exec(txt);
          if (m) {
            const exePath = m[1].trim().replace(/^"|"$/g, '').split(/\s+/)[0];
            if (exePath && /[\\/]ApkStart(\.exe)?$/i.test(exePath)) dirs.add(path.dirname(exePath));
          }
        } else {
          // .lnk là nhị phân, nhưng đường dẫn đích được nhúng ở dạng đọc được, quét thẳng ApkStart*.exe trong byte
          const buf = fs.readFileSync(full);
          const s = buf.toString('latin1');
          const re = /[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart(?:-[^\x00\x01-\x1f]*)?[\\/]?ApkStart\.exe|[A-Za-z]:\\[^\x00\x01-\x1f]*?ApkStart\.exe/gi;
          let mm;
          while ((mm = re.exec(s))) {
            dirs.add(path.dirname(mm[0].replace(/\x00.*$/, '')));
          }
        }
      } catch (_) { /* không đọc được thì bỏ qua */ }
    }
  }
  return [...dirs];
}

/** Thư mục chương trình phiên bản cũ: dạng ApkStart*, bên trong có ApkStart.exe, và không phải thư mục cài đặt hiện tại */
function scanDirs(installDir) {
  const out = [];
  const seen = new Set();
  const cur = norm(installDir);
  const consider = (full) => {
    const key = norm(full);
    if (seen.has(key)) return;
    seen.add(key);
    if (key === cur) return;
    // Phải là thư mục「thật sự là ApkStart」, tránh xóa nhầm thư mục trùng tên
    if (!fs.existsSync(path.join(full, EXE))) return;
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: 'Thư mục chương trình phiên bản cũ (chứa ' + EXE + ')',
    });
  };
  for (const root of candidateRoots(installDir)) {
    let list = [];
    try { list = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      if (!e.isDirectory()) continue;
      if (!/^ApkStart/i.test(e.name)) continue;
      consider(path.join(root, e.name));
    }
  }
  // Thư mục tra ngược từ lối tắt: bản thân có thể là thư mục phiên bản cũ, hoặc thư mục cha/con của nó là
  for (const d of rootsFromShortcuts()) {
    if (/^ApkStart/i.test(path.basename(d))) consider(d);
    // Xem cả các thư mục cùng cấp (dưới dist thường có nhiều thư mục phiên bản nằm cạnh nhau)
    const parent = path.dirname(d);
    let sib = [];
    try { sib = fs.readdirSync(parent, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of sib) {
      if (e.isDirectory() && /^ApkStart/i.test(e.name)) consider(path.join(parent, e.name));
    }
  }
  return out;
}

/** Mục gỡ cài đặt trong registry trỏ tới thư mục không còn tồn tại */
function scanRegistry() {
  const out = [];
  const roots = [
    'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ];
  for (const root of roots) {
    let text = '';
    try {
      text = execFileSync('reg', ['query', root, '/s', '/f', 'ApkStart', '/t', 'REG_SZ'],
        { encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 4 * 1024 * 1024 });
    } catch (_) { continue; }
    // Đầu ra reg query chia thành khối「khóa → giá trị」, ở đây cắt theo khối
    const blocks = String(text).split(/\r?\n\r?\n/);
    for (const b of blocks) {
      const key = (/^(HKEY_[^\r\n]+)$/m.exec(b) || [])[1];
      if (!key) continue;
      if (!/\\ApkStart/i.test(key)) continue;
      const loc = (/InstallLocation\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const disp = (/DisplayName\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const unins = (/UninstallString\s+REG_\w+\s+(.+)/i.exec(b) || [])[1];
      const install = (loc || '').trim().replace(/^"|"$/g, '');
      const uninsPath = (unins || '').trim().replace(/^"|"$/g, '');
      const installMissing = install ? !fs.existsSync(install) : false;
      // Chỉ xử lý mục chết「rõ ràng không còn cài mà vẫn treo trong danh sách ứng dụng」
      const deadUninstaller = uninsPath && !fs.existsSync(uninsPath.split('"')[0]);
      if (!installMissing && !deadUninstaller) continue;
      out.push({
        kind: 'registry',
        path: key,
        size: 0,
        note: `Mục gỡ cài đặt không còn hiệu lực${disp ? `: ${String(disp).trim()}` : ''}`,
      });
    }
  }
  return out;
}

/** Bộ nhớ đệm cập nhật / gói tạm */
function scanTemp(dataDir) {
  const out = [];
  const dirs = [path.join(dataDir, 'update'), os.tmpdir()];
  for (const d of dirs) {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch (_) { continue; }
    for (const e of list) {
      const name = e.name;
      const isOurs = /^ApkStart.*\.(zip|exe|part\d*|tmp)$/i.test(name)
        || /^ApkStart-.*\.part\d+$/i.test(name);
      if (!isOurs) continue;
      const full = path.join(d, name);
      let size = 0;
      try { size = e.isDirectory() ? dirSize(full) : fs.statSync(full).size; } catch (_) { /* ignore */ }
      out.push({ kind: 'temp', path: full, size, note: 'File tạm tải về khi cập nhật' });
    }
  }
  return out;
}

/** Snapshot khởi động nhanh cũ/bỏ đi: default_boot do bản đầu để lại (một ram.img khoảng 3GB),
 *  *.stale-* là phần sót lại kiểu「không xóa được thì đổi tên」. Snapshot hiện tại tên là apkstart, tuyệt đối không đụng. */
function scanSnapshots(avdHome) {
  const out = [];
  if (!avdHome) return out;
  const snapDir = path.join(avdHome, 'apkstart.avd', 'snapshots');
  let list = [];
  try { list = fs.readdirSync(snapDir, { withFileTypes: true }); } catch (_) { return out; }
  for (const e of list) {
    if (!e.isDirectory()) continue;
    if (e.name === 'apkstart') continue;   // snapshot đang dùng
    const full = path.join(snapDir, e.name);
    out.push({
      kind: 'dir',
      path: full,
      size: dirSize(full),
      note: e.name.startsWith('default_boot') ? 'Snapshot khởi động nhanh do bản cũ để lại' : 'Phần sót lại của snapshot bỏ đi',
    });
  }
  return out;
}

function scan({ installDir, dataDir, avdHome }) {
  const items = [];
  const push = (list) => { for (const x of list) items.push(x); };
  push(scanDirs(installDir));
  push(scanRegistry());
  push(scanTemp(dataDir));
  push(scanSnapshots(avdHome));
  const total = items.reduce((n, x) => n + (x.size || 0), 0);
  return { items, totalBytes: total };
}

function rm(p) {
  try {
    fs.rmSync(p, { recursive: true, force: true });
    return true;
  } catch (_) { return false; }
}

function clean(items, { installDir }) {
  const cur = norm(installDir);
  let freed = 0;
  const removed = [];
  const failed = [];
  for (const it of items || []) {
    try {
      if (it.kind === 'dir') {
        // Bảo hiểm kép: tuyệt đối không xóa thư mục đang chạy
        if (norm(it.path) === cur) { failed.push({ path: it.path, reason: 'Đây là phiên bản đang chạy' }); continue; }
        if (!fs.existsSync(path.join(it.path, EXE))) { failed.push({ path: it.path, reason: 'Trong thư mục không có ' + EXE }); continue; }
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'File đang bị chiếm (có thể còn cửa sổ đang mở)' });
      } else if (it.kind === 'registry') {
        const r = execFileSync('reg', ['delete', it.path, '/f'], { windowsHide: true, timeout: 10000 });
        void r;
        removed.push(it.path);
      } else if (it.kind === 'temp') {
        if (rm(it.path)) { freed += it.size || 0; removed.push(it.path); }
        else failed.push({ path: it.path, reason: 'File đang bị chiếm' });
      } else if (it.kind === 'shortcut') {
        if (rm(it.path)) removed.push(it.path);
        else failed.push({ path: it.path, reason: 'Xóa thất bại' });
      }
    } catch (e) {
      failed.push({ path: it.path, reason: e.message });
    }
  }
  return { removed, failed, freedBytes: freed };
}

module.exports = { scan, clean };
