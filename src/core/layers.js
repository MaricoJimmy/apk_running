'use strict';
/**
 * Phân lớp kiểu container: image nền chỉ đọc + runtime tinh gọn + lớp tạm có thể thu hồi
 *
 * Ví dụ (giống Docker):
 *   system-images/  = base layer chỉ đọc, mọi app, mọi phiên dùng chung một bản, tuyệt đối không sao chép
 *   avd/*.avd/      = thin layer ghi được (qcow2 sai phân + snapshot quickboot), chỉ lưu thay đổi
 *   _tmp/ snapshots = scratch layer có thể thu hồi
 *
 * Module này chỉ「kiểm kê」và「thu hồi theo danh sách rõ ràng」, mặc định dryRun, không đụng file cá nhân của người dùng.
 */
const fs = require('fs');
const path = require('path');

function walk(dir, out = [], depth = 0) {
  if (depth > 6) return out;
  let items = [];
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return out; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) walk(p, out, depth + 1);
    else {
      try { out.push({ path: p, size: fs.statSync(p).size }); } catch (_) { /* ignore */ }
    }
  }
  return out;
}

function dirSize(dir) { return walk(dir).reduce((n, f) => n + f.size, 0); }
const exists = (p) => { try { return fs.existsSync(p); } catch (_) { return false; } };

/**
 * Kiểm kê dung lượng runtime, và liệt kê các mục「có thể thu hồi an toàn」.
 * @returns {{total:number, groups:Array, candidates:Array}}
 */
function analyze(root, { keepAvd = 'apkstart.avd', aggressive = false, keepSnapshots = false } = {}) {
  const groups = [];
  const candidates = [];
  if (!exists(root)) return { total: 0, groups, candidates };

  const groupOf = (name, dir) => {
    const size = dirSize(dir);
    groups.push({ name, size });
    return size;
  };
  const add = (p, size, reason, kind = 'file') => candidates.push({ path: p, size, reason, kind });

  groupOf('Engine emulator', path.join(root, 'emulator'));
  groupOf('System image (lớp nền chỉ đọc)', path.join(root, 'system-images'));
  groupOf('Lớp ghi AVD / snapshot', path.join(root, 'avd'));
  groupOf('platform-tools', path.join(root, 'platform-tools'));

  // 1) QEMU chỉ cần một target x86_64; binary của 7 kiến trúc khác trong gói hoàn toàn lãng phí
  const qemuDir = path.join(root, 'emulator', 'qemu', 'windows-x86_64');
  if (exists(qemuDir)) {
    for (const f of walk(qemuDir)) {
      if (/qemu-system-(aarch64|armel|i386)/i.test(path.basename(f.path))) {
        add(f.path, f.size, 'Target QEMU không phải x86_64, runtime không dùng tới');
      }
    }
  }

  // 2) Văn bản giấy phép / thư mục thừa trong gói image
  for (const f of walk(path.join(root, 'system-images'))) {
    if (/^(NOTICE\.txt|source\.properties)$/i.test(path.basename(f.path)) && f.size > 1024 * 1024) {
      add(f.path, f.size, 'File tài liệu dung lượng lớn trong gói image');
    }
  }

  // 3) Chỉ giữ một bản system image: khi image Play API 34 đã sẵn sàng, image cũ API 30 đều hết hạn
  const play34 = path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img');
  if (exists(play34)) {
    const legacy = path.join(root, 'system-images', 'android-30');
    if (exists(legacy)) add(legacy, dirSize(legacy), 'Image API 30 cũ (chứa lớp dịch ARM lỗi thời)', 'dir');
  }
  const stray = path.join(root, 'x86_64');
  if (exists(stray)) add(stray, dirSize(stray), 'Thư mục image trùng lặp do giải nén sai vị trí', 'dir');

  // 4) AVD không hoạt động: sản phẩm chỉ dùng một apkstart; các bản sót lại từ thời test như apkstart-arm / -houdini có thể dọn
  const avdHome = path.join(root, 'avd');
  if (exists(avdHome)) {
    for (const e of fs.readdirSync(avdHome, { withFileTypes: true })) {
      if (!e.isDirectory() || !e.name.endsWith('.avd') || e.name === keepAvd) continue;
      add(path.join(avdHome, e.name), dirSize(path.join(avdHome, e.name)),
        'AVD không hoạt động (chứa image dữ liệu người dùng cũ 8-16GB)', 'dir');
    }
    // 5) File khóa: sót lại sẽ gây「AVD is already running」
    for (const f of walk(avdHome)) {
      if (/\.lock$/i.test(f.path)) add(f.path, f.size, 'File khóa sót lại từ lần thoát bất thường trước');
    }
    // 6) Snapshot khởi động nhanh: ram.img ≈ bộ nhớ cấp cho máy ảo, hỏng hoặc đổi cấu hình thì phải bỏ
    const activeAvd = path.join(avdHome, keepAvd);
    if (exists(activeAvd) && !keepSnapshots) {
      for (const e of fs.readdirSync(activeAvd, { withFileTypes: true })) {
        // Snapshot bình thường + snapshot cũ bị đổi tên khi xóa thất bại, đều có thể thu hồi
        if (!e.isDirectory() || !/^snapshots(\.stale-\d+)?$/.test(e.name)) continue;
        const p = path.join(activeAvd, e.name);
        add(p, dirSize(p), 'Snapshot quickboot cũ (sẽ tự dựng lại sau khi đổi cấu hình)', 'dir');
      }
    }
  }

  // 7) Bộ nhớ đệm tải xuống / ISO QEMU sót lại
  for (const d of ['_tmp', 'images']) {
    const p = path.join(root, d);
    if (exists(p)) {
      const size = dirSize(p);
      if (size > 0) add(p, size, d === '_tmp' ? 'File tạm tải xuống' : 'File QEMU/ISO cũ sót lại', 'dir');
    }
  }

  // 8) Cắt giảm mạnh: chỉ bật khi build gói phát hành.
  // Lưu ý: Qt6WebEngineCoreAndroidEmu.dll là phụ thuộc lúc nạp của qemu-system-x86_64.exe,
  // thực tế xóa đi là không chạy được, tuyệt đối không đưa vào danh sách; qsn/netsim cũng có thể được snapshot và tính năng mạng gọi khi cần, giữ lại cho chắc.
  if (aggressive) {
    const extras = [
      ['emulator/crashreport.exe', 'Công cụ báo cáo crash (chạy headless không cần)'],
    ];
    for (const [rel, reason] of extras) {
      const p = path.join(root, rel);
      if (exists(p)) add(p, fs.statSync(p).size, reason);
    }
  }

  const total = groups.reduce((n, g) => n + g.size, 0);
  return { total, groups, candidates };
}

