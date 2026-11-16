'use strict';
/**
 * Kiểm thử tích hợp QEMU thật (máy cần có qemu-system-x86_64.exe)
 *
 * Nội dung kiểm tra:
 *  1. Tham số khởi động QEMU do ApkStart tạo được QEMU thật chấp nhận và chạy ổn định
 *  2. qemu-img tạo đĩa ảo hoạt động
 *  3. QEMU monitor (TCP) bắt tay + sendkey + thoát êm
 *
 * Chạy: node test/qemu-real-test.js   (không có QEMU thì tự bỏ qua)
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

process.env.APPDATA = path.join(os.tmpdir(), `apkstart-qemu-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'apkstart'), { recursive: true });

const CANDIDATES = [
  'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',
  path.join(__dirname, '..', 'engine', 'qemu', 'qemu-system-x86_64.exe'),
];
const QEMU = CANDIDATES.find((c) => fs.existsSync(c));
const QEMU_IMG = QEMU && path.join(path.dirname(QEMU), 'qemu-img.exe');

let passed = 0, failed = 0;
const out = [];
function test(name, fn) {
  return Promise.resolve().then(fn).then(() => { passed++; out.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; out.push(`  ✗ ${name}\n    ${e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Khẳng định thất bại'); }

(async () => {
  if (!QEMU) {
    console.log('(bỏ qua: không tìm thấy QEMU trên máy, có thể cài rồi thử lại: winget install SoftwareFreedomConservancy.QEMU)');
    process.exit(0);
  }
  const ver = execFileSync(QEMU, ['--version'], { encoding: 'utf8' });
  console.log(`QEMU: ${ver.split('\n')[0].trim()}\n`);

  const store = require('../src/core/store');
  const { Runtime } = require('../src/core/engine');

  const work = path.join(process.env.APPDATA, 'apkstart', 'runtime', 'images');
  fs.mkdirSync(work, { recursive: true });
  const disk = path.join(work, 'test.qcow2');

  await test('qemu-img tạo đĩa ảo', () => {
    execFileSync(QEMU_IMG, ['create', '-f', 'qcow2', disk, '2G'], { timeout: 30000 });
    assert(fs.existsSync(disk) && fs.statSync(disk).size > 0, 'Đĩa chưa được tạo');
  });

  await test('Tham số khởi động ApkStart được QEMU thật chấp nhận và chạy ổn định', async () => {
    store.saveSettings({
      engine: { memoryMB: 1024, cores: 2 },
      runtime: { diskPath: disk, headless: true },
    });
    const rt = new Runtime(path.join(__dirname, '..'));
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false, headless: true });

    const proc = spawn(QEMU, args, { windowsHide: true, stdio: 'ignore' });
    let exited = null;
    proc.on('exit', (c) => { exited = c; });

    await new Promise((r) => setTimeout(r, 4000));
    assert(exited === null, `QEMU thoát trong vòng 4s (code=${exited}), tham số có thể không được chấp nhận`);
    assert(!proc.killed, 'Tiến trình phải còn sống');

    await test('Giao thức monitor (QEMU thật)', async () => {
      const buf = await rt.monitorCmd('info status', { timeout: 5000 });
      assert(/running|paused/i.test(buf), `Phản hồi monitor bất thường: ${buf.slice(-80)}`);
      await rt.monitorCmd('sendkey ctrl-alt-delete');
    });

    await test('monitor thoát êm', async () => {
      await rt.monitorCmd('quit');
      await new Promise((r) => setTimeout(r, 1500));
      assert(exited !== null || proc.killed, 'QEMU phải đã thoát');
    });
    try { proc.kill(); } catch (_) { /* ignore */ }
  });

  console.log(out.join('\n'));
  console.log(`\nKết quả: ${passed} đạt, ${failed} lỗi\n`);
  try { fs.rmSync(process.env.APPDATA, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
