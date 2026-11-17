'use strict';
/**
 * Tiến trình chính ApkStart
 * Nhiệm vụ: cửa sổ / khay hệ thống / một phiên bản / phân phối dòng lệnh (nhấp đúp apk, mở từ lối tắt desktop) / IPC
 */
const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, shell, nativeImage, screen, globalShortcut } = require('electron');
const fs = require('fs');
const path = require('path');

const store = require('./core/store');
const { Runtime } = require('./core/engine');
const { Installer } = require('./core/installer');
const { Sharer } = require('./core/sharer');
const { parseApk } = require('./core/apk');
const { drawAppIcon } = require('./core/png');

// Logo thương hiệu (do build/render-logo.js tạo); nếu thiếu thì lùi về biểu tượng cũ vẽ bằng code
const LOGO_DIR = path.join(__dirname, 'ui', 'assets');
const LOGO_FILE = path.join(LOGO_DIR, 'logo.png');
const APPICON_FILE = path.join(LOGO_DIR, 'appicon.ico');
function loadBrandIcon(size) {
  try {
    if (fs.existsSync(LOGO_FILE)) {
      const img = nativeImage.createFromPath(LOGO_FILE);
      return size ? img.resize({ width: size, height: size, quality: 'best' }) : img;
    }
  } catch (_) { /* dùng biểu tượng vẽ bằng code */ }
  return nativeImage.createFromBuffer(drawAppIcon(size || 256));
}
const assoc = require('./core/assoc');
const windowctl = require('./core/windowctl');
const display = require('./core/display');
const { WinAgent } = require('./core/agent');
const pointer = require('./core/pointer');
const { AppWindow, TITLEBAR_H } = require('./core/appwin');
const { KeymapSession } = require('./core/keymap-session');
const { TouchChannel } = require('./core/touch');
const { NotifyBridge } = require('./core/notify');
const { AndroidSettings } = require('./core/android');
const { Updater } = require('./core/updater');
const leftovers = require('./core/leftovers');

// Trên Windows khi cửa sổ bị che, capturePage sẽ lấy khung hình cũ, chụp màn hình tự động cần tắt tính toán che khuất
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');

/**
 * Khi ổ hệ thống sắp đầy, chuyển bộ đệm của Chromium (Cache / GPUCache / Local Storage …)
 * sang ổ đĩa chứa "thư mục dữ liệu Android".
 * Mặc định các bộ đệm này ghi vào %APPDATA%\apkstart — khi ổ C chỉ còn vài trăm MB, có khi khởi động cũng thất bại,
 * trong khi người dùng thường đã chuyển dữ liệu Android sang ổ khác, bộ đệm lại vẫn chen chúc trên ổ C.
 * Phải đặt trước app ready, đổi sau đó không có tác dụng.
 */
function relocateUserDataIfCrowded() {
  try {
    const doctor = require('./core/doctor');
    const freeMB = doctor.freeDiskMB(store.DATA_DIR);
    const avd = String(store.getSettings().runtime.avdDir || '').trim();
    if (!avd) return;
    const avdFree = doctor.freeDiskMB(avd);
    if (freeMB >= 2048 || avdFree <= freeMB * 2) return;
    const target = path.join(avd, 'appdata');
    fs.mkdirSync(target, { recursive: true });
    app.setPath('userData', target);
  } catch (_) { /* không đặt được thì giữ mặc định, không ảnh hưởng khởi động */ }
}
relocateUserDataIfCrowded();

// Cửa sổ ứng dụng nhúng trình giả lập vào làm cửa sổ con bằng SetParent. Chromium mặc định dùng
// lớp bán trong suốt DirectComposition (Intermediate D3D Window /
// WS_EX_NOREDIRECTIONBITMAP) để vẽ trang web, lớp này do DWM tổng hợp ở cấp cửa sổ,
// sẽ che luôn cửa sổ con được nhúng — biểu hiện là "màn hình đen hoàn toàn nhưng Android thực ra vẫn chạy".
// Giao diện vỏ chỉ có một thanh tiêu đề 38px và lớp che khởi động, tổng hợp bằng phần mềm hoàn toàn không giật,
// tắt tăng tốc phần cứng thì Chromium vẽ thẳng vào HWND, thứ tự lớp cửa sổ con mới thật sự có hiệu lực.
// Muốn so sánh hiệu quả thì có thể khởi động với APKSTART_HWACCEL=1.
if (process.env.APKSTART_HWACCEL !== '1') app.disableHardwareAcceleration();

const APP_ROOT = path.join(__dirname, '..');
const IS_DEV = process.argv.includes('--dev');

/**
 * Log file gọn nhẹ: sau khi đóng gói không có console, khi gặp sự cố người dùng có thể gửi app.log.
 * Chỉ ghi các mốc chính và ngoại lệ, chạy bình thường vài nghìn dòng cũng không bị phình.
 */
function appLog(line) {
  try {
    const dir = path.join(store.DATA_DIR, 'logs');
    const limit = store.getSettings().engine.logLimitKB || 2048;
    require('./core/logfile').append(path.join(dir, 'app.log'), `${new Date().toISOString()} ${line}`, limit);
  } catch (_) { /* ghi log lỗi không được ảnh hưởng luồng chính */ }
}
process.on('uncaughtException', (e) => appLog(`UNCAUGHT ${e && (e.stack || e.message)}`));
process.on('unhandledRejection', (e) => appLog(`REJECT ${e && (e.stack || e.message || e)}`));

/**
 * Bản đầy đủ (có sẵn môi trường chạy) tự động tiếp quản:
 * Gói phát hành có thư mục runtime/ cạnh ApkStart.exe (emulator + platform-tools + AEHD + image tương thích ARM).
 * Lần khởi động đầu (chưa có settings.json) trỏ thẳng runtime.dir tới đó và bật chế độ tương thích,
 * người dùng không cần tải hay cài đặt gì, dùng được ngay. Sau đó vẫn có thể đổi lại bản trực tuyến trong Cài đặt.
 */
function bootstrapBundledRuntime() {
  try {
    const exeDir = path.dirname(process.execPath);
    // Bản portable đặt môi trường chạy cạnh exe; portable của electron-builder giải nén tài nguyên vào
    // resources/, exe của tiến trình và resources cùng cấp, nên xem qua vài vị trí ứng viên.
    const candidates = [
      path.join(exeDir, 'runtime'),
      path.join(path.dirname(exeDir), 'runtime'),
      path.join(process.resourcesPath || '', 'runtime'),
      path.join(process.resourcesPath || '', 'app', 'runtime'),
    ];
    // Môi trường chạy có sẵn chỉ yêu cầu "có emulator + một bộ system image đầy đủ bất kỳ", không cố định phiên bản API:
    // bản phát hành một file có thể mang image AOSP nhỏ hơn, cố định API34 sẽ khiến nó bị nhận nhầm là không có môi trường chạy.
    const hasImage = (dir) => {
      const root = path.join(dir, 'system-images');
      let apis = [];
      try { apis = fs.readdirSync(root); } catch (_) { return false; }
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) {
            const d = path.join(root, api, tag, abi);
            // Image trong bản phát hành một file được lưu dạng nén (system.img.xz / .gz), giải nén ở lần khởi động đầu.
            // Nếu ở đây chỉ nhận system.img thì "gói rõ ràng có image" sẽ bị coi là không có, chuyển sang tải qua mạng.
            const hasSys = ['system.img', 'system.img.xz', 'system.img.gz']
              .some((f) => fs.existsSync(path.join(d, f)));
            if (hasSys && fs.existsSync(path.join(d, 'kernel-ranchu'))) return true;
          }
        }
      }
      return false;
    };
    const bundled = candidates.find((dir) =>
      fs.existsSync(path.join(dir, 'emulator', 'emulator.exe')) && hasImage(dir));
    if (!bundled) return;

    const s = store.getSettings();
    // Bản cũ chỉ tiếp quản khi chưa có settings.json: người dùng cài bản trực tuyến trước rồi giải nén bản đầy đủ
    // sẽ mãi rơi vào trình hướng dẫn "thiếu thành phần". Nay chỉ cần thư mục môi trường chạy hiện tại không có emulator là tiếp quản.
    const explicit = String(s.runtime.dir || '').trim();
    const current = explicit || path.join(store.DATA_DIR, 'runtime');
    const currentExe = path.join(current, 'emulator', 'emulator.exe');
    // Sau khi bản portable bị di chuyển/nâng cấp (giải nén sang thư mục mới), settings vẫn ghi đường dẫn cũ:
    // phải chỉ nhận "runtime trong thư mục chứa EXE lần này", nếu không sẽ mãi dùng thành phần trong gói cũ
    // (đã gặp thực tế: emulator của gói cũ thiếu emulator-check → dò tăng tốc thất bại → lùi về giả lập phần mềm TCG).
    const sameTree = path.resolve(current).toLowerCase()
      .startsWith(path.resolve(exeDir).toLowerCase());
    const currentOk = fs.existsSync(currentExe) && sameTree;
    // Thư mục người dùng tự chọn (không nằm trong cây thư mục EXE, ví dụ D:\ApkStartRuntime hoặc ổ khác)
    // luôn được tôn trọng: có thể họ muốn tiết kiệm ổ C, hoặc cho nhiều bản portable dùng chung một môi trường chạy.
    // Bản cũ ở đây ghi đè vô điều kiện thành runtime đi kèm cạnh exe, biểu hiện là
    // "đã đổi thư mục dữ liệu môi trường chạy trong Cài đặt mà vẫn tải về thư mục cũ / AppData" (issue #23).
    if (explicit && !sameTree && fs.existsSync(currentExe)) {
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // Đã có môi trường chạy dùng được (kể cả bản trực tuyến) thì tôn trọng: dữ liệu người dùng AVD nằm trong đó, không được lặng lẽ chuyển đi
    if (currentOk) {
      // nhưng vẫn bật tham số tự động, cấu hình cũ cố định 4G/4 nhân/chế độ GPU đã lỗi thời không được dùng tiếp
      if (s.engine.gpuMode === 'swiftshader_indirect' || s.engine.memoryMB === 4096) {
        store.saveSettings({ engine: { gpuMode: 'auto', autoMemory: true, memoryMB: 0, cores: 0 } });
      }
      return;
    }
    // Gói mang image Google Play mới bật chế độ tương thích; image AOSP mang thư viện x86_64 gốc
    let playBundled = false;
    try {
      const root = path.join(bundled, 'system-images');
      for (const api of fs.readdirSync(root)) {
        for (const tag of fs.readdirSync(path.join(root, api))) {
          if (/playstore|google_apis/i.test(tag)) playBundled = true;
        }
      }
    } catch (_) { /* bỏ qua */ }
    store.saveSettings({
      runtime: { dir: bundled, compatImage: playBundled },
      engine: { gpuMode: 'auto', autoMemory: true },
    });
  } catch (_) { /* tiếp quản thất bại không chặn khởi động, chuyển sang hướng dẫn trực tuyến */ }
}
bootstrapBundledRuntime();

// Trong các kịch bản tự động như chụp smoke test thì bỏ qua dò registry (tránh phụ thuộc reg.exe)
const NO_SHELL_PROBE = process.argv.includes('--smoke') || process.env.APKSTART_NO_SHELL_PROBE === '1';
const ICON_PNG = loadBrandIcon().toPNG();

let mainWindow = null;
let tray = null;
let runtime = null;
// "Cửa sổ nào là của ta" được gán trong whenReady (xem agentScope). Đặt ở cấp module vì
// runLaunch / bộ hẹn giờ khởi động trước đều được định nghĩa trước đoạn đó, const trong closure không thấy được từ phạm vi của chúng.
let armAgent = async () => ({ ok: false });
let installer = null;
let sharer = null;
let quitting = false;
let winAgent = null;
let appWin = null;
let notifier = null;
let androidSet = null;
let updater = null;
let updateBusy = false;
let updateInfo = null;

// ---------------- Phân tích dòng lệnh ----------------

