'use strict';
/**
 * Kiểm tra cửa sổ: khởi chạy emulator theo cách của tiến trình chính, xác nhận «trên màn hình không xuất hiện một cửa sổ thừa nào».
 *
 * Cần theo dõi hai loại cửa sổ:
 *   1. "Android Emulator - apkstart5554" (QWindowIcon, cửa sổ chính trình giả lập)
 *      — bình thường chỉ xuất hiện sau khi embed, như cửa sổ con của cửa sổ chúng ta, không bao giờ thấy trên màn hình;
 *   2. Cửa sổ đen console (ConsoleWindowClass / CASCADIA_HOSTING_WINDOW_CLASS của conhost)
 *      — qemu và netsimd mỗi cái bật ra một cửa sổ, tiêu đề là đường dẫn exe được khởi chạy.
 *
 * Cách dùng: node tools/check-windows.js [runtimeRoot]
 *   runtimeRoot mặc định lấy engine/ trong kho mã (runtime tải về máy), cũng có thể truyền thư mục cài đặt
 *   resources/runtime。
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

// Thư mục runtime: tham số dòng lệnh > biến môi trường > engine/ trong kho mã
const ROOT = path.resolve(process.argv[2] || process.env.APKSTART_RUNTIME || path.join(__dirname, '..', 'engine'));
const EMU = path.join(ROOT, 'emulator', 'emulator.exe');
// AVD có thể nằm ở ổ khác (runtime.avdDir trong cài đặt), thường gặp ở người dùng thực; ở đây cũng hỗ trợ chỉ định rõ
const AVD_HOME = process.env.APKSTART_AVD_HOME
  || path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bad = (w) => {
  const t = String(w.title || '').toLowerCase();
  const c = String(w.cls || '');
  const isConsole = c.indexOf('ConsoleWindowClass') >= 0 || c.indexOf('CASCADIA_HOSTING') >= 0;
  if (isConsole) return t.indexOf('emulator') >= 0 || t.indexOf('netsim') >= 0 || t.indexOf('qemu') >= 0;
  return t.indexOf('android emulator') >= 0;
};

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  console.log('agent ready, port=', agent.port);

  const windows = async () => {
    const r = await agent.call({ cmd: 'windows' }, 5000).catch(() => null);
    return (r && r.list) || [];
  };

  // Tác tử chỉ đụng tới cửa sổ do «tiến trình trong thư mục runtime» tạo: phải khai báo phạm vi trước, nếu không nó không ẩn gì cả
  await agent.scope([ROOT]);
  await agent.bootHide();
  console.log('Đã bật ẩn thường trực');

  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart', '-no-snapshot-load',
  ], {
    cwd: path.dirname(EMU),
    env: {
      ...process.env,
      ANDROID_SDK_ROOT: ROOT, ANDROID_HOME: ROOT,
      ANDROID_AVD_HOME: AVD_HOME, ANDROID_EMULATOR_HOME: AVD_HOME,
      ANDROID_ADB_SERVER_PORT: '5044',
    },
    windowsHide: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
  });
  proc.unref();
  proc.stderr.on('data', () => {});
  proc.stdout.on('data', () => {});

  let leaked = 0;
  const ticks = Math.max(24, Number(process.env.CHECK_SECONDS || 0) * 2 || 24);
  for (let i = 0; i < ticks; i += 1) {
    await sleep(500);
    const list = await windows();
    const hit = list.filter(bad);
    if (hit.length) {
      leaked += hit.length;
      console.log(`[${((i + 1) * 0.5).toFixed(1)}s] Cửa sổ bất thường đang hiển thị:`, JSON.stringify(hit));
    }
  }

  const probe = await agent.probe().catch(() => null);
  console.log('probe (cửa sổ ẩn cũng phải tìm được):', JSON.stringify(probe));

  const left = (await windows()).filter(bad);
  console.log('Cửa sổ bất thường vẫn còn trên màn hình khi kết thúc:', JSON.stringify(left));

  const okProbe = !!(probe && Number(probe.emu) !== 0);
  // Cho phép trường hợp «từng xuất hiện nhưng bị ẩn trong 400ms», cuối cùng phải bằng 0
  const ok = left.length === 0 && okProbe;
  console.log('');
  console.log(`Kết quả: ${ok ? 'ĐẠT' : 'THẤT BẠI'} (tổng số lần cửa sổ bất thường hiển thị trong quá trình: ${leaked}, khi kết thúc còn ${left.length})`);

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(ok ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
