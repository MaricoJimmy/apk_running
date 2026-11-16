'use strict';
/**
 * Kiểm thử tích hợp Electron: kiểm tra tạo ICO, tạo lối tắt, ghi icon thật xuống đĩa
 * Chạy: electron test/electron-integration.js
 * Đầu ra: test/out/result.json
 */
const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const OUT = path.join(__dirname, 'out');

app.whenReady().then(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const result = { steps: [] };
  const step = (name, ok, detail = '') => {
    result.steps.push({ name, ok, detail });
    console.log(`${ok ? '✓' : '✗'} ${name} ${detail}`);
  };

  try {
    const { drawAppIcon } = require('../src/core/png');
    const { pngToIco, writeShortcut, removeShortcut, iconToIco } = require('../src/core/shortcut');
    const { parseApk } = require('../src/core/apk');

    // 1. Icon chương trình → PNG → ICO
    const png = drawAppIcon(256);
    fs.writeFileSync(path.join(OUT, 'icon.png'), png);
    const ico = pngToIco(png);
    fs.writeFileSync(path.join(OUT, 'icon.ico'), ico);
    step('Tạo ICO', !!ico && ico.length > 1000, `${ico ? ico.length : 0} bytes`);

    // 1b. Nhánh hạ cấp icon WebP: nativeImage không giải mã được WebP, phải rơi được vào callback decode,
    // khi không có bộ giải mã thì dùng ảnh giữ chỗ thương hiệu và **báo lại trung thực** (lúc cài đặt sẽ biến nó thành một cảnh báo nhẹ).
    {
      // WebP tối thiểu 1x1
      const webp = Buffer.from('UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA', 'base64');
      let noDecoder = '';
      const placeholderIco = await iconToIco(webp, { onFallback: (why) => { noDecoder = why; } });
      step('WebP không có bộ giải mã → ICO hợp lệ và báo hạ cấp sang ảnh giữ chỗ',
        !!placeholderIco && placeholderIco.length > 100 && /placeholder|webp-decode-failed/.test(noDecoder),
        noDecoder || '(no callback)');

      let decoded = 0;
      const viaDecode = await iconToIco(webp, {
        decode: async () => { decoded++; return png; },
        onFallback: (why) => { throw new Error(`Không được hạ cấp: ${why}`); },
      });
      // Nếu một ngày nativeImage giải mã thẳng được WebP, decoded sẽ là 0, cũng tính là đạt; quan trọng là tạo ra ICO hợp lệ
      step('Icon WebP cuối cùng tạo ra ICO', !!viaDecode && viaDecode.readUInt16LE(2) === 1,
        `decode được gọi ${decoded} lần, ${viaDecode ? viaDecode.length : 0} bytes`);
    }

    // 2. Lối tắt
    const lnk = path.join(OUT, 'test.lnk');
    writeShortcut({
      shortcutPath: lnk,
      target: process.execPath,
      args: '--version',
      iconIcoPath: path.join(OUT, 'icon.ico'),
      description: 'ApkStart kiểm thử tích hợp',
    });
    step('Tạo .lnk', fs.existsSync(lnk));
    removeShortcut(lnk);
    step('Xóa .lnk', !fs.existsSync(lnk));

    // 3. Icon APK thật → ICO
    const fixture = process.env.APKSTART_TEST_APK
      || (() => {
        try {
          const dl = path.join(process.env.USERPROFILE || '', 'Documents');
          return fs.readdirSync(dl).map((f) => path.join(dl, f)).find((f) => /\.apk$/i.test(f));
        } catch (_) { return null; }
      })();
    if (fixture) {
      const meta = parseApk(fixture);
      const iconIco = pngToIco(meta.iconPng);
      if (iconIco) {
        fs.writeFileSync(path.join(OUT, 'app.ico'), iconIco);
        step('Icon APK → ICO nhiều kích thước', true, `${meta.label}: ${iconIco.length} bytes`);
      } else {
        step('Icon APK → ICO nhiều kích thước', false, 'pngToIco trả về rỗng (icon có thể ở định dạng ngoài webp/jpg)');
      }
    }

    result.ok = result.steps.every((s) => s.ok);
  } catch (e) {
    result.error = e.message;
    result.ok = false;
    console.error(e);
  }

  fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify(result, null, 2));
  app.exit(result.ok ? 0 : 1);
});