function parseArgs(argv) {
  const args = argv.slice(IS_DEV ? 2 : 1).filter((a) => !a.startsWith('--allow-file-access'));
  const out = { apk: null, launch: null, silent: false };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--launch') {
      // Electron nhét cờ riêng và đường dẫn app vào argv, chỉ nhận tên gói dạng com.foo.bar
      const v = args.slice(i + 1).find((x) => x && /^[a-zA-Z][\w]*(\.[\w]+)+$/.test(x));
      if (v) { out.launch = v; out.silent = true; }
    } else if (a === '--silent' || a === '--autostart') out.silent = true;
    else if (/\.(apk|xapk|apks)$/i.test(a) && !a.startsWith('--')) out.apk = a;
  }
  return out;
}

/** Chromium giải mã được WebP, nativeImage thì không; dùng cửa sổ ẩn để chuyển biểu tượng APK sang PNG */
let decodeWindow = null;
async function decodeIcon(raw) {
  if (!decodeWindow || decodeWindow.isDestroyed()) {
    decodeWindow = new BrowserWindow({ show: false, width: 2, height: 2, skipTaskbar: true });
    await decodeWindow.loadURL('about:blank');
  }
  const mime = /^RIFF/.test(raw.toString('ascii', 0, 4)) ? 'image/webp' : 'image/png';
  const js = `(async () => {
    const img = new Image();
    img.src = 'data:${mime};base64,${raw.toString('base64')}';
    await img.decode();
    const s = Math.min(256, Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas'); c.width = s; c.height = s;
    c.getContext('2d').drawImage(img, 0, 0, s, s);
    return c.toDataURL('image/png');
  })()`;
  const url = await decodeWindow.webContents.executeJavaScript(js);
  return Buffer.from(String(url).split(',')[1] || '', 'base64');
}

/** Tự khởi động cùng Windows: mặc định bật, người dùng không cần vào Cài đặt để tích */
function applyAutoStart() {
  if (!app.isPackaged) return; // khi phát triển thì không ghi registry
  const on = !!store.getSettings().autoStart;
  try {
    // Phải chỉ định rõ name, nếu không mục khởi động trong registry sẽ tên là "electron.app.Electron"
    app.setLoginItemSettings({
      openAtLogin: on,
      name: 'ApkStart',
      path: process.execPath,
      args: ['--autostart'],
    });
    // Xóa mục do bản cũ (không truyền name) để lại, tránh khởi động trùng
    app.setLoginItemSettings({ openAtLogin: false, name: 'electron.app.Electron' });
  } catch (_) { /* bỏ qua khi bị Group Policy chặn */ }
}

// ---------------- Chế độ hiển thị: toàn màn hình tự thích ứng / cửa sổ dọc chỉnh được ----------------

function displaySettings() { return store.getSettings().display || {}; }

function screenRect() {
  const d = screen.getPrimaryDisplay();
  const a = d.workArea || d.bounds;
  return { x: a.x || 0, y: a.y || 0, w: a.width || 1920, h: a.height || 1080 };
}

let currentAppPkg = null;
let wheelRouter = null;
// Map phím: phiên theo cửa sổ game + kênh chạm đa điểm (tạo khi runtime sẵn sàng, xem touch.js)
let keymapSession = null;
let keymapTouch = null;
const deviceSize = { value: null };

/** Chèn sự kiện con lăn cần biết độ phân giải phía Android; cache một lần, mất hiệu lực sau khi xoay màn hình/khởi động lại môi trường chạy */
async function getDeviceSize() {
  if (deviceSize.value) return deviceSize.value;
  try { deviceSize.value = await runtime.client().wmSize(); } catch (_) { /* môi trường chạy chưa lên */ }
  if (!deviceSize.value || !deviceSize.value.width || !deviceSize.value.height) {
    const p = portraitSize();
    deviceSize.value = { width: p.w, height: p.h };
  }
  return deviceSize.value;
}

function portraitSize() {
  const d = displaySettings();
  return display.portraitSize(d.portrait || '540x960');
}

/** Sau khi trang cài đặt đổi phím chuột, đồng bộ ngay cấu hình hook theo focus cửa sổ hiện tại */
function refreshPointerMapping() {
  if (appWin && appWin.isOpen) appWin.refreshPointer();
  else if (winAgent && winAgent.hooked) winAgent.setHook(false).catch(() => {});
}

/**
 * Xoay = đổi kích thước tấm nền vật lý và khởi động lại trình giả lập.
 *
 * Đây là cách duy nhất có màn ngang "đúng chiều + lấp đầy" (đã thử cả ba hướng sai):
 *   - wm size: chỉ đổi độ phân giải logic, LCD vật lý vẫn dọc -> hình nằm nghiêng 90°, chỉ chiếm một dải góc trên trái;
 *   - wm density: kích thước framebuffer không đổi -> hình không lấp đầy, phóng to xong bên phải trống một mảng lớn;
 *   - adb emu rotate: chỉ xoay nội dung hình, trong hệ thống vẫn là dọc.
 * Chỉ khi đổi hw.lcd.width/height sang ngang và khởi động lại, Qt mới mở cửa sổ theo tấm nền ngang, hình đúng chiều và lấp đầy.
 */
async function restartForOrientation(landscape) {
  if (!appWin || !appWin.isOpen) return false;
  const pkg = appWin.pkg;
  store.saveSettings({ display: { landscape: !!landscape } });
  send('runtime:log', landscape ? 'Chuyển sang màn ngang: đang khởi động lại môi trường Android…' : 'Chuyển về màn dọc: đang khởi động lại môi trường Android…');
  try {
    // Gỡ cửa sổ nhúng ra trước, tránh để lại cửa sổ đen trên desktop khi khởi động lại
    try { await appWin.agent.detach(); } catch (_) { /* ignore */ }
    await runtime.stop({ graceful: false }).catch(() => {});
    appLog(`rotate -> landscape=${landscape} restarting runtime`);
    const rt = await runtime.ensure({
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
    });
    if (!rt || !rt.ok) return false;
    await runtime.waitForNetwork({ onLog: () => {}, timeoutMs: 25000 }).catch(() => null);
    if (pkg) {
      const app = store.getApp(pkg);
      if (app) {
        await rt.client.install(app.apkPath).catch(() => {});
        await rt.client.startApp(app.package, app.activity, {}).catch(() => {});
      }
    }
    await new Promise((r) => setTimeout(r, 1500));
    const embedded = await appWin.embed().catch(() => false);
    if (!embedded) {
      setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
      setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
    }
    appWin.scheduleFit(6);
    return true;
  } catch (e) {
    appLog(`rotate restart failed: ${e && e.message}`);
    return false;
  }
}

/** Mở (hoặc dùng lại) cửa sổ "mỗi ứng dụng một cửa sổ gọn gàng" */
function openAppWindow(pkg, tip) {
  const rec = store.getApp(pkg);
  const land = !!displaySettings().landscape;
  const p0 = portraitSize();
  appWin.open({
    pkg,
    label: (rec && rec.label) || pkg,
    iconPath: rec && rec.icoPath,
    // Khi ở màn ngang thì mở cửa sổ theo tỉ lệ ngang, nếu không hình ngang trong cửa sổ dọc sẽ để lại viền đen lớn
    portrait: land ? { w: p0.h, h: p0.w } : p0,
    fullscreen: displaySettings().mode === 'fullscreen',
  });
  appWin.setIcon(rec && rec.icoPath);
  // Khi mở thì khởi tạo theo hướng đã lưu (hướng tấm nền vật lý quyết định trong doctor.lcdFor)
  appWin.setState({
    tip: tip || 'Đang khởi động môi trường Android…',
    ready: false,
    landscape: !!displaySettings().landscape,
  });
  currentAppPkg = pkg;
}

async function toggleDisplayMode() {
  const next = store.saveSettings({
    display: { mode: displaySettings().mode === 'fullscreen' ? 'window' : 'fullscreen' },
  });
  const full = next.display.mode === 'fullscreen';
  if (appWin && appWin.isOpen) {
    if (full) appWin.win.maximize();
    else appWin.win.unmaximize();
    appWin.scheduleFit(6);
    // Toàn màn hình = ngang: đổi tấm nền vật lý và khởi động lại môi trường chạy, nếu không chỉ là kéo to hình dọc, bên phải trống một mảng lớn
    if (!!displaySettings().landscape !== full) {
      appWin.rotate(restartForOrientation).catch(() => {});
    }
  }
  return next.display.mode;
}

/** Lần chạy đầu cài một lượt adb / emulator / system image, không chia thành bước 1~5 nữa */
let deploying = false;
async function autoDeploy({ force = false } = {}) {
  if (deploying || !store.getSettings().autoDeploy) return { ok: false, error: 'skipped' };
  // Thời gian chờ sau khi tải thất bại: trước đây chỉ cần checkEnv() còn thiếu thành phần, mỗi lần mở ApkStart đều tải lại
  // gói môi trường chạy 1.5GB, người dùng thấy là "tải lặp đi lặp lại mãi".
  // Thất bại thì ghi lại mốc thời gian, trong 30 phút không tự thử lại; khi người dùng tự bấm "Triển khai một chạm"
  // thì force=true để thử lại ngay. Thành công hoặc ép thủ công đều xóa thời gian chờ.
  const COOLDOWN_MS = 30 * 60 * 1000;
  const lastFail = Number(store.getSettings().runtime.deployFailedAt || 0);
  if (!force && lastFail && Date.now() - lastFail < COOLDOWN_MS) {
    appLog(`autoDeploy đang trong thời gian chờ (lần thất bại trước lúc ${new Date(lastFail).toISOString()}), bỏ qua tự động thử lại`);
    return { ok: false, error: 'cooldown', cooldown: true, until: lastFail + COOLDOWN_MS };
  }
  deploying = true;
  const progress = (p) => send('provision:progress', { ...p, component: p.component || 'all' });
  let succeeded = false;
  try {
    const env = await runtime.provisioner.checkEnv();
    const needEngine = !env.emulator.ok || !env.sysimg.ok;
    // Bản nhẹ ưu tiên dùng "gói môi trường chạy trọn bộ trên GitHub của dự án": một file gồm cả emulator + system image,
    // nguồn tải và nguồn cập nhật đều thống nhất trên GitHub (ở Trung Quốc ổn định hơn dl.google.com nhiều).
    // Không lấy được gói trọn bộ (mất mạng / chưa phát hành tài nguyên đó / bị giới hạn) thì cài từng phần từ nguồn chính thức.
    if (needEngine && store.getSettings().runtime.preferGithubRuntime !== false) {
      try {
        progress({ message: 'Đang tải môi trường chạy từ GitHub…' });
        await runtime.provisioner.installRuntimePack(progress);
        const afterPack = await runtime.provisioner.checkEnv();
        if (afterPack.emulator.ok && afterPack.sysimg.ok) {
          succeeded = true;
          return { ok: true, source: 'github' };
        }
        progress({ message: 'Gói môi trường chạy không đầy đủ, chuyển sang nguồn chính thức để bổ sung…' });
      } catch (e) {
        progress({ message: `Môi trường chạy từ GitHub không khả dụng (${e.message}), chuyển sang nguồn chính thức…` });
      }
    }
    if (!env.adb.ok) {
      progress({ message: 'Đang chuẩn bị adb…' });
      await runtime.provisioner.installAdb(progress);
    }
    if (!env.emulator.ok) {
      progress({ message: 'Đang chuẩn bị môi trường chạy Android…' });
      await runtime.provisioner.installEmulator(progress);
    }
    if (!env.sysimg.ok) {
      progress({ message: 'Đang chuẩn bị system image Android…' });
      await runtime.provisioner.installSystemImage(progress);
    }
    const after = await runtime.provisioner.checkEnv();
    succeeded = !!(after.adb.ok && after.emulator.ok && after.sysimg.ok);
    return { ok: succeeded };
  } catch (e) {
    return { ok: false, error: e.message };
  } finally {
    // Chỉ "thất bại thật" mới vào thời gian chờ; triển khai thành công phải xóa bản ghi thất bại cũ.
    try {
      store.saveSettings({ runtime: { deployFailedAt: succeeded ? 0 : Date.now() } });
    } catch (_) { /* không ghi được cài đặt cũng không ảnh hưởng kết quả lần này */ }
    deploying = false;
  }
}

function launcherInfo() {
  if (app.isPackaged) {
    return { target: process.execPath, args: '', cwd: path.dirname(process.execPath) };
  }
  return { target: process.execPath, args: `"${APP_ROOT}"`, cwd: APP_ROOT };
}

