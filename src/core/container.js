'use strict';
/**
 * Container cấp ứng dụng (lớp tính toán thuần)
 *
 * Nền tảng của ApkStart là máy ảo QEMU toàn hệ thống, không thể như WSA / Zhuoyitong「chỉ nạp vài dịch vụ hệ thống
 * mà một App cần」—— nhân Linux, zygote, system_server bắt buộc phải khởi động trọn gói.
 * Nhưng cảm giác「nặng」mà người dùng thực sự thấy không đến từ các dịch vụ thường trú này, mà đến từ:
 *   1. Mỗi lần mở một App lại khởi động lại toàn bộ Android (khởi động nguội 40~142 giây, CPU/đĩa chạy hết công suất);
 *   2. Các App đã mở trước đó vẫn ở nền tiếp tục ăn bộ nhớ, dùng mạng, giữ wake lock;
 *   3. Khi không có App nào ở tiền cảnh, qemu vẫn chạy ở ưu tiên Normal và tranh CPU với desktop;
 *   4. Đồng bộ file, thăm dò thông báo vẫn chạy ngay cả khi không có App nào mở.
 *
 * Ở đây biến những phần thực sự cắt được thành các lệnh có thể điều phối và unit test:
 *   - Môi trường chỉ khởi động một lần, sau đó「mở App」= am start + gắn cửa sổ (do Runtime.beginApp đảm nhiệm);
 *   - Khi mở App mới thì dừng tiến trình của các App người dùng khác, chỉ giữ môi trường mà App hiện tại cần;
 *   - Khi đóng App cuối cùng thì cho Android vào idle, dọn tiến trình nền, hạ ưu tiên qemu;
 *   - Gói hệ thống mặc định không đụng vào (dừng GMS sẽ khiến App phụ thuộc push/đăng nhập liên tục báo lỗi),
 *     chỉ khi người dùng bật rõ ràng「cắt giảm sâu」mới vô hiệu hóa một nhóm nhỏ gói nền rõ ràng vô dụng.
 *
 * File này không phụ thuộc adb / Electron, toàn bộ là hàm thuần, tiện cho kiểm thử hồi quy.
 */

/** Trong mọi trường hợp đều không được cắt: đụng vào chúng sẽ trực tiếp gây màn hình đen hoặc app crash */
const NEVER_TRIM = [
  'android',
  'com.android.systemui',
  'com.android.settings',
  'com.android.inputmethod.latin',
  'com.google.android.inputmethod.latin',
  'com.android.webview',
  'com.google.android.webview',
  'com.google.android.gms',
  'com.google.android.gsf',
  'com.android.providers.settings',
  'com.android.server.telecom',
];

/** Chỉ「cắt giảm sâu」mới vô hiệu hóa: các gói này chỉ cập nhật nền/hình nền/in ấn, dừng lại không ảnh hưởng việc mở App */
const OPTIONAL_SYSTEM = [
  'com.android.vending',                    // Play Store (quét cập nhật nền)
  'com.google.android.setupwizard',         // trình hướng dẫn thiết lập lần đầu
  'com.android.printspooler',               // dịch vụ in
  'com.android.wallpapercropper',
  'com.android.dreams.basic',               // trình bảo vệ màn hình
  'com.android.providers.calendar',
  'com.android.providers.contacts',
  'com.android.managedprovisioning',
  'com.android.statementservice',
  'com.android.backupconfirm',
];

/** Gói rõ ràng thuộc hệ thống/framework: bỏ qua khi cắt giảm phiên, tránh giết nhầm */
const SYSTEM_PREFIXES = [
  'android', 'com.android.', 'com.google.android.',
  'com.qualcomm.', 'com.qti.', 'vendor.', 'com.mediatek.',
];

/** Chỉ tên gói Android hợp lệ mới được ghép vào lệnh shell, chống injection khi danh sách bị làm bẩn */
const SAFE_PKG = /^[A-Za-z][A-Za-z0-9_.]+$/;

function isSystemPackage(pkg) {
  const p = String(pkg || '').trim();
  if (!p) return true;
  if (!SAFE_PKG.test(p)) return true;
  return SYSTEM_PREFIXES.some((pre) => p === pre || p.startsWith(pre));
}

