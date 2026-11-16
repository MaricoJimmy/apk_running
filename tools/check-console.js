'use strict';
/**
 * Kiểm tra cửa sổ đen: khởi chạy emulator theo cách của tiến trình chính, xem «cửa sổ đen dòng lệnh» có bị tác tử cửa sổ ẩn đi không.
 *
 * Chỉ suy luận từ mã là không đáng tin — cửa sổ console thuộc conhost.exe, pid hoàn toàn không khớp với emulator,
 * phải thực sự liệt kê các cửa sổ hiển thị một lần mới tính.
 *
 * Cách dùng: node tools/check-console.js [appRoot]
 */
const path = require('path');
const { spawn } = require('child_process');
const { WinAgent } = require('../src/core/agent');

const INSTALL = process.argv[2] || path.join(process.env.LOCALAPPDATA || '', 'Programs', 'apkstart');
const EMU = path.join(INSTALL, 'resources', 'runtime', 'emulator', 'emulator.exe');
const AVD_HOME = path.join(process.env.APPDATA || '', 'apkstart', 'avd');
const ROOT = path.join(INSTALL, 'resources', 'runtime');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const agent = new WinAgent();
  await agent.ensure();
  await agent.scope([ROOT]);
  console.log('agent ready, port=', agent.port);

  const list = async () => {
    const r = await agent.call({ cmd: 'consoles' }, 4000);
    return (r && r.list) || [];
  };

  const before = await list();
  console.log('Cửa sổ console hiển thị trước khi khởi động:', JSON.stringify(before));

  // Giống hệt tiến trình chính: detached + windowsHide + pipe
  const proc = spawn(EMU, [
    '-avd', 'apkstart', '-port', '5554', '-no-boot-anim', '-no-metrics',
    '-crash-report-mode', 'disabled', '-gpu', 'swangle', '-memory', '3072',
    '-cores', '3', '-no-skin', '-snapshot', 'apkstart',
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

  let sawConsole = 0;
  for (let i = 0; i < 20; i += 1) {
    await sleep(500);
    const l = await list();
    const ours = l.filter((w) => w.ours);
    if (ours.length > sawConsole) {
      sawConsole = ours.length;
      console.log(`[${(i + 1) * 0.5}s] Xuất hiện cửa sổ đen:`, JSON.stringify(ours));
    }
  }
  const afterSpawn = (await list()).filter((w) => w.ours);
  console.log('Cửa sổ đen vẫn còn trên màn hình khi chưa ẩn:', JSON.stringify(afterSpawn));

  console.log('--- Bật bootHide ---');
  const r = await agent.bootHide();
  console.log('bootHide:', JSON.stringify(r));
  await sleep(1500);
  const afterHide = (await list()).filter((w) => w.ours);
  console.log('Cửa sổ đen còn lại sau khi ẩn:', JSON.stringify(afterHide));

  console.log('');
  console.log(afterHide.length === 0
    ? `Kết quả: ĐẠT (trong lúc khởi động từng xuất hiện ${sawConsole} cửa sổ đen, sau khi ẩn đều không còn hiển thị)`
    : 'Kết quả: THẤT BẠI (vẫn còn cửa sổ đen hiển thị)');

  try { proc.kill(); } catch (_) { /* ignore */ }
  agent.dispose();
  process.exit(afterHide.length === 0 ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