/** Sao chép đệ quy nội dung thư mục (best-effort, không xóa nguồn; dùng để chuyển file cũ một lần khi đổi đường dẫn thư mục chia sẻ) */
function copyDirContents(src, dest) {
  if (!fs.existsSync(src)) return;
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    try {
      if (entry.isDirectory()) copyDirContents(s, d);
      else fs.copyFileSync(s, d);
    } catch (_) { /* một file lỗi không ảnh hưởng các file còn lại */ }
  }
}

/** Bật một tính năng tùy chọn của Windows bằng quyền quản trị (như VirtualMachinePlatform / HypervisorPlatform) */
function enableWindowsFeature(feature) {
  return new Promise((resolve) => {
    const inner = `Enable-WindowsOptionalFeature -Online -FeatureName '${feature}' -NoRestart -All`;
    const ps = `Start-Process -FilePath powershell.exe -Verb RunAs -Wait `
      + `-ArgumentList @('-NoProfile','-NonInteractive','-Command',${JSON.stringify(inner)})`;
    const { spawn } = require('child_process');
    const proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    proc.on('exit', (code) => resolve({ ok: code === 0, restart: true, code }));
    proc.on('error', () => resolve({ ok: false, error: 'Không thể khởi động PowerShell' }));
  });
}

// ---------------- Cửa sổ chính ----------------

