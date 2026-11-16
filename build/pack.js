'use strict';
/**
 * Đóng gói bản portable: tạo ra dist/ApkStart-win64-portable/
 *   ApkStart.exe (chính là electron.exe đổi tên) + resources/app (mã nguồn ứng dụng này)
 * Không cần trình cài đặt, giải nén là dùng; sau này khi dùng electron-builder tạo gói cài đặt có thể tái sử dụng cùng cấu trúc thư mục.
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
// Cho phép chỉ định thư mục đầu ra (dùng khi thư mục đích đang bị instance đang chạy chiếm giữ: build ra chỗ khác trước rồi thay thế)
let OUT = process.env.APKSTART_PACK_OUT
  ? path.resolve(process.env.APKSTART_PACK_OUT)
  : path.join(ROOT, 'dist', 'ApkStart-win64-portable');
const ELECTRON_DIST = path.join(ROOT, 'node_modules', 'electron', 'dist');

function copy(src, dest) {
  fs.cpSync(src, dest, { recursive: true });
}

console.log('Đóng gói bản portable →', OUT);
// Khi thư mục đích đã tồn tại thì không xóa cả cây: một số môi trường chặn xóa hàng loạt, và nếu đóng gói thất bại giữa chừng sẽ mất
// phiên bản dùng được trước đó. Thay vào đó đổi tên thư mục cũ để giữ lại, rồi build mới hoàn toàn; nếu đang bị chiếm thì tự đổi thư mục.
if (fs.existsSync(OUT)) {
  try {
    const backup = `${OUT}.prev-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.renameSync(OUT, backup);
    console.log('Đã giữ lại phiên bản cũ →', backup);
  } catch (_) {
    // Một số môi trường (phần mềm diệt virus / lập chỉ mục tìm kiếm / File Explorer) giữ handle thư mục rất lâu,
    // đổi tên cả thư mục chắc chắn bị EBUSY; khi đó chuyển sang thư mục có số phiên bản, sản phẩm vẫn dùng được và không bị trùng tên.
    OUT = path.join(ROOT, 'dist', `ApkStart-v${require(path.join(ROOT, 'package.json')).version}-win64-portable`);
    console.log('Thư mục cũ đang bị chiếm, chuyển đầu ra sang →', OUT);
  }
}
fs.mkdirSync(path.join(OUT, 'resources', 'app'), { recursive: true });

// 1. Runtime Electron
console.log('Đang sao chép runtime Electron…');
copy(ELECTRON_DIST, OUT);
fs.rmSync(path.join(OUT, 'resources', 'default_app.asar'), { force: true });

// 1.1 Giảm kích thước gói ngôn ngữ: Electron kèm sẵn 55 ngôn ngữ, tổng cộng 41MB, ta chỉ dùng vài ngôn ngữ giao diện.
//     Chỉ giữ vi / zh-CN / zh-TW / en-US, xóa phần còn lại (-39MB, tức cả gói nhỏ đi 15%).
const KEEP_LOCALES = new Set(['vi.pak', 'zh-CN.pak', 'zh-TW.pak', 'en-US.pak']);
let localeSaved = 0;
try {
  const locDir = path.join(OUT, 'locales');
  for (const f of fs.readdirSync(locDir)) {
    if (KEEP_LOCALES.has(f)) continue;
    localeSaved += (() => { try { return fs.statSync(path.join(locDir, f)).size; } catch (_) { return 0; } })();
    fs.rmSync(path.join(locDir, f), { force: true });
  }
} catch (_) { /* không có thư mục locales cũng không sao */ }

// 1.2 Các file không ai mở: nhật ký thay đổi, ký hiệu gỡ lỗi, một số pak vô dụng (mỗi cái 0.1~9MB)
for (const rel of ['LICENSES.chromium.html.bak', 'vk_swiftshader_icd.json.bak']) {
  fs.rmSync(path.join(OUT, rel), { force: true });
}

