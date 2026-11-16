'use strict';
/* Kiểm tra đầu-cuối chế độ tương thích: boot theo đường mã sản phẩm (ảnh API 34 Play) → abilist → cài APK ARM → khởi chạy */
process.env.ANDROID_ADB_SERVER_PORT = process.env.ANDROID_ADB_SERVER_PORT || '5038';
const fs = require('fs');
const path = require('path');
const store = require('../src/core/store');
const { Runtime } = require('../src/core/engine');

const ROOT = path.join(__dirname, '..');
const APK = process.argv[2] || 'D:\\红果免费短剧.apk';

(async () => {
  store.saveSettings({ runtime: { compatImage: true } });
  const rt = new Runtime(ROOT);

  console.log('[1] ensure() (chế độ tương thích → phải khởi động ảnh Google Play / API 34)');
  const r = await rt.ensure({
    onLog: (m) => console.log('    [boot]', m),
  });
  if (!r.ok) { console.error('    ensure thất bại:', r.error || JSON.stringify(r).slice(0, 300)); process.exit(1); }
  console.log('    engine =', r.engine, r.reused ? '(dùng lại phiên bản đang chạy)' : '');

  const c = rt.client();
  console.log('[2] release =', await c.shell('getprop ro.build.version.release'));
  console.log('    sdk     =', await c.shell('getprop ro.build.version.sdk'));
  console.log('    abilist =', await c.shell('getprop ro.product.cpu.abilist'));
  console.log('    tag     =', await c.shell('getprop ro.build.tags'));

  if (APK && fs.existsSync(APK)) {
    console.log('[3] Cài APK ARM (红果短剧 / Hongguo Short Drama)…');
    const ins = await c.install(APK);
    console.log('    install =', JSON.stringify(ins).slice(0, 160));
    await c.shell('am start -n com.phoenix.read/com.dragon.read.pages.splash.SplashActivity');
    await new Promise((res) => setTimeout(res, 20000));
    const ps = await c.shell('ps -A | grep phoenix');
    console.log('[4] Tiến trình sau 20s khởi chạy:', ps ? 'còn sống ✓' : 'đã biến mất ✗');
  } else {
    console.log('[3] Bỏ qua cài APK (không tìm thấy', APK, ')');
  }

  console.log('[5] Khôi phục cài đặt chế độ thường');
  store.saveSettings({ runtime: { compatImage: false } });
  process.exit(0);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