function createWindow({ show = true } = {}) {
  mainWindow = new BrowserWindow({
    width: 1140,
    height: 740,
    minWidth: 900,
    minHeight: 560,
    show: false,
    backgroundColor: '#f7f8fa',
    frame: false,
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#f7f8fa', symbolColor: '#2b3138', height: 44 },
    icon: nativeImage.createFromBuffer(ICON_PNG),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'ui', 'index.html'));
  if (show) mainWindow.once('ready-to-show', () => mainWindow.show());

  // Khi chạy smoke test, in lỗi của tiến trình render ra stdout: giao diện trắng, bấm nút không phản hồi,
  // mười phần thì tám chín là do một id trong app.js bị đổi rồi ném ngoại lệ, chạy bình thường không thấy được.
  if (process.argv.includes('--smoke')) {
    mainWindow.webContents.on('console-message', (_e, level, message, line, source) => {
      if (level >= 2) console.log(`[renderer] ${message} (${String(source).split('/').pop()}:${line})`);
    });
  }

  // Liên kết ngoài luôn giao cho trình duyệt hệ thống (tài khoản công khai/GitHub v.v.), tuyệt không điều hướng cửa sổ ứng dụng đi nơi khác
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  mainWindow.webContents.on('will-navigate', (e, url) => {
    if (url.startsWith('file://')) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  mainWindow.on('close', (e) => {
    if (quitting) return;
    e.preventDefault();
    mainWindow.hide();
    notify('ApkStart vẫn đang chạy nền', 'Bấm biểu tượng ở khay hệ thống để mở lại; chuột phải vào biểu tượng để thoát.');
  });

  if (IS_DEV) mainWindow.webContents.openDevTools({ mode: 'detach' });
  return mainWindow;
}

function showWindow() {
  if (!mainWindow) createWindow();
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notify(title, body) {
  if (store.getSettings().notifyOnInstall === false) return;
  try {
    const { Notification } = require('electron');
    if (Notification.isSupported()) new Notification({ title, body, icon: nativeImage.createFromBuffer(ICON_PNG) }).show();
  } catch (_) { /* ignore */ }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload);
}

// ---------------- Khay hệ thống ----------------

function buildTray() {
  const icon = loadBrandIcon(16);
  try {
    tray = new Tray(icon);
  } catch (_) {
    return;
  }
  const refresh = () => {
    const apps = store.getApps().slice(0, 8);
    const menu = Menu.buildFromTemplate([
      { label: 'Mở ApkStart', click: () => showWindow() },
      { type: 'separator' },
      ...(apps.length
        ? apps.map((a) => ({ label: a.label, click: () => runLaunch(a.package) }))
        : [{ label: 'Chưa cài ứng dụng nào', enabled: false }]),
      { type: 'separator' },
      {
        label: displaySettings().mode === 'fullscreen' ? 'Về cửa sổ dọc' : 'Toàn màn hình (tự vừa màn hình)',
        click: () => { toggleDisplayMode(); },
      },
      { label: 'Tạo lại lối tắt desktop/menu Start', click: () => { installer.ensureShortcuts().catch(() => {}); } },
      { label: 'Đồng bộ thư mục chia sẻ', click: () => sharer.sync() },
      { label: 'Cài đặt', click: () => { showWindow(); send('ui:navigate', 'settings'); } },
      {
        label: updateInfo && updateInfo.hasUpdate ? `Có phiên bản mới ${updateInfo.tag}` : 'Kiểm tra cập nhật',
        click: async () => {
          showWindow();
          send('ui:navigate', 'settings');
          const info = await updater.check().catch(() => null);
          if (info) { updateInfo = info; send('update:state', info); }
          if (info && info.hasUpdate && info.asset) {
            const r = await dialog.showMessageBox(mainWindow || undefined, {
              type: 'question',
              title: 'Có phiên bản mới',
              message: `ApkStart ${info.tag} đã phát hành, phiên bản hiện tại v${app.getVersion()}. Cập nhật ngay bây giờ?`,
              detail: (info.notes || '').slice(0, 600),
              buttons: ['Cập nhật ngay', 'Để sau'],
              defaultId: 0,
              cancelId: 1,
            });
            if (r.response === 0) runUpdate();
          } else if (info && !info.hasUpdate) {
            notify('Đã là phiên bản mới nhất', `ApkStart v${app.getVersion()}`);
          }
        },
      },
      { type: 'separator' },
      {
        label: 'Thoát',
        click: async () => {
          try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
          quitting = true;
          app.quit();
        },
      },
    ]);
    tray.setContextMenu(menu);
  };
  tray.setToolTip('ApkStart — Trình chạy ứng dụng Android');
  // Thói quen trên khay Windows là bấm một lần để mở cửa sổ chính (nhấp đúp tất nhiên cũng được).
  // Trước đây chỉ gắn double-click, người dùng bấm một lần không phản hồi, tưởng biểu tượng khay bị hỏng.
  // Chuột phải mới hiện menu, nên bấm một lần gọi thẳng showWindow không xung đột với menu.
  tray.on('click', () => showWindow());
  tray.on('double-click', () => showWindow());
  refresh();
  setInterval(refresh, 5000).unref?.();
}

// ---------------- Hành động cốt lõi ----------------

let installBusy = null;   // Đường dẫn file đang cài: nhấp đúp APK liên tục sẽ đi qua second-instance, không được cài song song
let lastInstallErr = { msg: '', at: 0 };

async function runInstall(filePath) {
  showWindow();
  // Cùng một gói đang cài (người dùng bấm biểu tượng nhiều lần / kéo thả nhiều lần) → chỉ báo một lần, đừng chạy cài lại
  if (installBusy) {
    if (installBusy === filePath) {
      send('toast', { type: 'info', message: 'APK này đang được cài, vui lòng chờ…' });
      return { ok: false, error: 'Đang cài đặt' };
    }
    send('toast', { type: 'info', message: 'Đang có tác vụ cài đặt khác, vui lòng chờ cài xong.' });
    return { ok: false, error: 'Đang có tác vụ cài đặt khác' };
  }
  installBusy = filePath;
  send('install:start', { file: filePath });
  try {
    const result = await installer.install(filePath, (p) => send('install:progress', p));
    send('install:done', result);
    // Biểu tượng desktop mới tạo phải để Explorer làm mới ngay, nếu không người dùng tưởng "chưa tạo lối tắt"
    windowctl.refreshShell().catch(() => {});
    notify('Cài đặt hoàn tất', `Đã cài ${result.app.label}${result.app.shortcutPath ? ', đã tạo lối tắt trên desktop' : ''}`);
    return result;
  } catch (e) {
    send('install:error', { message: e.message, file: filePath });
    if (e.needsSetup) send('ui:navigate', 'setup');
    // Cùng một lỗi trong 8 giây chỉ hiện thông báo hệ thống một lần: thử lại liên tục sẽ không spam góc dưới phải
    const now = Date.now();
    if (e.message !== lastInstallErr.msg || now - lastInstallErr.at > 8000) {
      lastInstallErr = { msg: e.message, at: now };
      // Khi cửa sổ ở tiền cảnh người dùng đã thấy thông báo trong giao diện, không cần thông báo hệ thống nữa
      if (!mainWindow || !mainWindow.isVisible() || mainWindow.isMinimized()) {
        notify('Cài đặt thất bại', e.message.slice(0, 120));
      }
    }
    throw e;
  } finally {
    installBusy = null;
  }
}

/**
 * Tải và cài phiên bản mới, sau đó script update-apply tiếp quản "thay thế + khởi động lại".
 * Giao diện và menu khay dùng chung đường này.
 */
async function runUpdate() {
  if (updateBusy) return { ok: false, error: 'Đang cập nhật' };
  updateBusy = true;
  const sendProgress = (p) => send('update:progress', p);
  try {
    const info = updateInfo && updateInfo.hasUpdate ? updateInfo : await updater.check();
    updateInfo = info;
    if (!info.hasUpdate) return { ok: false, error: 'Đã là phiên bản mới nhất' };
    if (!info.asset) {
      shell.openExternal(info.htmlUrl || Updater.repoUrl()).catch(() => {});
      return { ok: false, error: 'Phiên bản này không có gói cài trực tiếp, đã mở trang phát hành trên GitHub', manual: true };
    }
    sendProgress({ stage: 'download', percent: 0, message: 'Đang chuẩn bị tải…' });
    const job = await updater.prepare(info);
    sendProgress({ stage: 'apply', percent: 100, message: 'Đang thay thế chương trình và khởi động lại…' });
    updater.apply(job);
    // Cho giao diện chút thời gian hiển thị "sắp khởi động lại", rồi thoát theo luồng bình thường (before-quit sẽ giấu cửa sổ trình giả lập)
    setTimeout(() => { quitting = true; app.quit(); }, 900);
    return { ok: true, version: info.version, mode: job.mode };
  } catch (e) {
    sendProgress({ stage: 'error', percent: 0, message: e.message });
    return { ok: false, error: e.message };
  } finally {
    updateBusy = false;
  }
}

async function runLaunch(pkg) {
  const t0 = Date.now();
  const mark = (s) => appLog(`launch ${pkg} ${s} +${Date.now() - t0}ms`);
  appLog(`launch start ${pkg}`);
  try {
    // 1) Mở "cửa sổ ứng dụng" trước để hiện hiệu ứng khởi động: suốt quá trình không thấy màn hình chính Android lẫn cửa sổ trình giả lập
    openAppWindow(pkg, 'Đang khởi động môi trường Android…');
    // Trong giai đoạn khởi động, giấu cửa sổ chính trình giả lập + cửa sổ console đen của qemu / netsimd, tránh mọi lần nháy.
    // Chế độ ẩn là thường trực (sau embed nó tự bỏ qua cửa sổ được nhúng, xem appwin.embed).
    // Ở đây bắt buộc await: không chờ chế độ ẩn có hiệu lực mà chạy tiếp thì cửa sổ đen sẽ lộ ra lúc khởi động.
    if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
    if (mainWindow && mainWindow.isVisible() && !IS_DEV) mainWindow.hide();

    const r = await installer.launch(pkg, {
      onLog: (m) => { send('runtime:log', m); appLog(`  rt ${m}`); },
      onMark: mark,
      beforeStart: async (rt) => {
        mark('engine ready');
        appWin.setState({ tip: 'Đang mở ứng dụng…' });
        // Chế độ toàn màn hình + tắt hiệu ứng + bỏ màn khóa: chỉ làm một lần, các lần sau mở là vào ngay
        await rt.client.prepareForeground().catch(() => {});
        mark('foreground ready');
      },
    });
    mark('app started');

    // 2) Ứng dụng thật sự sống rồi mới nhúng hình vào cửa sổ (nếu không người dùng sẽ thấy màn hình chính/trang crash nháy lên)
    const embedded = await appWin.embed();
    if (!embedded) appLog(`embed failed: ${appWin.lastEmbedError || 'unknown'}`);
    mark(`embedded=${embedded}`);
    // Nhúng xong thì đưa cửa sổ lên khỏi các cửa sổ khác. Nếu không, cửa sổ phía trên (trình duyệt v.v.) sẽ che hình Android,
    // người dùng thấy "màn đen / hình không lấp đầy", chuột cũng không bấm được vào ứng dụng (bị cửa sổ trên nuốt hết).
    // Đặt topmost tạm rồi bỏ ngay, chỉ mượn một lần ghim trên cùng để đưa Z-order lên đầu, không chiếm lớp trên cùng lâu dài.
    if (appWin.isOpen) {
      try {
        appWin.win.show();
        appWin.win.setAlwaysOnTop(true);
        appWin.win.moveTop();
        appWin.win.focus();
        setTimeout(() => {
          if (appWin.isOpen) {
            try { appWin.win.setAlwaysOnTop(false); } catch (_) { /* cửa sổ đã đóng */ }
          }
        }, 700);
      } catch (_) { /* cửa sổ có thể vừa đóng */ }
    }
    appWin.setState({ ready: true, tip: '' });
    // Nhúng thất bại (cửa sổ trình giả lập chưa tạo xong) thì thử thêm hai lần: người dùng đang thấy cửa sổ đen,
    // bù ở nền là trở lại bình thường, không bắt người dùng tự mở lại.
    if (!embedded) {
      setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 1500);
      setTimeout(() => { if (appWin.isOpen) appWin.embed().catch(() => {}); }, 4000);
    }
    // Phiên container: môi trường đã sẵn sàng, ở đây chỉ làm "cắt gọn theo ứng dụng + bật thăm dò nền",
    // không khởi động lại Android cho App này nữa. Hook phím chuột do sự kiện focus của cửa sổ
    // quyết định theo cài đặt, mất focus là gỡ.
    deviceSize.value = null;
    appWin.refreshPointer();
    await runtime.beginApp(pkg, { onActive: onContainerActive }).catch(() => {});
    // Chế độ game/độ trễ thấp: cho tác tử cửa sổ giảm tần suất quét, bớt giật toàn máy do EnumWindows trên cả desktop
    if (winAgent) {
      const game = store.getSettings().engine?.priorityMode === 'game';
      winAgent.setPerformanceMode(game).catch(() => {});
    }
    send('app:launched', { package: pkg, engine: r.engine });
    appLog(`launch ok ${pkg} embedded=${embedded}`);
    return { ok: true, embedded };
  } catch (e) {
    appLog(`launch failed ${pkg}: ${e && (e.stack || e.message)}`);
    try { appWin.close({ keepApp: true }); } catch (_) { /* ignore */ }
    // Khởi động thất bại cũng tiếp tục ẩn cửa sổ trình giả lập (đừng để nó lộ ra dưới dạng "cửa sổ trình giả lập độc lập"),
    // lần sau bấm ứng dụng vẫn đi theo đường ẩn → embed như cũ.
    if (winAgent) armAgent(winAgent).catch(() => {});
    showWindow();
    send('toast', { type: 'error', message: `Khởi động thất bại: ${e.message}` });
    return { ok: false, error: e.message };
  }
}

/**
 * Bật/tắt tác vụ nền tùy container có/không có cửa sổ ứng dụng.
 * Đồng bộ file cứ 8 giây phải duyệt thư mục chia sẻ và chạy adb find/stat, cầu thông báo cũng đang thăm dò;
 * trước đây ApkStart vừa mở là chạy vô điều kiện, dù chưa mở ứng dụng Android nào.
 * Nay chỉ bật khi container thật sự có ứng dụng, đóng cửa sổ cuối cùng là dừng ngay.
 */
function onContainerActive(on) {
  if (on) {
    sharer?.start(8000);
    startNotifier();
  } else {
    sharer?.stop();
    notifier?.stop();
  }
}

/** Cầu thông báo: chỉ thăm dò khi có cửa sổ ứng dụng, đóng cửa sổ là dừng, tránh chạy không */
function startNotifier() {
  if (!notifier) {
    notifier = new NotifyBridge({
      getClient: () => runtime.client(),
      getAppLabel: (pkg) => (store.getApp(pkg) || {}).label || pkg,
      getAppIcon: (pkg) => (store.getApp(pkg) || {}).icoPath || '',
      onOpen: (pkg) => {
        if (appWin && appWin.isOpen && appWin.pkg === pkg) {
          appWin.win.show();
          appWin.win.focus();
        } else {
          runLaunch(pkg).catch(() => {});
        }
      },
    });
  }
  notifier.start();
}

// ---------------- IPC ----------------

function registerIpc() {
  ipcMain.handle('app:info', () => ({    version: app.getVersion(),
    isDev: IS_DEV,
    dataDir: store.DATA_DIR,
    runtimeDir: runtime.provisioner.paths().root,
    diskFreeMB: (() => {
      try { return require('./core/doctor').freeDiskMB(runtime.provisioner.paths().root); } catch (_) { return 0; }
    })(),
    exe: process.execPath,
    packaged: app.isPackaged,
  }));

  // Cách khởi động (tự khởi động cùng Windows / nhấp đúp mở): thẻ chào mừng dựa vào đây để quyết định có tự hiện không
  ipcMain.handle('app:startupInfo', () => {
    const a = parseArgs(process.argv);
    return {
      autostart: process.argv.includes('--autostart') || !!a.silent,
      launch: a.launch || null,
      smoke: process.argv.includes('--smoke'),
      version: app.getVersion(),
      isPackaged: app.isPackaged,
    };
  });

  // Chọn thư mục (để chuyển môi trường chạy/image/ứng dụng đã cài sang ổ không phải ổ hệ thống)
  ipcMain.handle('dialog:openDir', async (_e, defaultPath) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn thư mục lưu dữ liệu',
      defaultPath: defaultPath || store.DATA_DIR,
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths || !r.filePaths[0]) return null;
    return r.filePaths[0];
  });

  ipcMain.handle('apps:list', async () => {
    const apps = store.getApps();
    const settings = store.getSettings();
    let running = [];
    try {
      const c = runtime.client();
      if (await c.isOnline()) running = await c.runningPackages();
    } catch (_) { /* bỏ qua khi môi trường chạy chưa khởi động */ }
    return apps
      .map((a) => ({
        ...a,
        running: running.includes(a.package),
        iconUrl: a.iconPath && fs.existsSync(a.iconPath)
          ? `file:///${a.iconPath.replace(/\\/g, '/').replace(/ /g, '%20')}`
          : null,
        shortcutExists: a.shortcutPath ? fs.existsSync(a.shortcutPath) : false,
      }))
      .sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.lastLaunchAt || 0) - (a.lastLaunchAt || 0) || a.label.localeCompare(b.label, 'zh'));
  });

  ipcMain.handle('apk:pick', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn APK để cài đặt',
      filters: [{ name: 'Ứng dụng Android', extensions: ['apk', 'apks', 'xapk'] }],
      properties: ['openFile', 'multiSelections'],
    });
    if (r.canceled) return [];
    return r.filePaths;
  });

  ipcMain.handle('apk:parse', async (_e, filePath) => parseApk(filePath));

  ipcMain.handle('apk:install', async (_e, filePath) => {
    const r = await runInstall(filePath);
    return { ok: true, app: r.app, warnings: r.warnings };
  });

  ipcMain.handle('app:launch', async (_e, pkg) => runLaunch(pkg));

  ipcMain.handle('app:uninstall', async (_e, pkg) => {
    await installer.uninstall(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:shortcut', async (_e, pkg) => {
    const appRecord = store.getApp(pkg);
    if (!appRecord) throw new Error('Ứng dụng không tồn tại');
    const p = installer.createShortcut(appRecord);
    store.upsertApp({ package: pkg, shortcutPath: p });
    return { ok: true, path: p };
  });

  ipcMain.handle('app:clearData', async (_e, pkg) => {
    const rt = await runtime.ensure();
    if (!rt.ok) throw new Error(rt.error);
    await rt.client.clearData(pkg);
    return { ok: true };
  });

  ipcMain.handle('app:pin', async (_e, { pkg, pinned }) => {
    store.upsertApp({ package: pkg, pinned: !!pinned });
    return { ok: true };
  });

  ipcMain.handle('app:revealApk', async (_e, pkg) => {
    const a = store.getApp(pkg);
    if (a?.apkPath && fs.existsSync(a.apkPath)) shell.showItemInFolder(a.apkPath);
  });

  ipcMain.handle('apk:reveal', async () => {
    fs.mkdirSync(store.APK_DIR, { recursive: true });
    shell.openPath(store.APK_DIR);
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    const next = store.saveSettings(patch);
    if (patch && patch.autoStart !== undefined) applyAutoStart();
    if (patch && patch.display && appWin && appWin.isOpen) {
      // Kích thước chuẩn màn dọc đã đổi: chỉ ảnh hưởng cửa sổ mở sau này, không làm gián đoạn ứng dụng đang chạy
      appWin.portrait = portraitSize();
    }
    // Khi bật "lối tắt menu Start" thì bổ sung ngay, không phải chờ lần cài sau
    if (patch && (patch.createStartMenuShortcut === true || patch.createShortcutOnInstall === true)) {
      installer.ensureShortcuts().catch(() => {});
    }
    // Phím chuột đã đổi: cài/gỡ hook ngay theo focus hiện tại, không phải chờ lần chuyển cửa sổ sau
    if (patch && patch.engine && (
      'mouseRightBack' in patch.engine || 'mouseWheelMode' in patch.engine || 'mouseSideButtons' in patch.engine
    )) {
      refreshPointerMapping();
    }
    // Đổi nguồn cập nhật / tiền tố mirror / địa chỉ gói trọn bộ: kết luận "nguồn nào nhanh nhất" trước đó không còn đúng, xóa cache đo tốc độ;
    // địa chỉ gói môi trường chạy / engine / image còn cache trong provisioner._cache, không xóa thì phải khởi động lại tiến trình mới có hiệu lực.
    if (patch && patch.runtime && (
      'sourcePreference' in patch.runtime || 'mirrorPrefix' in patch.runtime
      || 'autoMirror' in patch.runtime || 'runtimePackUrl' in patch.runtime
      || 'emulatorUrl' in patch.runtime || 'sysimgUrl' in patch.runtime
    )) {
      try {
        updater?.sources?.reset();
        runtime?.provisioner?.sources?.reset();
        runtime?.provisioner?.invalidateEnvCache?.();
      } catch (_) { /* ignore */ }
    }
    return next;
  });

  /**
   * Đổi thư mục chia sẻ trên máy: chuyển một lần các file có sẵn ở thư mục cũ sang thư mục mới (best-effort, không xóa file cũ),
   * rồi lưu cài đặt. Sharer mỗi lần đồng bộ đều đọc động store.getSettings().sharedDir, không cần khởi động lại.
   */
  ipcMain.handle('settings:setSharedDir', async (_e, dir) => {
    if (!dir || !dir.trim()) return { ok: false, error: 'Thư mục không được để trống' };
    const newDir = dir.trim();
    const oldDir = store.getSettings().sharedDir;
    try {
      if (oldDir && oldDir !== newDir) copyDirContents(oldDir, newDir);
      fs.mkdirSync(newDir, { recursive: true });
      store.saveSettings({ sharedDir: newDir });
      return { ok: true, oldDir, newDir };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Chế độ hiển thị / Lối tắt / Triển khai một chạm ----------------

  ipcMain.handle('display:state', () => ({
    ...displaySettings(),
    screen: screenRect(),
    current: currentAppPkg,
  }));

  ipcMain.handle('display:set', async (_e, patch) => {
    const next = store.saveSettings({ display: patch || {} });
    if (appWin && appWin.isOpen) {
      appWin.portrait = portraitSize();
      const full = next.display.mode === 'fullscreen';
      if (full && !appWin.win.isMaximized()) appWin.win.maximize();
      if (!full && appWin.win.isMaximized()) appWin.win.unmaximize();
      // Toàn màn hình = bố cục máy tính bảng nằm ngang (xem giải thích ở toggleDisplayMode)
      appWin.setLandscape(full).catch(() => {});
      appWin.scheduleFit();
    }
    return next.display;
  });

  ipcMain.handle('display:toggle', () => toggleDisplayMode());

  ipcMain.handle('shortcut:rebuild', async () => ({ ok: true, fixed: await installer.ensureShortcuts() }));
  // Khi người dùng tự bấm "Triển khai một chạm" thì ép thử lại, bỏ qua thời gian chờ sau thất bại
  ipcMain.handle('runtime:autoDeploy', (_e, opts = {}) => autoDeploy({ force: !!opts.force }));
  // Khi tắt "Cắt gọn sâu" thì khôi phục các gói hệ thống bị pm disable-user
  ipcMain.handle('settings:restoreSystem', async () => runtime.restoreSystemApps());
  // Phím chuột thay đổi: chỉ đồng bộ cấu hình, không gỡ vô điều kiện nữa (chuột phải quay lại/con lăn có thể vẫn cần hook)
  ipcMain.handle('settings:refreshPointer', async () => { refreshPointerMapping(); return true; });
  // Tương thích giao diện cũ: ý nghĩa đã đổi thành "đồng bộ lại theo cài đặt"
  ipcMain.handle('settings:unhook', async () => { refreshPointerMapping(); return true; });

  ipcMain.handle('runtime:status', async () => runtime.status());
  ipcMain.handle('runtime:probe', async () => runtime.probe());
  ipcMain.handle('runtime:start', async () => {
    const r = await runtime.ensure({ onLog: (m) => send('runtime:log', m) });
    return r.ok ? { ok: true, engine: r.engine } : { ok: false, error: r.error, needsSetup: r.needsSetup };
  });
  ipcMain.handle('runtime:stop', async () => {
    await runtime.stop();
    return { ok: true };
  });
  ipcMain.handle('runtime:log', () => runtime.bootLog);

  // ---------------- Chẩn đoán / Thu gọn ----------------

  ipcMain.handle('doctor:profile', async () => {
    const doctor = require('./core/doctor');
    // Đã khởi động thì dùng tham số đang chạy thực; chưa khởi động cũng phải suy ra theo "phiên bản engine thật + trạng thái tăng tốc thật",
    // nếu không trang cài đặt sẽ hiện swiftshader_indirect / giả lập phần mềm đã lỗi thời, không khớp với thực tế.
    let p = runtime.emulator.profile;
    if (!p) {
      const env = await runtime.provisioner.checkEnv();
      p = doctor.autoProfile({
        settings: store.getSettings(),
        accel: env.accel,
        emulatorVersion: env.emulator.version || '',
        diskMB: doctor.freeDiskMB(store.DATA_DIR),
      });
    }
    return { profile: p, text: doctor.describeProfile(p) };
  });

  ipcMain.handle('doctor:report', async () => {
    const r = await runtime.diagnostics();
    shell.showItemInFolder(r.file);
    return r;
  });

  /**
   * Tự kiểm tra vấn đề hệ thống: trước khi khởi động/khi đang chạy tự kiểm tra các nguyên nhân gốc thường gặp gây "không cài được, không chạy được",
   * và đưa ra gợi ý sửa có thể thao tác (hiển thị ở banner trang chủ + bảng cài đặt, sửa một chạm theo từng vấn đề).
   */
  ipcMain.handle('doctor:selfCheck', async () => {
    const doctor = require('./core/doctor');
    const issues = [];
    // Hai giá trị này gán trong try, trả về ngoài try, phải khai báo ngoài phạm vi
    let accel = { ok: false };
    let free = 0;
    try {
      if (!doctor.vcRedistOk()) {
        issues.push({
          code: 'vcRedist', severity: 'error', title: 'Thiếu thư viện VC++ Runtime (x64)',
          hint: 'Môi trường chạy Android cần Microsoft VC++ 2015-2022, thiếu sẽ khiến trình giả lập không khởi động được (0xc0000135).', fix: 'vcRedist',
        });
      }
      accel = await runtime.provisioner.emulatorAccel().catch(() => ({ ok: false }));
      if (!accel.ok) {
        issues.push({
          code: 'accel', severity: 'warn', title: 'Chưa bật tăng tốc phần cứng',
          hint: (accel.note || 'Sẽ lùi về giả lập phần mềm (chạy được nhưng rất chậm). Bật ảo hóa để có hiệu năng tốt nhất.'), fix: 'virtualization',
        });
      }
      free = doctor.freeDiskMB(runtime.provisioner.paths().root);
      if (free && free < 8192) {
        issues.push({
          code: 'disk', severity: free < 2048 ? 'error' : 'warn', title: 'Ổ đĩa môi trường chạy sắp hết dung lượng',
          hint: `Ổ chứa "${runtime.provisioner.paths().root}" chỉ còn ${free} MB, môi trường chạy và image có thể làm đầy ổ đĩa.`, fix: 'disk',
        });
      }
      const rtDir = runtime.provisioner.paths().root;
      if (!doctor.isAsciiPath(rtDir)) {
        issues.push({
          code: 'pathRuntime', severity: 'warn', title: 'Thư mục môi trường chạy chứa ký tự không phải ASCII/ký tự đặc biệt',
          hint: 'Một số thành phần môi trường chạy nhạy cảm với đường dẫn có dấu/Unicode, có thể gây lỗi khởi động. Nên đổi sang thư mục chỉ có ký tự tiếng Anh không dấu.', fix: 'path',
        });
      }
      const env = await runtime.provisioner.checkEnv().catch(() => ({}));
      if (!env.adb || !env.adb.ok) {
        issues.push({ code: 'adb', severity: 'error', title: 'Thiếu bộ công cụ adb', hint: 'Không thể kết nối môi trường chạy Android.', fix: 'deploy' });
      }
      if (!env.emulator || !env.emulator.ok) {
        issues.push({ code: 'emulator', severity: 'error', title: 'Chưa cài engine môi trường chạy', hint: 'Cần triển khai engine môi trường chạy trước (khoảng 440MB).', fix: 'deploy' });
      }
      if (!env.sysimg || !env.sysimg.ok) {
        issues.push({ code: 'sysimg', severity: 'warn', title: 'System image chưa sẵn sàng', hint: 'Cần tải system image Android trước (khoảng 1.5GB).', fix: 'deploy' });
      }
      // File khóa còn sót: khiến lần khởi động sau bị coi là "AVD đang bị chiếm" và FATAL
      const avdHome = runtime.provisioner.paths().avdHome;
      let locked = false;
      try { for (const f of fs.readdirSync(avdHome)) { if (/\.lock$/i.test(f)) { locked = true; break; } } } catch (_) { /* ignore */ }
      if (locked) {
        issues.push({ code: 'lock', severity: 'warn', title: 'Phát hiện file khóa còn sót từ lần trước', hint: 'Có thể khiến lần khởi động sau bị coi là "AVD đang bị chiếm".', fix: 'lock' });
      }
    } catch (_) { /* tự kiểm tra lỗi không chặn việc sử dụng */ }
    return { issues, accel, free };
  });

  // Thư viện Microsoft VC++ 2015-2022 x64: trình giả lập Android (Qt6) và qemu đều cần nó.
  // Thiếu thì trên "máy khác" sẽ không chạy được (0xc0000135 / thiếu MSVCP140).
  function vcRedistInstaller() {
    const p = runtime.provisioner.paths();
    const cands = [
      path.join(p.root, 'vc_redist.x64.exe'),
      path.join(process.resourcesPath || '', 'runtime', 'vc_redist.x64.exe'),
    ];
    return cands.find((c) => c && fs.existsSync(c)) || null;
  }
  ipcMain.handle('runtime:vcRedist', () => {
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk(), path: vcRedistInstaller() };
  });
  ipcMain.handle('runtime:installVcRedist', async () => {
    const file = vcRedistInstaller();
    if (!file) return { ok: false, reason: 'no-installer' };
    const { spawn } = require('child_process');
    await new Promise((resolve) => {
      // Cài với quyền nâng cao qua RunAs (VC++ là thành phần cấp hệ thống, cần quản trị viên); /quiet im lặng, /norestart không khởi động lại
      const ps = spawn('powershell.exe', ['-NoProfile', '-Command',
        `Start-Process -FilePath "${file}" -ArgumentList '/quiet','/norestart' -Verb RunAs -Wait`],
      { windowsHide: true, stdio: 'ignore' });
      ps.on('exit', () => resolve());
      ps.on('error', () => resolve());
    });
    const doctor = require('./core/doctor');
    return { ok: doctor.vcRedistOk() };
  });

  ipcMain.handle('runtime:usage', () => runtime.usage());

  // Hộp xác nhận dùng chung (tầng render đều đi qua đây, tránh mỗi nơi tự ghép nội dung dialog)
  ipcMain.handle('app:confirm', async (_e, opts = {}) => {
    const { response } = await dialog.showMessageBox(mainWindow || undefined, {
      type: opts.type || 'question',
      title: opts.title || 'Xác nhận',
      message: opts.message || '',
      detail: opts.detail || '',
      buttons: ['Hủy', opts.okLabel || 'OK'],
      defaultId: 1,
      cancelId: 0,
      noLink: true,
    });
    return { response };
  });

  // Dung lượng phân vùng dữ liệu (/data): ứng dụng, game và các gói cập nhật của chúng đều cài ở đây.
  // "Game cập nhật báo thiếu dung lượng" gần như luôn do mục này quá nhỏ, mở rộng làm tại chỗ, không mất dữ liệu.
  ipcMain.handle('runtime:dataInfo', () => {
    const doctor = require('./core/doctor');
    const info = runtime.emulator.dataInfo();
    return { ...info, freeDiskMB: doctor.freeDiskMB(runtime.provisioner.paths().root) };
  });

  ipcMain.handle('runtime:setDataSize', async (_e, gb) => {
    const want = Math.max(0, Math.min(64, Number(gb) || 0));
    store.saveSettings({ engine: { dataPartitionGB: want } });
    if (!want) {
      const info = runtime.emulator.dataInfo();
      return { ok: true, auto: true, ...info };
    }
    const mb = Math.round(want * 1024);
    // Image đang bị qemu chiếm thì không đổi được, dừng container trước (ứng dụng sẽ thoát theo, là bình thường)
    let stopped = false;
    try {
      const online = await runtime.client().isOnline().catch(() => false);
      if (runtime.emulator.running() || online) {
        await runtime.stop().catch(() => {});
        stopped = true;
      }
    } catch (_) { /* ignore */ }
    try {
      const r = runtime.emulator.resizeDataPartition(mb);
      appLog(`data partition -> ${want}GB: ${JSON.stringify(r)}`);
      if (r && r.ok) notify('Đã điều chỉnh phân vùng dữ liệu', `Dung lượng khả dụng của Android khoảng ${want} GB${stopped ? ' (môi trường chạy đã khởi động lại)' : ''}`);
      return { ok: !!(r && r.ok), stopped, ...r, ...runtime.emulator.dataInfo() };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:cleanup', async (_e, opts = {}) => {
    // Xác nhận rõ hai lần: đưa danh sách trước, người dùng xác nhận mới thật sự xóa; và chỉ dọn thư mục môi trường chạy của chính ApkStart
    const pass = { apply: false, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots };
    if (!opts.apply) return runtime.cleanup(pass);
    const preview = await runtime.cleanup(pass);
    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'warning',
      buttons: ['Hủy', `Dọn ${preview.candidates.length} mục`],
      defaultId: 0,
      cancelId: 0,
      title: 'Xác nhận dọn bộ đệm môi trường chạy',
      message: `Sẽ giải phóng khoảng ${(preview.candidates.reduce((n, c) => n + c.size, 0) / 1048576).toFixed(0)} MB`,
      detail: (opts.includeSnapshots
        ? 'Sẽ dừng môi trường chạy trước, rồi xóa image cũ, snapshot khởi động nhanh của AVD hiện tại, file khóa và bộ đệm của các AVD không hoạt động. Bản thân ứng dụng đã cài được giữ lại (chỉ xóa snapshot). '
        : 'Chỉ xóa image cũ, snapshot cũ, file khóa và bộ đệm của các AVD không hoạt động, ứng dụng đã cài được giữ lại. ')
        + 'Thao tác này không thể hoàn tác, nên xuất báo cáo chẩn đoán trước.',
    });
    if (response !== 1) return { ...preview, cancelled: true };
    return runtime.cleanup({ apply: true, aggressive: !!opts.aggressive, includeSnapshots: !!opts.includeSnapshots });
  });

  // Đặt lại hoàn toàn dữ liệu Android: xóa sạch phân vùng người dùng /data + ứng dụng đã cài + snapshot khởi động nhanh,
  // AVD trở về trạng thái sạch "vừa cài hệ thống". Sẽ xóa thật vài GB dữ liệu, UI phải xác nhận hai lần.
  ipcMain.handle('runtime:resetData', async () => {
    try {
      const r = await runtime.resetAndroidData();
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, reclaimed: r.reclaimed, reclaimedMB: Math.round(r.reclaimed / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Sửa mạng máy ảo: đặt lại /data (giữ danh sách ứng dụng, mở ứng dụng sẽ tự cài lại).
  // Tình huống điển hình: mọi trang cần mạng trong Android đều đen màn hình, thực ra là wlan0 chưa lên, không có tuyến mặc định.
  ipcMain.handle('runtime:repairNetwork', async () => {
    try {
      const r = await runtime.repairNetwork({
        onLog: (m) => send('toast', { message: m, kind: 'info', timeout: 6000 }),
      });
      return r;
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // Chỉ kiểm tra mạng, không đụng dữ liệu nào (trang cài đặt dùng để hiển thị trạng thái hiện tại)
  ipcMain.handle('runtime:checkNetwork', async () => {
    try {
      const network = await runtime.emulator.checkNetwork(runtime.adbPath());
      return { ok: !!network.ok, network };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Tàn dư phiên bản cũ ----------------

  /** Chỉ quét, không xóa: đưa nguyên trạng "tìm thấy gì" cho giao diện, để người dùng quyết định */
  ipcMain.handle('leftovers:scan', () => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const dataDir = store.DATA_DIR;
      let avdHome = '';
      try { avdHome = runtime.provisioner.paths().avdHome; } catch (_) { avdHome = ''; }
      return { ok: true, ...leftovers.scan({ installDir, dataDir, avdHome }) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('leftovers:clean', (_e, items) => {
    try {
      const installDir = path.dirname(app.getPath('exe'));
      const r = leftovers.clean(Array.isArray(items) ? items : [], { installDir });
      appLog(`leftovers cleaned: ${r.removed.length} removed, ${r.failed.length} failed`);
      return { ok: true, ...r, freedMB: Math.round(r.freedBytes / 1048576) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  // ---------------- Tự khởi tạo môi trường chạy ----------------

  ipcMain.handle('provision:installEmulator', async () => {
    try {
      const r = await runtime.provisioner.installEmulator(
        (p) => send('provision:progress', { ...p, component: 'emulator' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installSysimg', async () => {
    try {
      const r = await runtime.provisioner.installSystemImage(
        (p) => send('provision:progress', { ...p, component: 'sysimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installPlayImage', async () => {
    try {
      const r = await runtime.provisioner.installPlayImage(
        (p) => send('provision:progress', { ...p, component: 'playimg' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAehd', async () => {
    try {
      const r = await runtime.provisioner.installAehd(
        (p) => send('provision:progress', { ...p, component: 'aehd' }),
      );
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /** Cài driver AEHD với quyền nâng cao: hiện UAC, người dùng xác nhận rồi cài im lặng */
  ipcMain.handle('provision:enableAccel', async () => {
    try {
      const p = runtime.provisioner.paths();
      const bat = path.join(p.aehdDir, 'silent_install.bat');
      if (!fs.existsSync(bat)) {
        const r = await runtime.provisioner.installAehd(
          (x) => send('provision:progress', { ...x, component: 'aehd' }),
        );
        if (!fs.existsSync(bat)) throw new Error(r.error || 'Gói driver AEHD chưa sẵn sàng');
      }

      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], {
          windowsHide: true,
        });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Đã hủy cấp quyền quản trị (cần bấm "Có" để cài driver)' : `Cài driver thất bại (mã thoát ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });

      const accel = await runtime.provisioner.emulatorAccel();
      return { ok: accel.ok, accel, error: accel.ok ? '' : accel.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Tự bật ảo hóa: người dùng không cần tự vào bảng "Windows Features".
   * Ưu tiên bật tính năng "Virtual Machine Platform" (WHPX) có sẵn của hệ thống; nếu ngay DLL đó cũng không có (hệ thống cũ),
   * thì chuyển sang cài và bật driver AEHD của Google. Cả hai cách đều cần quyền quản trị.
   */
  ipcMain.handle('provision:enableVirtualization', async () => {
    try {
      const accel = await runtime.provisioner.emulatorAccel();
      if (accel.ok) return { ok: true, already: true, accel, note: 'Tăng tốc phần cứng đã khả dụng, không cần làm gì thêm' };

      const hv = await runtime.provisioner.hypervisor();
      if (hv.dll) {
        // Hệ thống có WinHvPlatform.dll: bật tính năng "Virtual Machine Platform" (có thể cần khởi động lại)
        const r = await enableWindowsFeature('VirtualMachinePlatform');
        const r2 = await enableWindowsFeature('HypervisorPlatform').catch(() => ({ ok: false }));
        const ok = r.ok || r2.ok;
        const after = await runtime.provisioner.emulatorAccel();
        return {
          ok,
          restartNeeded: r.restart || r2.restart,
          accel: after,
          note: ok
            ? (r.restart ? 'Đã bật "Virtual Machine Platform", hãy khởi động lại máy để có hiệu năng tốt nhất' : 'Đã bật "Virtual Machine Platform", tăng tốc phần cứng có hiệu lực ngay')
            : (r.error || r2.error || 'Không thể bật tính năng ảo hóa của hệ thống'),
        };
      }

      // Không có thành phần WHPX: chuyển sang driver AEHD (của Google, cài xong dùng được ngay)
      const ae = await runtime.provisioner.installAehd(
        (x) => send('provision:progress', { ...x, component: 'aehd' }),
      ).catch((e) => ({ ok: false, error: e.message }));
      if (!ae.ok) return { ok: false, error: ae.error || 'Chuẩn bị gói driver AEHD thất bại' };
      const bat = path.join(runtime.provisioner.paths().aehdDir, 'silent_install.bat');
      await new Promise((resolve, reject) => {
        const { spawn: sp } = require('child_process');
        const esc = bat.replace(/'/g, "''");
        const ps = `try { $p = Start-Process -FilePath '${esc}' -WorkingDirectory '${path.dirname(bat).replace(/'/g, "''")}' -Verb RunAs -Wait -PassThru; exit $p.ExitCode } catch { exit 2 }`;
        const proc = sp('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { windowsHide: true });
        proc.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(
          code === 2 ? 'Đã hủy cấp quyền quản trị (cần bấm "Có" để cài driver)' : `Cài driver thất bại (mã thoát ${code})`,
        ))));
        proc.on('error', (e) => reject(e));
      });
      const after = await runtime.provisioner.emulatorAccel();
      return { ok: after.ok, accel: after, note: after.ok ? 'Đã bật tăng tốc phần cứng AEHD' : after.note };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installAdb', async () => {
    try {
      const r = await runtime.provisioner.installAdb((p) => send('provision:progress', { ...p, component: 'adb' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:installQemu', async () => {
    try {
      const r = await runtime.provisioner.installQemu((p) => send('provision:progress', { ...p, component: 'qemu' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:downloadIso', async () => {
    try {
      const r = await runtime.provisioner.downloadIso((p) => send('provision:progress', { ...p, component: 'iso' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:createDisk', async (_e, sizeGB) => {
    try {
      const r = await runtime.provisioner.createDisk(sizeGB || store.getSettings().runtime.diskSizeGB || 24,
        (p) => send('provision:progress', { ...p, component: 'disk' }));
      return { ok: true, ...r };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importIso', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn system image Android-x86 / Bliss OS',
      filters: [{ name: 'System image', extensions: ['iso', 'img'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      return { ok: true, ...runtime.provisioner.importIso(r.filePaths[0]) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:importDisk', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: 'Chọn ổ đĩa ảo đã cài Android',
      filters: [{ name: 'Ổ đĩa ảo', extensions: ['qcow2', 'img', 'vmdk', 'raw'] }],
      properties: ['openFile'],
    });
    if (r.canceled) return { ok: false, canceled: true };
    try {
      const info = runtime.provisioner.importDisk(r.filePaths[0]);
      store.saveSettings({ runtime: { installed: true } });
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('provision:check', async () => runtime.provisioner.checkEnv());
  ipcMain.handle('provision:probeSources', async () => runtime.provisioner.probeSources());

  ipcMain.handle('runtime:startInstaller', async () => {
    try {
      await runtime.startInstaller({ onLog: (m) => send('runtime:log', m) });
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('runtime:markInstalled', async () => {
    await runtime.markInstalled();
    return { ok: true };
  });

  ipcMain.handle('runtime:resetInstall', async () => {
    store.saveSettings({ runtime: { installed: false } });
    return { ok: true };
  });

  ipcMain.handle('assoc:status', () => {
    // Môi trường smoke test/không có shell: không dò registry (reg.exe có thể bị chính sách chặn)
    if (NO_SHELL_PROBE) return { registered: false, skipped: true };
    const { execFileSync } = require('child_process');
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Classes\\.apk', '/ve'], { windowsHide: true, encoding: 'utf8' });
      return { registered: out.includes(assoc.PROGID) };
    } catch (_) {
      return { registered: false };
    }
  });

  ipcMain.handle('assoc:register', () => {
    const l = launcherInfo();
    const icoPath = path.join(store.ICON_DIR, 'apkstart.ico');
    if (!fs.existsSync(icoPath)) {
      // Ưu tiên dùng file ICO thương hiệu nhiều kích thước đi kèm gói, nếu thiếu thì tạo từ Logo PNG
      if (fs.existsSync(APPICON_FILE)) fs.copyFileSync(APPICON_FILE, icoPath);
      else {
        const { pngToIco } = require('./core/shortcut');
        const ico = pngToIco(ICON_PNG);
        if (ico) fs.writeFileSync(icoPath, ico);
      }
    }
    return assoc.registerAssociation(l.target, icoPath, l.args);
  });

  ipcMain.handle('assoc:unregister', () => assoc.unregisterAssociation());

  ipcMain.handle('share:sync', async () => sharer.sync({ onLog: (m) => send('runtime:log', m) }));
  ipcMain.handle('share:open', async () => {
    const dir = store.getSettings().sharedDir;
    fs.mkdirSync(dir, { recursive: true });
    shell.openPath(dir);
  });

  /** Dọn file khóa AVD còn sót từ lần trước: chúng khiến lần khởi động sau bị nhận nhầm là "AVD đang bị chiếm" và FATAL */
  ipcMain.handle('app:clearLocks', async () => {
    try {
      const avdHome = runtime.provisioner.paths().avdHome;
      let removed = 0;
      for (const f of fs.readdirSync(avdHome)) {
        if (/\.lock$/i.test(f)) {
          try { fs.rmSync(path.join(avdHome, f), { force: true }); removed++; } catch (_) { /* ignore */ }
        }
      }
      return { ok: true, removed };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  /**
   * Gỡ cài đặt ApkStart một chạm:
   * 1) Hủy liên kết file .apk trước (tránh sau khi gỡ, nhấp đúp APK lại trỏ tới chương trình đã xóa)
   * 2) Bản cài đặt: chạy trình gỡ cài đặt NSIS (nó tự xin quyền quản trị/xác nhận), sau đó thoát chương trình này
   * 3) Bản portable (không cài đặt): không có uninstaller.exe, trả về thông báo để người dùng tự xóa chương trình và thư mục dữ liệu
   */
  ipcMain.handle('app:removeSelf', async () => {
    try {
      try { await assoc.unregisterAssociation(); } catch (_) { /* hủy liên kết thất bại không ảnh hưởng việc gỡ cài đặt */ }
      const exeDir = path.dirname(process.execPath);
      const uninstaller = path.join(exeDir, 'uninstaller.exe');
      if (!fs.existsSync(uninstaller)) {
        return { ok: true, portable: true, dataDir: store.DATA_DIR, exeDir };
      }
      const { spawn } = require('child_process');
      // Trước khi gỡ, tắt trình giả lập thường trực: qemu sẽ khóa exe/dll trong resources\runtime,
      // NSIS không xóa được sẽ để lại nửa thư mục cài đặt. Chỉ áp dụng khi "thật sự đang gỡ", không ảnh hưởng thoát thường ngày.
      try { await runtime?.emulator?.killOrphanProcesses(); } catch (_) { /* ignore */ }
      // Cho chương trình này thoát trước, rồi một tiến trình độc lập chờ 2 giây mới chạy trình gỡ cài đặt:
      // exe đang chạy sẽ khóa file trong thư mục cài đặt, chạy trình gỡ ngay dễ xóa không sạch.
      const cmd = `ping 127.0.0.1 -n 3 >nul & start "" "${uninstaller}"`;
      spawn('cmd.exe', ['/c', cmd], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      setTimeout(() => app.quit(), 300);
      return { ok: true, portable: false };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });

  ipcMain.handle('shell:open', (_e, url) => shell.openExternal(url));

  ipcMain.handle('window:minimize', () => mainWindow?.minimize());
  ipcMain.handle('window:maximize', () => {
    if (!mainWindow) return;
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
  });
  ipcMain.handle('window:close', () => mainWindow?.close());
  ipcMain.handle('window:hide', () => mainWindow?.hide());

  // ---------------- Cửa sổ ứng dụng (chỉ có Xoay / Thu nhỏ / Phóng to / Đóng) ----------------

  const winOf = (e) => BrowserWindow.fromWebContents(e.sender);

  ipcMain.handle('shell:state', () => ({ ...appWin.state, iconUrl: appWin.iconUrl || '' }));
  ipcMain.handle('shell:minimize', (e) => winOf(e)?.minimize());
  ipcMain.handle('shell:maximize', (e) => {
    const w = winOf(e);
    if (!w) return;
    if (w.isMaximized()) w.unmaximize();
    else w.maximize();
    appWin.scheduleFit();
  });
  // Đóng phải đi qua appWin.close(): nó gỡ cửa sổ trình giả lập khỏi cửa sổ chủ trước, rồi mới dừng ứng dụng Android.
  // Cách cũ gọi thẳng win.close(), bỏ qua đoạn dọn dẹp này — cửa sổ thì mất, nhưng tiến trình phía Android vẫn chạy,
  // chính là lỗi người dùng báo "bấm đóng mà không tắt được ứng dụng".
  ipcMain.handle('shell:close', () => {
    if (appWin && appWin.isOpen) { appWin.close(); return { ok: true }; }
    return { ok: false };
  });
  ipcMain.handle('shell:rotate', () => appWin.rotate(restartForOrientation));
  // Map phím: mở trình chỉnh trên game / lưu / hủy
  ipcMain.handle('shell:keymapEdit', () => appWin.openKeymapEditor());
  ipcMain.handle('keymap:save', (_e, data) => {
    const { profile, disableKey, labels } = data || {};
    if (appWin.pkg && profile && Array.isArray(profile.controls)) store.saveKeymap(appWin.pkg, profile);
    store.saveSettings({ engine: { keymapDisableKey: String(disableKey || 'F12'), keymapLabels: labels !== false } });
    appWin.closeKeymapEditor();
    return true;
  });
  ipcMain.handle('keymap:cancel', () => appWin.closeKeymapEditor());
  ipcMain.handle('shell:back', async () => { await runtime.client().keyBack(); });
  ipcMain.handle('shell:forward', async () => { await runtime.client().keyForward(); });

  // ---------------- Cài đặt hệ thống Android (không cần vào màn hình chính Android) ----------------

  ipcMain.handle('android:status', async () => {
    try { return { ok: true, ...(await androidSet.status()) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:set', async (_e, { key, value }) => {
    try {
      switch (key) {
        case 'wifi': return { ok: true, ...(await androidSet.setWifi(!!value)) };
        case 'airplane': return { ok: true, ...(await androidSet.setAirplane(!!value)) };
        case 'volume': return { ok: true, ...(await androidSet.setVolume(value)) };
        case 'animations': return { ok: true, ...(await androidSet.setAnimations(!!value)) };
        case 'fontScale': return { ok: true, ...(await androidSet.setFontScale(value)) };
        case 'density': return { ok: true, ...(await androidSet.setDensity(value)) };
        default: return { ok: false, error: `Mục cài đặt không xác định ${key}` };
      }
    } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:open', async (_e, action) => {
    try { return { ok: true, ...(await androidSet.open(action)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:tune', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.tune({ pkg })) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:permissions', async (_e, pkg) => {
    try { return { ok: true, rows: await androidSet.permissions(pkg) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('android:grantAll', async (_e, pkg) => {
    try { return { ok: true, ...(await androidSet.grantAll(pkg)) }; } catch (e) { return { ok: false, error: e.message }; }
  });

  ipcMain.handle('app:foreground', () => {
    if (appWin && appWin.isOpen) { appWin.win.show(); appWin.win.focus(); return true; }
    return false;
  });

  // ---------------- Cập nhật trực tuyến ----------------

  ipcMain.handle('app:updateCheck', async (_e, opts = {}) => {
    try {
      // Người dùng chủ động bấm "Kiểm tra cập nhật" → bỏ qua cache, luôn hỏi lại cả hai nguồn
      const info = await updater.check({ force: opts.force !== false });
      updateInfo = info;
      return { ok: true, ...info };
    } catch (e) {
      return { ok: false, error: e.message, current: app.getVersion() };
    }
  });

  ipcMain.handle('app:updateOpen', (_e, url) => {
    // Cho phép mở trực tiếp trang phát hành của cả GitHub và Gitee: khi kiểm tra cập nhật thất bại, giao diện dựa vào đây
    // để người dùng tự tải về, chỉ cho phép github.com sẽ chặn người dùng ở Trung Quốc.
    const raw = String(url || '');
    const ok = /^https:\/\/(github\.com|gitee\.com)\//i.test(raw);
    const target = ok ? raw : Updater.repoUrl();
    shell.openExternal(target).catch(() => {});
    return { ok: true, target };
  });

  ipcMain.handle('app:updateApply', () => runUpdate());

  ipcMain.handle('app:updateCancel', () => { updateBusy = false; return { ok: true }; });

  ipcMain.handle('app:restart', () => {
    setTimeout(() => { quitting = true; app.quit(); }, 200);
    return { ok: true };
  });
}

// ---------------- Vòng đời ----------------

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', (_evt, argv) => {
    const args = parseArgs(argv);
    if (args.launch) { runLaunch(args.launch); return; }
    if (args.apk) { runInstall(args.apk).catch(() => {}); return; }
    showWindow();
  });

  app.whenReady().then(async () => {
    store.ensureDirs();
    runtime = new Runtime(APP_ROOT);
    // Vừa khởi động là ghi một dòng: khi có sự cố người dùng gửi app.log là thấy phiên bản và thư mục dữ liệu
    appLog(`start v${app.getVersion()} data=${store.DATA_DIR} pid=${process.pid}`);
    const l = launcherInfo();
    installer = new Installer(runtime, {
      launcherTarget: l.target,
      launcherArgs: l.args,
      cwd: l.cwd,
      isDev: IS_DEV,
      desktopDir: app.getPath('desktop'),
      // Windows Search lập chỉ mục .lnk trong menu Start, chỉ đặt ở desktop sẽ "tìm không thấy ứng dụng"
      startMenuDir: path.join(app.getPath('appData'), 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
      decodeIcon,
    });
    sharer = new Sharer(runtime);
    androidSet = new AndroidSettings(runtime);

    updater = new Updater({
      currentVersion: app.getVersion(),
      exePath: process.execPath,
      isPackaged: app.isPackaged,
      dataDir: store.DATA_DIR,
      // Cho trình cập nhật đọc được cài đặt "chỉ GitHub / chỉ Gitee / tự chọn nhanh" và tiền tố mirror
      settings: () => store.getSettings(),
      onProgress: (p) => send('update:progress', p),
    });

    // Bộ gộp con lăn: các lần cuộn trong một khung thời gian chỉ chèn một lệnh input swipe, qua adb shell thường trực.
    wheelRouter = new pointer.WheelRouter({
      getSize: getDeviceSize,
      inject: (cmd) => runtime.client().input(cmd),
    });

    // Tác tử cửa sổ: chỉ lo nhúng cửa sổ trình giả lập. Hook chuột toàn cục chỉ cài theo cấu hình khi cửa sổ ứng dụng ở tiền cảnh.
    winAgent = new WinAgent();
    keymapSession = new KeymapSession({
      agent: winAgent,
      // Kênh chạm tạo lười theo cổng gRPC hiện tại; emulator khởi động lại cùng cổng thì grpc tự nối lại
      touch: () => {
        const port = ((runtime.emulator && runtime.emulator.port) || 5554) + 3000;
        if (!keymapTouch || keymapTouch.port !== port) {
          if (keymapTouch) keymapTouch.close();
          try { keymapTouch = new TouchChannel({ port }); } catch (e) { appLog(`touch channel: ${e.message}`); keymapTouch = null; }
        }
        return keymapTouch;
      },
      store,
      screen: async () => {
        const d = await getDeviceSize();
        return { w: d.width, h: d.height, landscape: !!displaySettings().landscape };
      },
      onBack: () => { runtime.client().keyBack().catch(() => {}); },
      notify: (m) => notify('Map phím', m),
      settings: () => store.getSettings(),
    });
    appWin = new AppWindow({
      agent: winAgent,
      keymap: keymapSession,
      // Xoay cần đổi độ phân giải logic của Android, giao cho client adb làm
      setOrientation: async (landscape) => {
        deviceSize.value = null;
        return runtime.client().setOrientation(landscape);
      },
      // Truyền getter: trang cài đặt đổi phím thì lần focus / làm mới cửa sổ kế tiếp có hiệu lực, không cần khởi động lại
      pointerConfig: () => pointer.pointerOptions(store.getSettings()),
    });
    appWin.onCloseApp((pkg) => {
      // Đóng cửa sổ = dừng ứng dụng này; khi đóng cửa sổ cuối cùng thì container tạm nghỉ (hạ ưu tiên, dừng thăm dò),
      // nhưng môi trường Android vẫn giữ, lần sau mở là vào ngay chứ không khởi động nguội lại.
      runtime?.endApp(pkg, { onIdle: onContainerActive }).catch(() => {});
    });

    // "Cửa sổ nào mới là của ta" = thư mục môi trường chạy + thư mục engine đi kèm gói.
    // Tác tử cửa sổ chỉ được đụng vào cửa sổ do các tiến trình này tạo — ứng dụng Qt khác (WeChat 4.x là Qt6,
    // tên lớp cửa sổ y hệt trình giả lập) không được đụng tới cái nào, xem SetScope trong agent.ps1.
    const agentScope = () => {
      const dirs = [];
      try { dirs.push(runtime.provisioner.root); } catch (_) { /* ignore */ }
      try { dirs.push(path.join(APP_ROOT, 'engine')); } catch (_) { /* ignore */ }
      return dirs.filter(Boolean);
    };
    // Phạm vi lưu trong bộ nhớ của tiến trình tác tử, tác tử tạo lại là mất — nên mỗi lần trước khi ẩn lúc khởi động đều gửi lại.
    armAgent = async (agent) => {
      if (!agent) return { ok: false };
      const dirs = agentScope();
      // Tham số thứ hai là pid của tiến trình này: tác tử dựa vào đó để từ chối nhúng cửa sổ vào cửa sổ "không phải của ta"
      await agent.scope(dirs, process.pid).catch(() => null);
      if (!dirs.length) appLog('agent scope rỗng: không ẩn cửa sổ nào (tránh ảnh hưởng nhầm phần mềm khác)');
      return agent.bootHide().catch(() => ({ ok: false }));
    };

    // Tiến trình tác tử thoát bất ngờ sẽ được tạo lại, listener sự kiện phải gắn lại cùng lúc (bản cũ làm mất
    // chuột phải quay lại và con lăn ở đây, biểu hiện là "dùng một lúc thì hết phản hồi").
    const attachAgentEvents = (agent) => {
      agent.on('back', () => { runtime.client().keyBack().catch(() => {}); });
      agent.on('forward', () => { runtime.client().keyForward().catch(() => {}); });
      agent.on('wheel', (m) => {
        if (pointer.pointerOptions(store.getSettings()).wheel === 'smooth') wheelRouter.push(m);
      });
      agent.on('exit', () => {
        const next = new WinAgent();
        winAgent = next;
        appWin.agent = next;
        if (keymapSession) keymapSession.setAgent(next);
        attachAgentEvents(next);
        // Tác tử mới không có thông tin phạm vi, không bổ sung thì nó không dám đụng cửa sổ nào
        armAgent(next).catch(() => {});
      });
    };
    attachAgentEvents(winAgent);

    // "Cửa chặn" ẩn cửa sổ console phải được mở trước khi tiến trình trình giả lập được tạo.
    // Cách cũ là "chờ ApkStart lên 4 giây rồi mới giấu", trong khi trình giả lập trước đó đã
    // tạo xong cửa sổ console qemu — người dùng thấy một khung đen chớp qua.
    runtime.emulator.onBeforeSpawn = async () => {
      if (!winAgent) return;
      await armAgent(winAgent);
    };
    // Tác tử cửa sổ là một tiến trình PowerShell thường trực, khởi động nguội mất khoảng 300~600ms.
    // Khởi chạy sớm, đừng đợi tới lúc thật sự cần giấu cửa sổ mới bắt đầu chờ.
    winAgent.ensure().then(() => armAgent(winAgent)).catch(() => {});

    registerIpc();
    createWindow({ show: !parseArgs(process.argv).silent });
    buildTray();
    applyAutoStart();

    // Dung lượng ổ đĩa còn lại: dưới 3GB thì Android hoàn toàn không lên được (ghi image/snapshot đều thất bại).
    // Thay vì để người dùng thấy "không mở được" mà không hiểu vì sao, nói thẳng cần đổi ở đâu.
    {
      const doctor = require('./core/doctor');
      const freeMB = doctor.freeDiskMB(store.DATA_DIR);
      if (freeMB && freeMB < 3072) {
        appLog(`LOW_DISK free=${freeMB}MB dir=${store.DATA_DIR}`);
        setTimeout(() => {
          notify('Ổ đĩa không đủ dung lượng', `Chỉ còn ${(freeMB / 1024).toFixed(1)} GB. Vào "Cài đặt → Tích hợp hệ thống" để chuyển thư mục dữ liệu Android/thư mục môi trường chạy sang ổ khác, hoặc dọn dẹp ổ đĩa trước.`);
          send('toast', { type: 'error', message: `Ổ đĩa chỉ còn ${(freeMB / 1024).toFixed(1)} GB, Android có thể không khởi động được (đổi ổ trong Cài đặt → Tích hợp hệ thống)` });
        }, 3000).unref?.();
      }
    }

    // Bản cũ chỉ tạo lối tắt desktop / biểu tượng là null: khởi động là tự bổ sung, người dùng không cần làm gì
    installer.ensureShortcuts().then((fixed) => {
      if (fixed && fixed.length) {
        windowctl.refreshShell().catch(() => {});
        notify('Đã bổ sung lối tắt', fixed.join(', '));
      }
    }).catch(() => {});

    // F11 chuyển toàn màn hình / cửa sổ; phím tắt toàn cục chỉ có hiệu lực khi ApkStart đang chạy
    try {
      globalShortcut.register('F11', () => { toggleDisplayMode(); });
    } catch (_) { /* ignore */ }

    const args = parseArgs(process.argv);
    if (args.apk) runInstall(args.apk).catch(() => {});
    else if (args.launch) await runLaunch(args.launch);

    // Khởi động trước: giữ môi trường Android thường trực như WSA / Tencent AppStore bản PC.
    // Mở ApkStart là khởi động sẵn ở nền (cửa sổ ẩn suốt), sau đó bấm ứng dụng chỉ còn một lệnh am start.
    // Chỉ khởi động trước khi "đã cài ứng dụng + có môi trường chạy dùng được", tránh tốn bộ nhớ vô ích lần đầu dùng/chỉ quản lý.
    const prewarmEnabled = store.getSettings().engine.prewarm !== false;
    if (prewarmEnabled && !args.launch && store.getApps().length > 0) {
      // 1.2 giây là đủ để cửa sổ vẽ xong khung hình đầu. Trước đây chờ 4 giây, lúc đó người dùng đã bấm ứng dụng,
      // kết quả "mở" và "khởi động trước" tranh cùng một khóa AVD, lại càng chậm hơn.
      setTimeout(async () => {
        try {
          const env = await runtime.provisioner.checkEnv();
          if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) {
            appLog(`prewarm skipped: not ready (adb=${env.adb.ok} emu=${env.emulator.ok} img=${env.sysimg.ok})`);
            return;
          }
          // Giai đoạn khởi động giấu cửa sổ trình giả lập và console qemu, người dùng không được thấy cửa sổ nào
          // Chú ý phải await: không chờ nó có hiệu lực mà spawn luôn thì cửa sổ đen chắc chắn lộ ra.
          if (winAgent) { try { await armAgent(winAgent); } catch (_) { /* ignore */ } }
          const t0 = Date.now();
          appLog('prewarm start');
          const r = await runtime.prewarm({ onLog: (m) => appLog(`prewarm ${m}`) });
          if (r && r.ok) appLog(`prewarm ready in ${Date.now() - t0}ms`);
          else {
            appLog(`prewarm failed: ${r && (r.error || r.skipped)}`);
            // Khởi động trước thất bại cũng tiếp tục ẩn cửa sổ trình giả lập: có thể nó chỉ chậm, lát nữa sẽ lên,
            // người dùng không nên thấy một trình giả lập trên desktop chỉ vì "khởi động trước thất bại".
            if (winAgent) armAgent(winAgent).catch(() => {});
          }
        } catch (e) { appLog(`prewarm error: ${e && e.message}`); /* khởi động trước thất bại không ảnh hưởng việc mở bình thường sau đó */ }
      }, 1200).unref?.();
    } else {
      appLog(`prewarm off (enabled=${prewarmEnabled} launch=${!!args.launch} apps=${store.getApps().length})`);
    }

    // Triển khai thành phần lần chạy đầu hoãn 20 giây: lúc khởi động nguội ổ đĩa/CPU đã quá tải,
    // tải và giải nén song song chỉ làm desktop giật hơn. Khi thật sự cần mở ứng dụng thì ensure() sẽ tự chuẩn bị.
    setTimeout(() => {
      autoDeploy().then((r) => {
        if (r && r.ok) send('toast', { type: 'ok', message: 'Môi trường chạy đã được chuẩn bị tự động xong' });
      }).catch(() => {});
    }, 20000).unref?.();

    // 8 giây sau khi khởi động thì im lặng kiểm tra phiên bản mới (chỉ có ý nghĩa sau khi đóng gói). Có bản mới chỉ thông báo,
    // tuyệt không tự tải — cập nhật chỉ làm khi người dùng bấm "Cập nhật ngay".
    if (app.isPackaged) {
      setTimeout(() => {
        updater.check().then((info) => {
          updateInfo = info;
          send('update:state', info);
          if (info.hasUpdate) {
            appLog(`update available ${info.tag} (current v${app.getVersion()}, asset=${info.asset ? info.asset.name : 'none'})`);
            // Không hiện thông báo hệ thống riêng nữa: nhắc nhở lúc khởi động đều gom vào "thẻ chào mừng" trong ứng dụng,
            // tránh khi tự khởi động cùng Windows lại hiện bong bóng góc dưới phải (một trong các "popup nhỏ" người dùng phản ánh).
          }
        }).catch((e) => appLog(`update check failed: ${e.message}`));
      }, 8000).unref?.();
    }

    // Đồng bộ file / thăm dò thông báo không còn chạy thường trực vô điều kiện: chỉ chạy khi container thật sự có cửa sổ ứng dụng
    // (xem onContainerActive).

    // Smoke test: chụp màn hình rồi thoát, dùng để kiểm tra tự động giao diện có render bình thường không
    if (process.argv.includes('--smoke') && mainWindow) {
      const out = process.argv[process.argv.indexOf('--smoke') + 1] || 'smoke.png';
      mainWindow.webContents.once('did-finish-load', () => {
        setTimeout(async () => {
          try {
            if (process.argv.includes('--setup')) {
              // Bảng môi trường chạy đã gộp vào Cài đặt: --setup tương đương --settings, mở thẳng Cài đặt để chụp
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('btnSettings').click(); true;",
              );
              await new Promise((r) => setTimeout(r, 2500));
            }
            if (process.argv.includes('--settings')) {
              const opened = await mainWindow.webContents.executeJavaScript(`
                (async () => {
                  document.getElementById('btnSettings').click();
                  for (let i = 0; i < 50; i++) {
                    await new Promise((r) => setTimeout(r, 100));
                    if (document.getElementById('settingsMask').classList.contains('on')) return true;
                  }
                  return false;
                })()
              `);
              console.log('[smoke] settings opened =', opened);
              await new Promise((r) => setTimeout(r, 600));
              const dbg = await mainWindow.webContents.executeJavaScript(
                "JSON.stringify({ on: document.getElementById('settingsMask').classList.contains('on'), qr: !!document.querySelector('#aboutGroup img'), qrH: (document.querySelector('#aboutGroup img')||{}).naturalHeight, ver: (document.getElementById('aboutVer')||{}).textContent, note: (document.getElementById('setupNote')||{}).textContent })",
              );
              console.log('[smoke] dom =', dbg);
            }
            // Cửa sổ có thể bị che dẫn tới lấy khung hình cũ: ép vẽ lại + chụp liền hai khung lấy khung sau
            const snap = async (file) => {
              mainWindow.webContents.invalidate();
              await mainWindow.webContents.capturePage().catch(() => null);
              await new Promise((r) => setTimeout(r, 400));
              const im = await mainWindow.webContents.capturePage();
              fs.writeFileSync(file, im.toPNG());
              console.log('[smoke] saved', file);
            };
            await snap(out);
            if (process.argv.includes('--perf')) {
              // Chụp vùng "Hiệu năng và tài nguyên" (khối nhiều điều khiển nhất trong trang cài đặt)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('perfGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-perf.png'));
            }
            if (process.argv.includes('--download')) {
              // Chụp vùng "Nguồn tải và cập nhật"
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('downloadGroup').scrollIntoView({ block: 'start' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-download.png'));
            }
            if (process.argv.includes('--settings')) {
              // Chụp thêm vùng "Giới thiệu" (mã QR / GitHub / Powered by)
              await mainWindow.webContents.executeJavaScript(
                "document.getElementById('aboutGroup').scrollIntoView({ block: 'center' }); true;",
              );
              await snap(out.replace(/\.png$/i, '-about.png'));
            }
          } catch (e) {
            console.error('[smoke] Chụp màn hình thất bại', e);
          }
          quitting = true;
          app.quit();
        }, 6500);
      });
    }

    app.on('activate', () => showWindow());
  });

  app.on('window-all-closed', () => {
    // Đóng cửa sổ bình thường chỉ ẩn xuống khay (sự kiện close đã bị chặn),
    // tới được đây nghĩa là thật sự muốn thoát, phải cho qua, nếu không tiến trình sẽ còn sót và giữ khóa một phiên bản.
    if (quitting) app.exit(0);
  });

  let quitReady = false;
  app.on('before-quit', (e) => {
    quitting = true;
    // Trước khi thoát phải để tác tử cửa sổ "gỡ ra + giấu đi" cửa sổ trình giả lập. Bước này là bất đồng bộ
    // (phải chờ tác tử phản hồi), nên lần before-quit đầu tiên bị chặn lại, dọn dẹp xong mới thật sự thoát.
    // Thiếu bước này, cửa sổ chủ vừa bị hủy thì Windows sẽ gắn lại cửa sổ con trình giả lập lên desktop và hiển thị —
    // biểu hiện là "đóng ApkStart xong, desktop vẫn còn một cửa sổ đen Android Emulator".
    if (!quitReady) {
      e.preventDefault();
      quitReady = true;
      sharer?.stop();
      notifier?.stop();
      try { appWin?.close({ keepApp: true }); } catch (_) { /* ignore */ }
      const finish = () => {
        try { winAgent?.dispose(); } catch (_) { /* ignore */ }
        try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
        runtime?.dispose();
        // Cửa sổ ẩn giải mã biểu tượng cũng tính là một cửa sổ, không đóng thì window-all-closed sẽ không bao giờ kích hoạt
        try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
        app.quit();
      };
      setTimeout(finish, 400);
      return;
    }
    try { winAgent?.dispose(); } catch (_) { /* ignore */ }
    try { wheelRouter?.dispose(); } catch (_) { /* ignore */ }
    runtime?.dispose();
    try { if (decodeWindow && !decodeWindow.isDestroyed()) decodeWindow.destroy(); } catch (_) { /* ignore */ }
  });
}
