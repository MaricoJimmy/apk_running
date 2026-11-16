'use strict';
/**
 * Kiểm tra đầu-cuối «mở ứng dụng Android thì chỉ có cửa sổ ứng dụng Android»:
 *   1) Dùng APPDATA hộp cát chạy ApkStart thật, `--apk` cài một APK thử nghiệm (sẽ khởi động trình giả lập);
 *   2) Sau đó `--launch <tên gói>` mở ứng dụng;
 *   3) Liệt kê các cửa sổ cấp cao nhất đang hiển thị suốt quá trình: cửa sổ chính của trình giả lập (Android Emulator - …) và cửa sổ console
 *      của qemu / netsimd đều không được xuất hiện; cửa sổ ứng dụng bắt buộc phải xuất hiện (chứng tỏ embed thành công, hình ảnh nằm trong cửa sổ).
 *
 * Cách dùng: node tools/check-launch-clean.js [apkPath]
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const ROOT = path.join(__dirname, '..');
// Giống hai bài kiểm tra cửa sổ kia, hỗ trợ chỉ định runtime/thư mục dữ liệu từ bên ngoài (runtime của người dùng thường nằm ở ổ D)
const ENGINE = path.resolve(process.env.APKSTART_RUNTIME || path.join(ROOT, 'engine'));
const AVD_DIR = process.env.APKSTART_AVD_HOME || '';
const ELECTRON = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
const APK = process.argv[2] || path.join(os.tmpdir(), 'fdroid.apk');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

function launch(args, sandbox) {
  const env = { ...process.env, APPDATA: sandbox };
  delete env.ELECTRON_RUN_AS_NODE;
  const p = spawn(ELECTRON, ['.', ...args], {
    cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stdout.on('data', () => {});
  p.stderr.on('data', () => {});
  return p;
}

(async () => {
  if (!fs.existsSync(APK)) throw new Error(`Không tìm thấy APK thử nghiệm: ${APK}`);
  const sandbox = path.join(os.tmpdir(), `apk-launch-${Date.now()}`);
  const appData = path.join(sandbox, 'apkstart');
  fs.mkdirSync(appData, { recursive: true });
  fs.writeFileSync(path.join(appData, 'settings.json'), JSON.stringify({
    runtime: { dir: ENGINE, avdDir: AVD_DIR }, engine: { prewarm: true },
  }));

  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ENGINE]);

  let pass = true;
  const check = (c, m) => { console.log(`${c ? '✓' : '✗'} ${m}`); if (!c) pass = false; };

  // ---- 1) Cài đặt ----
  console.log('— Cài APK (lần đầu phải khởi động nguội trình giả lập, khoảng 40~90 giây)…');
  let p = launch(['--apk', APK], sandbox);
  let pkg = '';
  for (let i = 0; i < 240; i += 1) {
    await sleep(1000);
    try {
      const apps = JSON.parse(fs.readFileSync(path.join(appData, 'apps.json'), 'utf8')).apps || [];
      if (apps.length && apps[0].package) { pkg = apps[0].package; break; }
    } catch (_) { /* chưa ghi ra */ }
    if (p.exitCode !== null) break;
  }
  check(!!pkg, `Cài đặt xong: ${pkg || '(hết thời gian chờ)'}`);
  // Phải đợi phiên bản đầu tiên **thực sự thoát** rồi mới chạy cái thứ hai: nếu khóa đơn phiên bản vẫn còn, cái thứ hai sẽ thoát ngay,
  // biểu hiện là «cửa sổ mãi không xuất hiện» chứ không phải khởi động thất bại (đã dính thực tế, mất rất lâu mới tìm ra).
  try { p.kill(); } catch (_) { /* ignore */ }
  for (let i = 0; i < 30 && p.exitCode === null; i += 1) await sleep(500);
  await sleep(2000);

  if (!pkg) {
    agent.dispose();
    console.log('\nKết quả: THẤT BẠI (không cài được ứng dụng, bỏ qua các bước sau)');
    process.exit(1);
  }

  // ---- 2) Mở ứng dụng ----
  console.log('— Mở ứng dụng…');
  p = launch(['--launch', pkg], sandbox);
  let leaked = 0;
  let sawAppWin = false;
  const titles = new Set();
  // Khởi động nguội 23s + mở ứng dụng ~17s, để dư 120 giây; trước đây 60 giây bị báo lỗi giả trên máy chậm
  for (let i = 0; i < 240; i += 1) {
    await sleep(500);
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    const list = ((r && r.list) || []);
    for (const w of list) if (w.title) titles.add(w.title);
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Cửa sổ bất thường đang hiển thị:`, JSON.stringify(hit));
    }
    // Cửa sổ ứng dụng = một cửa sổ thường có tiêu đề, không phải trình giả lập/console
    if (!sawAppWin) {
      sawAppWin = list.some((w) => {
        const t = String(w.title || '');
        return t && !bad(w) && !/ApkStart|WorkBuddy|Microsoft|Program Manager|设置|Edge|输入体验/.test(t);
      });
      if (sawAppWin) console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Cửa sổ ứng dụng đã xuất hiện`);
    }
    if (sawAppWin && i > 40) break;
  }

  check(leaked === 0, `Cửa sổ trình giả lập/console luôn không hiển thị (tổng cộng ${leaked} lần)`);
  check(sawAppWin, `Cửa sổ ứng dụng đã xuất hiện (chứng tỏ hình ảnh được nhúng vào cửa sổ, không phải cửa sổ trình giả lập riêng)`);
  console.log('  Tiêu đề cửa sổ hiển thị:', JSON.stringify([...titles].slice(0, 12)));
  if (!pass) {
    console.log('--- Cuối app.log ---');
    try {
      const log = fs.readFileSync(path.join(appData, 'logs', 'app.log'), 'utf8').trim().split('\n');
      console.log(log.slice(-12).join('\n'));
    } catch (_) { console.log('(không có app.log)'); }
  }

  try { p.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  await sleep(1500);
  if (pass) {
    try { fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* ignore */ }
  } else {
    console.log(`  Hộp cát được giữ lại tại: ${sandbox}`);
  }
  console.log('');
  console.log(`Kết quả: ${pass ? 'ĐẠT' : 'THẤT BẠI'}`);
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
