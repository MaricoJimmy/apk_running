'use strict';
/**
 * Lưu trữ cục bộ: danh sách ứng dụng + cài đặt
 * Thư mục dữ liệu: %APPDATA%\apkstart
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'apkstart');
const ICON_DIR = path.join(DATA_DIR, 'icons');
const APK_DIR = path.join(DATA_DIR, 'apks');
const APPS_FILE = path.join(DATA_DIR, 'apps.json');
const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
const KEYMAPS_FILE = path.join(DATA_DIR, 'keymaps.json');

const DEFAULT_SETTINGS = {
  adbPath: '',
  device: '127.0.0.1:5555',
  engine: {
    mode: 'builtin',         // builtin (runtime tích hợp, mặc định) | attach (kết nối runtime có sẵn, nâng cao)
    qemuPath: '',
    systemImage: '',
    memoryMB: 0,             // 0 = doctor tự quyết theo RAM của máy
    cores: 0,                // 0 = tự động
    autoMemory: true,        // Không cần cấu hình: tự suy ra tham số RAM/nhân/đĩa/kết xuất
    idleShutdownMinutes: 15,
    startVisible: true,
    // Bắt buộc có cửa sổ: ở chế độ headless SurfaceFlinger không phát VSYNC, tiến trình ứng dụng vẫn sống nhưng màn hình trống trơn.
    // Trình giả lập có cửa sổ cho 60fps gốc + chuột/bàn phím gốc, ApkStart chỉ lo "hóa trang" nó thành cửa sổ ứng dụng.
    headless: false,
    gpuMode: 'auto',         // auto = tự chọn backend theo phiên bản emulator và hạ cấp dần
    // Backend kết xuất lần trước "vừa bật đã crash" (định dạng `<phiên bản emulator>|<gpu>`); ở chế độ auto lần sau xếp nó cuối cùng,
    // tránh mỗi lần khởi động phải chờ không hơn 20 giây rồi mới lùi về kết xuất phần mềm. Nâng cấp runtime sẽ tự hết hiệu lực.
    badGpu: '',
    forceTcg: false,         // Dành cho xử lý sự cố nâng cao; luồng bình thường đã được doctor tự lùi về
    audio: true,             // Âm thanh của ứng dụng Android (thông báo/video). Tắt để tiết kiệm chút CPU
    // ---- Container nhẹ (mặc định bật hết để tiết kiệm tài nguyên, người dùng có thể tắt từng mục) ----
    liteMode: true,          // Giới hạn hạn mức vCPU, tránh qemu chiếm hết nhân vật lý làm chậm Windows
    // Chiến lược một câu: save (tiết kiệm) / balanced (cân bằng) / smooth (mượt, ưu tiên video·game).
    // Giao diện chỉ hiển thị một tùy chọn này, khi lưu sẽ tự dịch thành liteMode / priorityMode / renderSize,
    // phía dưới vẫn giữ các công tắc chi tiết cho người dùng nâng cao.
    resourceMode: 'balanced',
    // Dung lượng phân vùng dữ liệu (GB): ứng dụng, cache game và gói cập nhật của chúng đều nằm ở đây.
    // 0 = tự động (cấp 6/8GB theo dung lượng đĩa trống). Tăng lên thì lần mở Android sau sẽ **mở rộng tại chỗ**, không mất ứng dụng đã cài.
    dataPartitionGB: 0,
    // Độ phân giải kết xuất: càng thấp càng mượt, càng tiết kiệm điện; auto = chọn 720x1280 / 540x960 theo trạng thái tăng tốc
    renderSize: 'auto',
    // Tăng tốc mạng: chỉ định DNS công cộng trong nước cho trình giả lập. 10.0.2.3 mặc định của Android phải đi qua DNS của máy chủ,
    // dưới VPN / mạng công ty / một số nhà mạng, phân giải có thể kéo dài vài trăm ms, ứng dụng video sẽ giật rõ ở màn hình đầu.
    fastDns: true,
    // Snapshot: snapshot bộ nhớ quickboot giúp lần khởi động sau chỉ mất vài giây, đổi lại trên đĩa có thêm khoảng 2~3GB
    // (ram.bin). Khi đĩa chật có thể tắt (chỉ ảnh hưởng tốc độ khởi động, không ảnh hưởng dữ liệu ứng dụng).
    keepSnapshot: true,
    // Giới hạn log (KB): vượt quá thì xoay vòng sao lưu một bản, tránh dùng lâu làm đầy đĩa
    logLimitKB: 2048,
    // Phím chuột: chuột trái được trình giả lập ánh xạ gốc thành "xác nhận/chạm", không cần công tắc.
    // Chuột phải để quay lại và cuộn mượt cần hook cấp thấp, nhưng chỉ cài khi cửa sổ ứng dụng ở tiền cảnh, mất focus là gỡ.
    mouseRightBack: true,    // Chuột phải = nút Back Android (chặn hành vi mặc định của Qt "chuột phải cũng tính là chạm")
    mouseWheelMode: 'smooth', // smooth = gộp lại rồi bơm một lần vuốt | native = giao cho Qt | off = không xử lý
    mouseSideButtons: false, // Nút bên để lùi/tiến: mặc định tắt, bật mới cài thêm ánh xạ
    deepTrim: false,         // Cắt sâu các gói nền hệ thống (Play Store/trình hướng dẫn...), mặc định không động vào hệ thống
    // balanced=nhường tiền cảnh | performance=qemu Normal | game=qemu High + nhập liệu độ trễ thấp
  priorityMode: 'balanced',
    // Khởi động trước: sau khi mở ApkStart sẽ khởi động sẵn môi trường Android ở nền, lần đầu mở ứng dụng gần như không phải chờ.
    // Đổi lại thường trú khoảng 1GB RAM (đánh đổi giống WSA / bản PC của các kho ứng dụng), có thể tắt bất cứ lúc nào.
    prewarm: true,
  },
  runtime: {
    dir: '',                 // Rỗng = %APPDATA%\apkstart\runtime
    qemuUrl: '',             // Chỉ định thủ công địa chỉ gói cài QEMU
    isoUrl: '',              // Chỉ định thủ công địa chỉ ảnh hệ thống
    isoPath: '',             // Đường dẫn ảnh hệ thống (ISO)
    diskPath: '',            // Đĩa ảo để cài hệ thống
    diskSizeGB: 24,
    headless: false,         // Không hiện cửa sổ máy ảo (chỉ để gỡ lỗi)
    installMode: 'guided',   // guided (hướng dẫn cài thủ công) | auto (cài tự động, thử nghiệm)
    emulatorUrl: '',         // Chỉ định thủ công địa chỉ gói emulator (rỗng = tự lấy bản mới nhất từ chỉ mục SDK)
    sysimgUrl: '',           // Chỉ định thủ công địa chỉ gói ảnh hệ thống
    compatImage: false,      // Chế độ tương thích ARM: dùng ảnh Google Play (có sẵn native bridge, cài được ứng dụng chỉ hỗ trợ ARM)
    deployFailedAt: 0,       // Mốc thời gian lần tự triển khai thất bại gần nhất (0 = chưa thất bại). Sau khi thất bại 30 phút không tự tải lại
    // Gói runtime trọn bộ của bản nhẹ: mặc định tải từ GitHub Release của dự án (cùng nguồn với "Cập nhật phần mềm"),
    // không lấy được thì tự lùi về tải từng thành phần từ dl.google.com. Có thể đổi thành địa chỉ mirror tự dựng ở đây.
    preferGithubRuntime: true,
    runtimePackUrl: '',
    // Tiền tố mirror tăng tốc GitHub (tùy chọn). Kết nối thẳng GitHub Releases từ Trung Quốc thường chỉ vài chục KB/s,
    // điền tiền tố mirror kiểu https://ghfast.top/ là chuyển hướng được các yêu cầu downloads.
    // Để trống = kết nối thẳng (cũng sẽ thử chia khối 8 luồng trước, có thể tận dụng hết băng thông).
    mirrorPrefix: '',
    // Số kết nối tải song song: số kết nối khi tải chia khối. Mặc định 8, mạng yếu/bị bóp băng thông có thể chỉnh lên 16.
    downloadConnections: 8,
    // Chọn nguồn cập nhật/tải xuống. auto = hỏi đồng thời GitHub và Gitee, đo thực tế tốc độ
    // 128KB cho từng địa chỉ tải, nguồn nào nhanh dùng nguồn đó; cũng có thể ép chỉ đi một bên (hữu ích khi mạng doanh nghiệp chỉ cho phép một tên miền).
    sourcePreference: 'auto',
    // Tự thử các mirror tăng tốc GitHub công cộng (ghfast / gh-proxy). Tắt đi thì chỉ dùng kết nối thẳng + tiền tố tùy chỉnh.
    // Hai dịch vụ này là bên thứ ba, chỉ chuyển tiếp file release công khai, không liên quan thông tin tài khoản.
    autoMirror: true,
    // API releases của Gitee yêu cầu access_token kể cả với repo công khai (không token là 404 ngay),
    // muốn dùng Gitee làm nguồn cập nhật thì điền một token chỉ đọc ở đây; để trống thì chỉ dùng GitHub + mirror.
    giteeToken: '',
  },
  sharedDir: path.join(os.homedir(), 'ApkStartShared'),
  deviceSharedDir: '/sdcard/ApkStartShared',
  autoConnect: true,
  createShortcutOnInstall: true,
  createStartMenuShortcut: true, // Lối tắt Start Menu = để Windows Search tìm thấy ứng dụng
  shortcutDir: '',           // Rỗng = Desktop
  freeform: false,           // Dùng chung một cửa sổ runtime, không dùng cửa sổ nhỏ freeform của Android nữa
  hideAfterLaunch: false,    // Tiến trình chính phải thường trú, nếu không vừa thoát là runtime Android bị tắt theo
  notifyOnInstall: true,
  autoStart: true,           // Tự khởi động cùng Windows, mặc định bật, người dùng không cần cài đặt
  autoDeploy: true,          // Lần chạy đầu tự hoàn tất toàn bộ triển khai, không chia thành 1~5 bước nữa
  // Thẻ chào mừng khi khởi động: lastDate ghi ngày tự bật lần cuối (mở thủ công thì tối đa một lần mỗi ngày),
  // disabled = người dùng đã tích "Không tự bật nữa".
  welcome: { lastDate: '', disabled: false },
  display: {
    mode: 'window',          // window (cửa sổ dọc, co giãn tự do) | fullscreen (tự khớp màn hình)
    portrait: '900x1600',    // Độ phân giải dọc ở chế độ cửa sổ, có thể chỉnh trong cài đặt
    density: 0,              // 0 = tự suy ra theo độ phân giải
    rememberBounds: true,    // Nhớ vị trí/kích thước cửa sổ của từng ứng dụng
    autoFullscreenOnLaunch: false,
    // Ngang = đổi màn hình vật lý của AVD thành 1280x720 rồi khởi động lại (cách duy nhất để có hình đứng thẳng + phủ kín).
    // Được lưu ở đây, khởi động lại ApkStart vẫn mở máy theo hướng này.
    landscape: false,
  },
};

function ensureDirs() {
  for (const d of [DATA_DIR, ICON_DIR, APK_DIR]) {
    if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
  }
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    // Bỏ UTF-8 BOM nếu có. Có BOM thì JSON.parse sẽ ném lỗi ngay, khiến toàn bộ cấu hình
    // âm thầm rơi về mặc định — người dùng thấy "mất hết cài đặt" mà không hề biết vì sao.
    // File này được trang cài đặt, công cụ đồng bộ, thậm chí người dùng sửa tay, nên phải chấp nhận BOM.
    if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
    return JSON.parse(text);
  } catch (_) {
    return fallback;
  }
}

function writeJson(file, data) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch || {})) {
    if (v && typeof v === 'object' && !Array.isArray(v) && base[k] && typeof base[k] === 'object') {
      out[k] = deepMerge(base[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

/**
 * Chiến lược tài nguyên → các công tắc cụ thể.
 *   save     : 2 vCPU + ưu tiên thấp + 540x960, cho laptop cũ / treo máy;
 *   balanced : vCPU lấy một nửa số nhân vật lý (2~4) + nhường tiền cảnh + 720x1280;
 *   smooth   : không giới hạn vCPU + ưu tiên ngang tiền cảnh + 720x1280, ưu tiên video và game.
 * Tạm chưa dùng 1080p: dấu vân tay snapshot quickboot gắn với nó, đổi một lần là phải khởi động nguội lại, mà 720p
 * trong cửa sổ tỉ lệ điện thoại đã không thấy khác biệt, hiệu năng thì kém hẳn một bậc.
 */
