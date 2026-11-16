'use strict';
/**
 * Kiểm thử boot thật (mặc định có thể bỏ qua, chạy tay bằng `npm run test:boot`)
 *
 * Dùng ISO Alpine virt 61MB chạy thử một lượt tham số khởi động thật của sản phẩm:
 *   tạo đĩa ảo qcow2 → boot từ ổ quang → xác nhận vào user space qua cổng serial → tắt máy êm
 *
 * Mục đích: lỗi dễ gặp nhất ở tầng engine là “tham số trông đúng nhưng máy thật không khởi động được” (loại machine, accel,
 * thứ tự boot, đĩa virtio, tắt máy ACPI). Ở đây dùng QEMU thật + guest thật để chốt chặt điều đó.
 * Không cần image Android, cũng không cần tăng tốc phần cứng.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

// Cô lập thư mục dữ liệu: tuyệt đối không ghi đường dẫn image/đĩa dùng cho test vào cài đặt người dùng thật
process.env.APPDATA = path.join(os.tmpdir(), `apkstart-boot-test-${Date.now()}`);
fs.mkdirSync(path.join(process.env.APPDATA, 'apkstart'), { recursive: true });

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { downloadParallel } = require('../src/core/download');

const ISO_URL = 'https://mirrors.tuna.tsinghua.edu.cn/alpine/v3.20/releases/x86_64/alpine-virt-3.20.3-x86_64.iso';
const WORK = path.join(os.tmpdir(), 'apkstart-boot');
const ISO = path.join(WORK, 'alpine-virt.iso');
const DISK = path.join(WORK, 'boot-test.qcow2');
const SERIAL = path.join(WORK, 'serial.log');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (m) => console.log(`  ${m}`);

async function ensureIso() {
  if (fs.existsSync(ISO) && fs.statSync(ISO).size > 50 * 1024 * 1024) return;
  fs.mkdirSync(WORK, { recursive: true });
  log('Đang tải ISO Alpine virt (khoảng 61MB)…');
  await downloadParallel(ISO_URL, ISO, { connections: 8, minChunk: 4 * 1024 * 1024 });
}

(async () => {
  console.log('\n[Kiểm thử boot thật]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const env = await runtime.provisioner.checkEnv();
  if (!env.qemu.ok) {
    console.error('  Bỏ qua: chưa cài QEMU');
    process.exit(0);
  }
  log(`QEMU ${env.qemu.version} · ${env.qemu.path}`);

  await ensureIso();
  log(`ISO ${(fs.statSync(ISO).size / 1048576).toFixed(0)}MB`);

  // 1) qemu-img tạo đĩa (đồng thời kiểm tra chuỗi công cụ createDisk của sản phẩm)
  const img = path.join(path.dirname(env.qemu.path), 'qemu-img.exe');
  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  const { execFileSync } = require('child_process');
  execFileSync(img, ['create', '-f', 'qcow2', DISK, '2G'], { windowsHide: true });
  log(`Đĩa ảo ${(fs.statSync(DISK).size / 1024).toFixed(0)}KB (sparse)`);

  // 2) Dùng tham số khởi động thật của sản phẩm
  runtime._hv = env.hypervisor;
  store.saveSettings({
    runtime: { isoPath: ISO, diskPath: DISK },
    engine: { memoryMB: 1024, cores: 2 },
  });
  const args = runtime.buildArgs({ install: true, headless: true });
  args.push('-serial', `file:${SERIAL}`, '-no-reboot');
  try { fs.rmSync(SERIAL, { force: true }); } catch (_) { /* ignore */ }

  log(`Khởi động: ${args.filter((a) => !a.includes('=')).slice(0, 8).join(' ')} …`);
  const proc = spawn(env.qemu.path, args, { stdio: 'ignore', windowsHide: true });
  let exited = false;
  proc.on('exit', () => { exited = true; });

  // 3) Chờ guest vào user space (cổng serial xuất hiện lời nhắc đăng nhập là boot thành công)
  const start = Date.now();
  let booted = false;
  while (Date.now() - start < 180000) {
    if (exited) break;
    if (fs.existsSync(SERIAL)) {
      const txt = fs.readFileSync(SERIAL, 'latin1');
      if (/login:/i.test(txt)) { booted = true; break; }
    }
    await sleep(2000);
  }

  const elapsed = ((Date.now() - start) / 1000).toFixed(0);
  if (!booted) {
    const tail = fs.existsSync(SERIAL) ? fs.readFileSync(SERIAL, 'latin1').slice(-600) : '(không có đầu ra serial)';
    console.error(`  ✗ Boot thất bại (${elapsed}s):\n${tail}`);
    try { proc.kill(); } catch (_) { /* ignore */ }
    process.exit(1);
  }
  log(`✓ guest đã vào user space (${elapsed}s)`);

  // 4) Tắt máy êm: trước tiên system_powerdown, quá thời gian thì quit (đúng như hành vi stop() của sản phẩm)
  let graceful = false;
  try {
    await runtime.monitorCmd('system_powerdown');
    for (let i = 0; i < 20; i++) {
      if (exited) { graceful = true; break; }
      await sleep(500);
    }
    if (!exited) {
      log('guest không phản hồi tắt máy ACPI, chuyển sang quit (sản phẩm cũng dự phòng như vậy)…');
      await runtime.monitorCmd('quit');
      for (let i = 0; i < 10; i++) {
        if (exited) break;
        await sleep(300);
      }
    }
  } catch (e) {
    log(`monitor bất thường: ${e.message}`);
  }
  if (!exited) { try { proc.kill(); } catch (_) { /* ignore */ } }
  log(exited ? `✓ Máy ảo đã tắt (${graceful ? 'tắt êm bằng ACPI' : 'dự phòng bằng quit'})` : '✗ Tắt máy ảo thất bại');

  try { fs.rmSync(DISK, { force: true }); } catch (_) { /* ignore */ }
  console.log(`\nKết quả: ${exited ? 'đạt' : 'lỗi'}\n`);
  process.exit(exited ? 0 : 1);
})().catch((e) => {
  console.error('  Lỗi: ', e.message);
  process.exit(1);
});
