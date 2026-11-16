'use strict';
/**
 * Tinh gọn runtime: xóa các file trong trình giả lập mà "cách khởi động của chúng ta không bao giờ nạp".
 *
 * Căn cứ là các tham số khởi động cố định trong emulator.js:
 *   - Chỉ kèm ảnh x86_64 (API30 AOSP)          → không cần qemu-system-aarch64.exe
 *   - -gpu software (render mềm swiftshader)   → không cần backend vulkan / gles_angle
 *   - Giao diện chỉ giữ thanh tiêu đề 38px     → không cần gói đa ngôn ngữ, bảng WebEngine của giao diện giả lập
 *
 * Các thành phần mạng netsimd / netsim / nimble_bridge nhất định phải giữ:
 * chúng lo đường dữ liệu wifi / bluetooth, xóa đi thì ứng dụng không vào mạng được, đây là mức tối thiểu để "chạy được".
 *
 * Cách dùng:
 *   node build/slim-runtime.js build/runtime          # mức an toàn (mặc định)
 *   node build/slim-runtime.js build/runtime --aggressive   # xóa thêm QtWebEngine (-169MB)
 *   node build/slim-runtime.js build/runtime --dry-run
 */
const fs = require('fs');
const path = require('path');

/**
 * Mức an toàn: xóa những thứ chắc chắn không được nạp (khoảng -190MB).
 * Ranh giới đã được xác nhận bằng thực nghiệm khôi phục từng mục (quan trọng, đừng thêm bừa):
 *   - Qt6WebEngineCoreAndroidEmu.dll là phụ thuộc cứng của emulator.exe (import tĩnh), xóa đi là không khởi động được → giữ lại
 *   - lib64/gles_angle cung cấp vk_swiftshader, render mềm swiftshader phụ thuộc vào nó → giữ lại
 *   - xóa lib64/vulkan chỉ khiến lùi về render mềm (đã thực nghiệm khởi động + render bình thường), nhưng giữ lại cũng không lớn → xóa tiết kiệm 103MB
 */
const SAFE = [
  ['emulator/qemu/windows-x86_64/qemu-system-aarch64.exe', 'Binary QEMU cho arm64 (chỉ phát hành ảnh x86_64)'],
  // Lưu ý: không được xóa cả thư mục emulator/lib64/vulkan —— vulkan-1.dll là trình nạp của -gpu host,
  // xóa đi thì host thất bại ngay, chỉ còn render phần mềm (thực tế trên AMD 780M bắt buộc phải giữ). Chỉ xóa các file lớn:
  ['emulator/lib64/vulkan/layers', 'Lớp kiểm tra Vulkan (render host không cần, -20MB)'],
  ['emulator/lib64/vulkan/glslangValidator.exe', 'Công cụ kiểm tra shader (lúc chạy không cần, -7MB)'],
  ['emulator/lib64/vulkan/libvulkan_lvp.dll', 'Vulkan phần mềm dự phòng lavapipe (không cần khi có driver card đồ họa, -53MB)'],
  ['emulator/lib64/vulkan/lvp_icd.json', 'Mô tả ICD của lavapipe (-1KB)'],
  ['emulator/lib64/vulkan/vk_swiftshader.dll', 'SwiftShader Vulkan (thư mục gles_angle có bản sao giống hệt, -23MB)'],
  ['emulator/lib64/qt/translations', 'Gói đa ngôn ngữ của giao diện trình giả lập (chỉ còn thanh tiêu đề 38px)'],
  // Lưu ý: không được xóa emulator-check.exe —— emulator -accel-check dựa vào nó để phát hiện AEHD/WHPX,
  // thiếu nó sẽ bị coi là "không có tăng tốc phần cứng" và lùi về giả lập phần mềm TCG (thực tế khởi động từ 42s thành hơn 10 phút).
  ['emulator/qsn.exe', 'Trình hỗ trợ thông báo snapshot QEMU (emulator.exe không tham chiếu tới, đã kiểm chứng bằng strings, -34MB)'],
  ['emulator/resources/Toren1BD_Main.png', 'Texture môi trường toàn cảnh VR (Hongguo không cần, -3.7MB)'],
  ['emulator/resources/Toren1BD_Decor.png', 'Texture trang trí toàn cảnh VR (-3.5MB)'],
  ['emulator/resources/Toren1BD.obj', 'Mô hình 3D toàn cảnh VR (-3.5MB)'],
  ['emulator/resources/macroPreviews', 'Ảnh xem trước thao tác macro (-2.7MB)'],
  ['emulator/resources/default360.mp4', 'Video toàn cảnh 360° mặc định (-2.4MB)'],
];

/** Mức mạnh tay hiện để trống: WebEngine là phụ thuộc cứng, gles_angle là phụ thuộc của render mềm, đều không dám xóa */
const AGGRESSIVE = [];

function sizeOf(p) {
  let s = 0;
  try {
    const st = fs.statSync(p);
    if (!st.isDirectory()) return st.size;
    for (const e of fs.readdirSync(p, { withFileTypes: true })) s += sizeOf(path.join(p, e.name));
  } catch (_) { /* bỏ qua */ }
  return s;
}

function slim(root, { aggressive = false, dryRun = false, log = console.log } = {}) {
  if (!fs.existsSync(path.join(root, 'emulator', 'emulator.exe'))) {
    throw new Error(`${root} không phải thư mục runtime (thiếu emulator/emulator.exe)`);
  }
  const list = aggressive ? SAFE.concat(AGGRESSIVE) : SAFE;
  let freed = 0;
  for (const [rel, why] of list) {
    const p = path.join(root, rel);
    if (!fs.existsSync(p)) continue;
    const n = sizeOf(p);
    if (!dryRun) {
      try {
        fs.rmSync(p, { recursive: true, force: true });
      } catch (e) {
        log(`  Bỏ qua ${rel}: ${e.message}`);
        continue;
      }
    }
    freed += n;
    log(`  Xóa ${rel} (${(n / 1048576).toFixed(0)} MB) — ${why}`);
  }
  log(`${dryRun ? 'Có thể giải phóng' : 'Đã giải phóng'} ${(freed / 1048576).toFixed(0)} MB`);
  return freed;
}

module.exports = { slim };

if (require.main === module) {
  const root = path.resolve(process.argv[2] || path.join(__dirname, 'runtime'));
  const aggressive = process.argv.includes('--aggressive');
  const dryRun = process.argv.includes('--dry-run');
  console.log(`Mục tiêu tinh gọn: ${root} (mức ${aggressive ? 'mạnh tay' : 'an toàn'})`);
  slim(root, { aggressive, dryRun });
}
