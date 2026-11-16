'use strict';
/**
 * Tự kiểm tra runtime (không cần mở giao diện)
 *
 *   npm run selftest                 # chỉ kiểm tra runtime hiện có
 *   npm run selftest -- --apk a.apk  # chạy thêm một lượt cài → khởi chạy → chụp màn hình → thư mục chia sẻ
 *
 * Mục đích: sau khi cài Android, dùng một lệnh xác nhận chuỗi «nhấp đúp để cài ứng dụng, cửa sổ độc lập, dữ liệu thông nhau»
 * thực sự hoạt động trên máy hiện tại, khi có sự cố cũng xác định được đúng khâu nào.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');
const { Sharer } = require('../src/core/sharer');
const { parseApk } = require('../src/core/apk');

const argv = process.argv.slice(2);
const argOf = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : '';
};
const APK = argOf('--apk');
// Để trống = đi theo đường sản phẩm, tự khởi động runtime tích hợp và dùng serial động; chỉ khi chỉ định mới kết nối thiết bị ngoài
const SERIAL = argOf('--serial') || '';

const results = [];
function record(name, ok, detail = '') {
  results.push({ name, ok, detail });
  const mark = ok === null ? '○' : ok ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? `  —  ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function step(name, fn) {
  process.stdout.write('');
  try {
    const detail = await fn();
    record(name, true, detail || '');
    return true;
  } catch (e) {
    record(name, e && e.skipped ? null : false, e.message);
    return false;
  }
}

(async () => {
  console.log('\nTự kiểm tra runtime ApkStart');
  console.log(`Thiết bị: ${SERIAL}`);
  console.log('─'.repeat(64));

  console.log('\n[Thành phần]');
  const runtime = new Runtime(path.join(__dirname, '..'));
  const prov = runtime.provisioner;

  let env = null;
  await step('adb dùng được', async () => {
    env = await prov.checkEnv();
    if (!env.adb.ok) throw new Error('Chưa cài adb, hãy chạy «Triển khai một chạm» trước');
    return `v${env.adb.version}`;
  });
  await step('Android Emulator sẵn sàng', async () => {
    if (!env.emulator.ok) throw new Error('Chưa cài engine runtime, hãy chạy «Triển khai một chạm» trước');
    return `v${env.emulator.version}`;
  });
  await step('Ảnh hệ thống đầy đủ', async () => {
    if (!env.sysimg.ok) throw new Error(env.sysimg.note || 'Thiếu ảnh hệ thống');
    return `Android ${env.sysimg.api} · ${(env.sysimg.size / 1073741824).toFixed(2)}GB`;
  });
  record('Tăng tốc phần cứng', env.accel.ok ? true : null,
    env.accel.ok ? env.accel.note : 'Tự động chuyển sang giả lập phần mềm (chạy được nhưng chậm rõ rệt)');

  console.log('\n[Thiết bị]');
  let client = runtime.client(SERIAL || undefined);
  const online = await step('Runtime đã sẵn sàng', async () => {
    if (SERIAL) {
      await client.connect().catch(() => false);
      if (!await client.isOnline()) throw new Error(`Thiết bị ngoài không trực tuyến: ${SERIAL}`);
      return SERIAL;
    }
    const r = await runtime.ensure({ onLog: () => {} });
    if (!r.ok) throw new Error(r.error || 'Runtime không khả dụng');
    client = r.client;
    return client.serial;
  });

  if (!online) {
    console.log('\nThiết bị chưa sẵn sàng, bỏ qua các mục sau.');
  } else {
    await step('Phiên bản Android', async () => {
      const [ver, sdk, abi] = await Promise.all([
        client.androidVersion(), client.sdkInt(), client.shell('getprop ro.product.cpu.abi').catch(() => ''),
      ]);
      if (!ver) throw new Error('Không đọc được phiên bản hệ thống');
      return `Android ${ver} (API ${sdk}) · ${String(abi).trim()}`;
    });
    await step('Độ phân giải màn hình', async () => {
      const s = await client.wmSize();
      if (!s) throw new Error('wm size không trả về gì');
      return `${s.width}×${s.height}`;
    });
    await step('Cửa sổ độc lập freeform', async () => {
      const ok = await client.ensureFreeform();
      if (!ok) throw new Error('Không bật được freeform (hệ thống có thể không hỗ trợ đa cửa sổ)');
      return 'Đã bật';
    });

    console.log('\n[Thư mục chia sẻ]');
    await step('Đồng bộ hai chiều', async () => {
      const sharer = new Sharer(runtime);
      await client.shellMkdir(store.getSettings().deviceSharedDir);
      const localDir = store.getSettings().sharedDir;
      fs.mkdirSync(localDir, { recursive: true });
      const probe = path.join(localDir, `selftest-${Date.now()}.txt`);
      const payload = `apkstart selftest ${new Date().toISOString()}`;
      fs.writeFileSync(probe, payload);

      const up = await sharer.sync();
      if (up.errors && up.errors.length) throw new Error(up.errors[0]);
      const remote = `${store.getSettings().deviceSharedDir}/${path.basename(probe)}`;
      const back = await client.shell(`cat "${remote}" 2>/dev/null`);
      if (!String(back).includes('apkstart selftest')) throw new Error('Máy tính → thiết bị chưa đồng bộ');

      const reverse = path.join(localDir, `selftest-from-device-${Date.now()}.txt`);
      await client.shell(`echo device-side > "${store.getSettings().deviceSharedDir}/${path.basename(reverse)}"`);
      await sharer.sync();
      if (!fs.existsSync(reverse) || !fs.readFileSync(reverse, 'utf8').includes('device-side')) {
        throw new Error('Thiết bị → máy tính chưa đồng bộ');
      }
      fs.rmSync(probe, { force: true });
      fs.rmSync(reverse, { force: true });
      await client.shell(`rm -f "${remote}"`);
      return 'Chiều lên + chiều xuống đều bình thường';
    });

    if (APK) {
      console.log('\n[Chuỗi ứng dụng]');
      let meta = null;
      await step('Phân tích APK', async () => {
        meta = parseApk(APK);
        return `${meta.label} (${meta.package} v${meta.versionName})`;
      });
      if (meta) {
        await step('Cài vào thiết bị', async () => {
          await client.install(APK);
          const installed = await client.isInstalled(meta.package);
          if (!installed) throw new Error('pm path không tìm thấy gói');
          return 'pm path xác minh thành công';
        });
        await step('Khởi chạy cửa sổ độc lập', async () => {
          await client.startApp(meta.package, meta.launchActivity, { freeform: true });
          await sleep(4000);
          const top = await client.shell('dumpsys activity activities | grep -E "mResumedActivity|topResumedActivity"');
          if (!String(top).includes(meta.package)) throw new Error('Ứng dụng không ở tiền cảnh');
          return meta.package;
        });
        await step('Chụp màn hình', async () => {
          const png = await client.screenshot();
          const out = path.join(__dirname, '..', 'test', 'out');
          fs.mkdirSync(out, { recursive: true });
          const file = path.join(out, 'selftest.png');
          fs.writeFileSync(file, png);
          if (png.length < 4096) throw new Error('Nội dung ảnh chụp bất thường');
          return file;
        });
      }
    } else {
      console.log('\n[Chuỗi ứng dụng] Không chỉ định --apk, bỏ qua');
    }
  }

  // Runtime do tự kiểm tra khởi động thì phải chủ động dừng: nếu không, pipe stdio của tiến trình con emulator
  // sẽ khiến vòng lặp sự kiện Node không bao giờ thoát, lệnh trông như «bị treo»
  if (!SERIAL && runtime.emulator.running()) {
    await runtime.stop({}).catch(() => {});
  }

  const failed = results.filter((r) => r.ok === false);
  console.log('\n' + '─'.repeat(64));
  console.log(`Kết quả: ${results.filter((r) => r.ok === true).length} đạt, ${failed.length} thất bại, `
    + `${results.filter((r) => r.ok === null).length} bỏ qua`);
  if (failed.length) {
    console.log('Mục thất bại:');
    failed.forEach((f) => console.log(`  · ${f.name}：${f.detail}`));
    process.exit(1);
  }
  console.log('Tất cả kiểm tra đều đạt ✅\n');
  process.exit(0);
})().catch((e) => {
  console.error('\nTự kiểm tra bị dừng bất thường:', e.message);
  process.exit(1);
});
