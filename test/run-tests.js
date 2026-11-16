'use strict';
/**
 * Unit test thuần Node (không phụ thuộc Electron / adb / mạng)
 * Chạy: npm test
 */
const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.error(`  ✗ ${name}\n    ${e.message}`);
  }
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'Khẳng định thất bại');
}

console.log('\n[zip.js]');
const { ZipArchive } = require('../src/core/zip');
test('Phân tích được cấu trúc gói nén package.json của chính dự án', () => {
  // Dùng một zip tối thiểu dựng trong bộ nhớ (chế độ stored) để kiểm tra việc phân tích
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0, 6);
  header.writeUInt16LE(0, 8); // stored
  const name = Buffer.from('hello.txt');
  const data = Buffer.from('hello apkstart');
  header.writeUInt16LE(name.length, 26);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 14);

  const cen = Buffer.alloc(46);
  cen.writeUInt32LE(0x02014b50, 0);
  cen.writeUInt16LE(0, 8);
  cen.writeUInt16LE(name.length, 28);
  cen.writeUInt32LE(data.length, 24);
  cen.writeUInt32LE(data.length, 20);
  cen.writeUInt32LE(0, 42); // local offset

  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(46 + name.length, 12); // Tổng kích thước thư mục trung tâm
  eocd.writeUInt32LE(30 + name.length + data.length, 16); // Offset thư mục trung tâm

  const zip = new ZipArchive(Buffer.concat([header, name, data, cen, name, eocd]));
  assert(zip.has('hello.txt'), 'Phải tìm thấy hello.txt');
  assert(zip.read('hello.txt').toString() === 'hello apkstart', 'Nội dung phải khớp');
});

console.log('\n[png.js]');
const { encodePng, drawAppIcon } = require('../src/core/png');
test('Bộ mã hóa PNG xuất chữ ký và IHDR hợp lệ', () => {
  const rgba = new Uint8Array(16 * 16 * 4).fill(128);
  const png = encodePng(16, 16, rgba);
  assert(png[0] === 0x89 && png[1] === 0x50, 'Chữ ký PNG');
  assert(png.toString('ascii', 12, 16) === 'IHDR', 'IHDR chunk');
  assert(png.length > 50, 'Độ dài hợp lý');
});
test('Icon ứng dụng vẽ được ở mọi kích thước', () => {
  for (const s of [16, 32, 64, 256]) {
    const png = drawAppIcon(s);
    const w = png.readUInt32BE(16);
    assert(w === s, `Chiều rộng phải là ${s}, thực tế ${w}`);
  }
});

console.log('\n[axml.js + arsc.js + apk.js]');
const { parseAxml } = require('../src/core/axml');
const { ResTable } = require('../src/core/arsc');
const { parseApk, quickCheck } = require('../src/core/apk');

// Fixture test: ưu tiên chỉ định qua biến môi trường APKSTART_TEST_APK,
// nếu không thì thử các vị trí APK thường gặp trên máy (chỉ đọc, không sao chép)
function findFixture() {
  const candidates = [
    process.env.APKSTART_TEST_APK,
    path.join(__dirname, 'fixtures', 'sample.apk'),
  ];
  try {
    const dl = path.join(process.env.USERPROFILE || '', 'Documents');
    for (const f of fs.readdirSync(dl)) {
      if (/\.apk$/i.test(f)) candidates.push(path.join(dl, f));
    }
  } catch (_) { /* ignore */ }
  return candidates.find((c) => c && fs.existsSync(c));
}