/**
 * Thu hồi. Bắt buộc truyền rõ apply:true; bên gọi (UI/script build) chịu trách nhiệm hiển thị danh sách và lấy xác nhận trước.
 * Ràng buộc an toàn: mọi đích đều phải nằm trong root, và không được xóa chính root.
 */
function prune(root, { apply = false, keepAvd, aggressive = false, keepSnapshots = false, onRemove = () => {} } = {}) {
  const report = analyze(root, { keepAvd, aggressive, keepSnapshots });
  const rootAbs = path.resolve(root);
  const removed = [];
  let saved = 0;
  for (const c of report.candidates) {
    const p = path.resolve(c.path);
    if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;
    if (!exists(p)) continue;
    if (apply) {
      try {
        fs.rmSync(p, c.kind === 'dir' ? { recursive: true, force: true } : { force: true });
        removed.push(c);
        saved += c.size;
        onRemove(c);
      } catch (_) { /* file đang bị chiếm thì bỏ qua, lần sau dọn tiếp */ }
    }
  }
  return { ...report, apply, removed, saved, after: apply ? report.total - saved : report.total };
}

/** Tóm tắt ngắn cho trang cài đặt */
function summary(root) {
  const a = analyze(root);
  const mb = (n) => (n >= 1048576 * 1024
    ? `${(n / 1073741824).toFixed(2)} GB`
    : `${(n / 1048576).toFixed(0)} MB`);
  // Ngoài thư mục runtime, người dùng quan tâm nhất「thứ này tổng cộng chiếm bao nhiêu ổ đĩa」:
  // AVD (dữ liệu app + snapshot), bộ nhớ đệm APK, icon, log đều được tính vào.
  const store = require('./store');
  const extra = [
    { key: 'avd', label: 'Dữ liệu Android (app + snapshot)', path: path.join(store.DATA_DIR, 'avd') },
    { key: 'apk', label: 'Bộ nhớ đệm gói cài APK', path: store.APK_DIR },
    { key: 'icons', label: 'Bộ nhớ đệm icon desktop', path: store.ICON_DIR },
    { key: 'logs', label: 'Nhật ký', path: path.join(store.DATA_DIR, 'logs') },
  ].map((g) => ({ ...g, size: dirSize(g.path) })).filter((g) => g.size > 0);

  const extraTotal = extra.reduce((n, g) => n + g.size, 0);
  const totalAll = a.total + extraTotal;
  return {
    total: totalAll,
    totalText: mb(totalAll),
    runtimeText: mb(a.total),
    groups: [
      { key: 'runtime', label: 'Runtime (engine + system image)', size: a.total, text: mb(a.total) },
      ...extra.map((g) => ({ ...g, text: mb(g.size) })),
    ],
    reclaimable: a.candidates.reduce((n, c) => n + c.size, 0),
    reclaimableText: mb(a.candidates.reduce((n, c) => n + c.size, 0)),
    count: a.candidates.length,
  };
}

module.exports = { analyze, prune, summary, walk, dirSize };