function resourcePreset(mode) {
  switch (String(mode || '')) {
    case 'save':
      return { resourceMode: 'save', liteMode: true, priorityMode: 'balanced', renderSize: '540x960' };
    case 'smooth':
      return { resourceMode: 'smooth', liteMode: false, priorityMode: 'game', renderSize: '720x1280' };
    case 'balanced':
    default:
      return { resourceMode: 'balanced', liteMode: true, priorityMode: 'balanced', renderSize: 'auto' };
  }
}

const store = {
  DATA_DIR, ICON_DIR, APK_DIR,

  getSettings() {
    const s = deepMerge(DEFAULT_SETTINGS, readJson(SETTINGS_FILE, {}));
    // Bản cũ mặc định chạy headless: tiến trình ứng dụng chạy được nhưng không có cửa sổ trên màn hình, tương đương "không mở được".
    // Di chuyển vô điều kiện sang chế độ có cửa sổ, và không cho phép tắt nó qua cấu hình cũ nữa.
    s.engine.headless = false;
    // Bản cũ khi thoát shell sẽ tắt luôn cả runtime Android, khiến biểu tượng desktop bấm vào lóe lên rồi mất.
    s.hideAfterLaunch = false;
    // Bản cũ dùng cửa sổ nhỏ freeform của Android, giờ toàn bộ cửa sổ trình giả lập chính là cửa sổ ứng dụng,
    // ứng dụng phải phủ kín màn hình này, nếu không sẽ thành "cửa sổ nhỏ lồng trong cửa sổ".
    s.freeform = false;
    return s;
  },

  saveSettings(patch) {
    const next = deepMerge(this.getSettings(), patch);
    // Khi chỉ đổi "chiến lược tài nguyên", dịch nó thành ba công tắc cụ thể, tránh hai bộ cấu hình mâu thuẫn nhau
    if (patch && patch.engine && patch.engine.resourceMode) {
      Object.assign(next.engine, resourcePreset(next.engine.resourceMode));
    }
    writeJson(SETTINGS_FILE, next);
    return next;
  },

  getApps() {
    const data = readJson(APPS_FILE, { apps: [] });
    return Array.isArray(data.apps) ? data.apps : [];
  },

  saveApps(apps) {
    writeJson(APPS_FILE, { apps });
  },

  upsertApp(app) {
    const apps = this.getApps();
    const i = apps.findIndex((a) => a.package === app.package);
    if (i >= 0) apps[i] = { ...apps[i], ...app };
    else apps.push(app);
    this.saveApps(apps);
    return app;
  },

  removeApp(pkg) {
    const apps = this.getApps().filter((a) => a.package !== pkg);
    this.saveApps(apps);
  },

  getApp(pkg) {
    return this.getApps().find((a) => a.package === pkg) || null;
  },

  /** Bộ phím (map phím) của một game, theo tên gói; chưa có thì null */
  getKeymap(pkg) {
    const all = readJson(KEYMAPS_FILE, {});
    return (all && all[pkg]) || null;
  },

  /** Lưu bộ phím của một game; profile = null để xóa */
  saveKeymap(pkg, profile) {
    const all = readJson(KEYMAPS_FILE, {}) || {};
    if (profile) all[pkg] = profile;
    else delete all[pkg];
    writeJson(KEYMAPS_FILE, all);
  },

  iconPath(pkg) {
    return path.join(ICON_DIR, `${pkg}.png`);
  },

  apkPath(pkg, version = 'cur') {
    return path.join(APK_DIR, `${pkg}-${version}.apk`);
  },

  ensureDirs,
  DEFAULT_SETTINGS,
};

module.exports = store;