const fixture = findFixture();
if (fixture) {
  console.log(`  (fixture: ${fixture})`);
  test('quickCheck nhận diện header PK', () => {
    assert(quickCheck(fixture) === true);
  });
  const meta = parseApk(fixture);
  test('Phân tích ra tên gói / phiên bản / Activity khởi chạy', () => {
    assert(/^[\w.]+$/.test(meta.package), `Tên gói bất thường: ${meta.package}`);
    assert(meta.versionName, 'Thiếu versionName');
    assert(meta.launchActivity && /\./.test(meta.launchActivity),
      `Activity khởi chạy bất thường: ${meta.launchActivity}`);
  });
  test('Phân tích ra icon dùng được', () => {
    assert(meta.iconPng && meta.iconPng.length > 100, 'Icon rỗng hoặc quá nhỏ');
    assert(meta.label, 'Tên ứng dụng rỗng');
    console.log(`    ↳ ${meta.label} (${meta.package}) v${meta.versionName}`);
  });
  test('Nút gốc AXML là manifest', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    const root = parseAxml(zip.read('AndroidManifest.xml'));
    assert(root.name === 'manifest');
  });
  test('resources.arsc phân tích được', () => {
    const zip = new ZipArchive(fs.readFileSync(fixture));
    if (zip.has('resources.arsc')) {
      const res = new ResTable(zip.read('resources.arsc'));
      assert(res.packages.length > 0, 'Phải có ít nhất một package');
    }
  });
} else {
  console.log('  (bỏ qua: không tìm thấy fixture APK, có thể đặt APKSTART_TEST_APK)');
}

// Bộ dựng APK tổng hợp đặt ở test/lib/make-apk.js: thiếu fixture thật vẫn bao phủ được ngăn xếp phân tích,
// và run-tests / auto-test dùng chung một bản (tránh hai nơi mỗi nơi tự viết một bộ ghép byte).
const { buildApkBytes } = require('./lib/make-apk');

console.log('\n[APK tổng hợp: toàn chuỗi axml + apk]');
{
  const { attrValue, ANDROID_NS } = require('../src/core/axml');
  test('Ngữ nghĩa namespace của attrValue: truyền null = không giới hạn, mặc định chỉ nhận android', () => {
    const node = {
      attrs: [
        { ns: '', name: 'package', typed: 'com.a.b' },
        { ns: ANDROID_NS, name: 'label', typed: 'Kiểm thử' },
      ],
    };
    // Thuộc tính không có namespace (như package) phải truyền null mới lấy được; đây là tiền đề then chốt của parseApk
    assert(attrValue(node, 'package', null) === 'com.a.b', 'package cần ns=null');
    assert(attrValue(node, 'package') === null, 'Mặc định chỉ nhận namespace android');
    assert(attrValue(node, 'label') === 'Kiểm thử', 'Thuộc tính android dùng namespace mặc định');
    assert(attrValue(node, 'label', null) === 'Kiểm thử', 'Khi ns=null phải tìm thấy thuộc tính android');
  });
}
{
  const tmp = path.join(os.tmpdir(), `apkstart-synth-${Date.now()}.apk`);
  fs.writeFileSync(tmp, buildApkBytes());
  try {
    const meta = parseApk(tmp);
    test('Tên gói: package trên manifest là thuộc tính không có namespace', () => {
      assert(meta.package === 'com.example.test', `Thực tế ${meta.package}`);
    });
    test('Tên ứng dụng / phiên bản / SDK', () => {
      assert(meta.label === 'TestApp', `label=${meta.label}`);
      assert(meta.versionName === '1.2.3', `versionName=${meta.versionName}`);
      assert(meta.versionCode === 7, `versionCode=${meta.versionCode}`);
      assert(meta.minSdk === 21 && meta.targetSdk === 34, `sdk=${meta.minSdk}/${meta.targetSdk}`);
    });
    test('Activity khởi chạy được phân tích từ intent-filter', () => {
      assert(meta.launchActivity === 'com.example.test.Main', `activity=${meta.launchActivity}`);
    });
    test('Thư mục ABI và tài nguyên icon', () => {
      assert(JSON.stringify(meta.abis) === '["arm64-v8a"]', JSON.stringify(meta.abis));
      assert(meta.iconFile === 'res/mipmap-hdpi/ic_launcher.png', `icon=${meta.iconFile}`);
      assert(meta.iconPng && meta.iconPng[0] === 0x89 && meta.iconPng[1] === 0x50, 'Icon phải là PNG');
      assert(meta.sizeBytes === fs.statSync(tmp).size, 'Kích thước file phải được điền lại');
    });
  } finally {
    try { fs.rmSync(tmp, { force: true }); } catch (_) { /* ignore */ }
  }
}

console.log(`\nKết quả: ${passed} đạt, ${failed} lỗi\n`);
process.exit(failed ? 1 : 0);