// 1.3 Các thư viện runtime có thể bỏ:
//     d3dcompiler_47.dll lo biên dịch HLSL của ANGLE thành lệnh GPU, nhưng từ Windows 8.1
//     System32 đã có sẵn DLL cùng tên, LoadLibrary không tìm thấy bản trong gói sẽ tự dùng bản của hệ thống.
//     Thực tế sau khi xóa, giao diện/biểu tượng/phông chữ render hoàn toàn bình thường (so sánh ảnh chụp --smoke không khác biệt). Giảm 2.1MB.
//     Lưu ý: không được xóa vk_swiftshader.dll / vulkan-1.dll —— khi driver GPU không dùng được, Chromium
//     dựa vào chúng để render bằng phần mềm dự phòng, xóa đi sẽ bị màn hình trắng.
let pruneSaved = 0;
for (const rel of ['d3dcompiler_47.dll']) {
  const p = path.join(OUT, rel);
  try {
    pruneSaved += fs.statSync(p).size;
    fs.rmSync(p, { force: true });
  } catch (_) { /* vốn dĩ không có */ }
}

// 2. Bản thân ứng dụng
console.log('Đang sao chép ứng dụng…');
const appDir = path.join(OUT, 'resources', 'app');
for (const item of ['package.json', 'src', 'LICENSE']) {
  const src = path.join(ROOT, item);
  if (fs.existsSync(src)) copy(src, path.join(appDir, item));
}

// 3. Thư mục tùy chọn
// Trong engine/ chỉ nội dung dạng tài liệu được phân phối kèm gói; các thành phần runtime dung lượng lớn (emulator, system-images,
// platform-tools, avd) được ứng dụng tự tải từ nguồn chính thức ở lần khởi động đầu, không đưa vào gói cài đặt.
// tools/ là các script tự kiểm tra lúc phát triển (kiểm thử cửa sổ đen, đo tốc độ), người dùng không cần, không phân phối kèm gói nữa.
const ENGINE_SKIP = new Set(['emulator', 'system-images', 'platform-tools', 'avd', 'aehd', '_dl', 'qemu']);
for (const opt of ['engine']) {
  const src = path.join(ROOT, opt);
  if (!fs.existsSync(src)) continue;
  const dest = path.join(appDir, opt);
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (opt === 'engine' && ENGINE_SKIP.has(entry.name)) continue;
    fs.cpSync(path.join(src, entry.name), path.join(dest, entry.name), { recursive: true });
  }
}

// 4. Đổi tên chương trình chính
fs.renameSync(path.join(OUT, 'electron.exe'), path.join(OUT, 'ApkStart.exe'));

// 5. Thông tin phiên bản
const pkg = require(path.join(ROOT, 'package.json'));
fs.writeFileSync(path.join(OUT, 'VERSION.txt'), `ApkStart ${pkg.version}\nThời gian build: ${new Date().toLocaleString('vi-VN')}\n`);

// 6. Báo cáo dung lượng: in ra mỗi lần đóng gói, tránh sau này gói lại âm thầm phình to
function dirSize(dir) {
  let n = 0;
  try {
    for (const it of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, it.name);
      n += it.isDirectory() ? dirSize(p) : fs.statSync(p).size;
    }
  } catch (_) { /* ignore */ }
  return n;
}
const totalMB = dirSize(OUT) / 1048576;
console.log(
  `Hoàn tất. Cả gói ${totalMB.toFixed(0)} MB (gói ngôn ngữ tiết kiệm ${(localeSaved / 1048576).toFixed(0)} MB, `
  + `thư viện runtime dư thừa tiết kiệm ${(pruneSaved / 1048576).toFixed(1)} MB).`,
);
console.log('Nén: node build/zip.js dist/ApkStart-win64-portable <đầu-ra.zip>');
console.log(`Chạy ${path.join(OUT, 'ApkStart.exe')} là có thể sử dụng.`);