/**
 * Các lệnh cắt giảm cần chạy khi khởi chạy một App.
 * @param {object} o
 * @param {string} o.pkg            gói đang cần mở
 * @param {string[]} o.installed    các gói App người dùng đã cài vào máy (danh sách trong store)
 * @param {boolean} o.deep          cắt giảm sâu (vô hiệu hóa gói nền hệ thống), mặc định false
 * @param {boolean} o.killBackground có dọn luôn tiến trình cache nền không, mặc định false
 *   (dọn nền ở giai đoạn khởi chạy có thể làm hại App vừa vào tiền cảnh, việc dọn do lệnh tạm dừng của endApp đảm nhiệm)
 * @returns {{commands:string[], stopped:string[], disabled:string[], kept:string[]}}
 */
function buildSessionCommands({
  pkg, installed = [], deep = false, killBackground = false,
} = {}) {
  const target = SAFE_PKG.test(String(pkg || '').trim()) ? String(pkg).trim() : '';
  const commands = [];
  const stopped = [];
  const disabled = [];
  const kept = [];

  for (const raw of installed) {
    const p = String(raw || '').trim();
    if (!p || p === target || isSystemPackage(p) || NEVER_TRIM.includes(p)) {
      if (p) kept.push(p);
      continue;
    }
    stopped.push(p);
    commands.push(`am force-stop ${p}`);
  }

  // Dọn các tiến trình nền được hệ thống cache (không gồm tiền cảnh, không gồm dịch vụ persistent),
  // để「chỉ giữ App hiện tại」không chỉ là force-stop tên gói mà thực sự trả lại bộ nhớ.
  if (killBackground) commands.push('am kill-all 2>/dev/null || true');

  if (deep) {
    for (const p of OPTIONAL_SYSTEM) {
      if (NEVER_TRIM.includes(p)) continue;
      disabled.push(p);
      commands.push(`pm disable-user --user 0 ${p} 2>/dev/null || true`);
    }
    // Trên mạng tính phí thì cấm dữ liệu nền, tránh store/đồng bộ liên tục đánh thức ở nền
    commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  }

  return { commands, stopped, disabled, kept };
}

/**
 * Sau khi đóng App cuối cùng thì để container「chạy không mà không ăn tài nguyên」.
 * Không tắt máy, không hủy AVD: lần mở sau vẫn vào ngay, chỉ là nhường CPU/bộ nhớ cho Windows trước.
 */
function buildIdleCommands({ deep = false } = {}) {
  const commands = [
    'am kill-all 2>/dev/null || true',
    'dumpsys deviceidle force-idle 2>/dev/null || true',
  ];
  if (deep) commands.push('settings put global restricted_background_data 1 2>/dev/null || true');
  return commands;
}

/** Khôi phục từ cắt giảm sâu (gọi khi người dùng tắt công tắc, đảm bảo có thể hoàn tác) */
function buildRestoreCommands() {
  return [
    ...OPTIONAL_SYSTEM.map((p) => `pm enable ${p} 2>/dev/null || true`),
    'settings put global restricted_background_data 0 2>/dev/null || true',
  ];
}

/**
 * Máy trạng thái phiên: xác định container nên ở trạng thái nào sau một lần launch/close.
 * Hàm thuần, tiện kiểm chứng các biên như「chuyển đổi nhiều cửa sổ」「đóng cửa sổ cuối cùng」.
 */
function nextSessionState(active, event, pkg) {
  const set = new Set(active || []);
  if (event === 'open') set.add(pkg);
  else if (event === 'close') set.delete(pkg);
  return {
    active: [...set],
    hasApp: set.size > 0,
    foreground: event === 'open' ? pkg : (set.size ? [...set][set.size - 1] : null),
    idle: set.size === 0,
  };
}

/** Tóm tắt một dòng dùng cho log/chẩn đoán */
function describeSession(state, plan) {
  const n = state.active.length;
  if (!n) return 'Container rảnh (Android thường trú nhưng đã hạ ưu tiên, 0 tiến trình app)';
  return `Container hoạt động: ${n} cửa sổ app${plan && plan.stopped && plan.stopped.length
    ? `, đã dừng ${plan.stopped.length} app nền` : ''}`;
}

module.exports = {
  NEVER_TRIM, OPTIONAL_SYSTEM, SYSTEM_PREFIXES,
  isSystemPackage, buildSessionCommands, buildIdleCommands,
  buildRestoreCommands, nextSessionState, describeSession,
};
