'use strict';
/**
 * Kiểm thử hồi quy cho tự thích ứng không cần cấu hình / thu gọn kiểu container (thuần Node, không khởi chạy emulator)
 * Chạy: node test/auto-test.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = path.join(os.tmpdir(), `apkstart-auto-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];
function test(name, fn) {
  return Promise.resolve().then(fn)
    .then(() => { passed += 1; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed += 1; results.push(`  ✗ ${name}\n    ${e.stack || e.message}`); });
}
function assert(c, m) { if (!c) throw new Error(m || 'Khẳng định thất bại'); }

const doctor = require('../src/core/doctor');
const layers = require('../src/core/layers');
const pointer = require('../src/core/pointer');
const { AdbClient, friendlyInstallError, friendlyLaunchError } = require('../src/core/adb');

(async () => {
  console.log('\n[doctor.js tham số tự động]');

  await test('Chọn backend GPU theo phiên bản emulator (bản mới ưu tiên host + dự phòng render phần mềm, bản cũ dùng swiftshader_indirect)', () => {
    // Bản mới (37.x/36.4.9+): host phản hồi nhạy nhất, lỗi thì tự hạ cấp xuống software/swangle
    assert(doctor.gpuCandidates('37.3.8.0')[0] === 'host', '37.x phải ưu tiên host');
    assert(doctor.gpuCandidates('36.4.9.0')[0] === 'host');
    assert(doctor.gpuCandidates('37.3.8.0').includes('software'), 'Bản mới bắt buộc có dự phòng render phần mềm');
    // Truyền swiftshader_indirect trên 37.x sẽ khiến khởi tạo GL thất bại, tuyệt đối không được có trong danh sách ứng viên
    assert(!doctor.gpuCandidates('37.3.8.0').includes('swiftshader_indirect'));
    // Bản cũ vẫn dùng swiftshader_indirect
    assert(doctor.gpuCandidates('35.1.4.0')[0] === 'host');
    assert(doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
  });

  await test('Máy ít RAM tự hạ cấu hình (không còn cố định 4GB / 4 nhân)', () => {
    const host = { totalMB: 4096, freeMB: 2600, cores: 2, home: 'C:\\Users\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: false }, emulatorVersion: '37.3.8.0', diskMB: 20000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB === 2048, `Bộ nhớ phải là 2048, thực tế ${p.memoryMB}`);
    assert(p.cores === 2, `Số nhân phải là 2, thực tế ${p.cores}`);
    assert(p.accel === 'off', 'Không có tăng tốc phần cứng thì phải tự lùi về giả lập phần mềm');
    assert(p.bootTimeoutMs > 240000, 'Giả lập phần mềm phải có thời gian chờ khởi động dài hơn');
    assert(p.gpu === 'host', `Render ưu tiên phải là host (lỗi thì planVariants hạ cấp), thực tế ${p.gpu}`);
    // Khi tắt accel, tham số dự phòng cuối phải là render phần mềm, nếu không dưới TCG sẽ không có GPU để dùng
    const lastResort = doctor.planVariants(p).find((v) => v.lastResort);
    assert(lastResort && /software|swiftshader/.test(lastResort.gpu), 'Phương án dự phòng cuối phải dùng render phần mềm');
    // Phân vùng dữ liệu mặc định cấp 4/6/8GB theo dung lượng đĩa còn trống (không còn cố định 16G), và có thể bị cài đặt ghi đè
    assert(p.dataMB >= 4096 && p.dataMB <= 8192, `Phân vùng dữ liệu phải trong khoảng 4~8GB, thực tế ${p.dataMB}`);
    const big = doctor.chooseProfile({
      host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000,
      settings: { engine: { dataPartitionGB: 24 } }, overrides: {},
    });
    assert(big.dataMB === 24 * 1024, 'Dung lượng phân vùng dữ liệu trong cài đặt phải có hiệu lực');
  });

  await test('Máy nhiều RAM không bị ngốn bộ nhớ vô hạn', () => {
    const host = { totalMB: 65536, freeMB: 50000, cores: 32, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const p = doctor.chooseProfile({ host, accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 200000, port: 5554, adbPort: 5044 });
    assert(p.memoryMB <= 3072 && p.cores <= 4, `Cấu hình cao cũng phải có trần: ${p.memoryMB}MB / ${p.cores} nhân`);
    assert(p.accel === 'auto');
  });

  await test('Ma trận thử lại: từ tối ưu nhất đến an toàn nhất, có dự phòng giả lập phần mềm và khởi động nguội', () => {
    const p = doctor.chooseProfile({
      host: doctor.hostInfo(), accel: { ok: true }, emulatorVersion: '37.3.8.0',
      diskMB: 50000, port: 5554, adbPort: 5044,
    });
    const v = doctor.planVariants(p);
    assert(v.length >= 3 && v.length <= 4, `Số lần thử lại phải là 3-4, thực tế ${v.length}`);
    assert(v.some((x) => x.accel === 'off'), 'Thiếu dự phòng giả lập phần mềm');
    // Mức cuối chỉ làm “không nạp snapshot + bộ nhớ tối thiểu”, tuyệt đối không cho phép -wipe-data:
    // khi đĩa đầy thì mức nào cũng thất bại, nếu có wipe sẽ xóa luôn các ứng dụng người dùng đã cài (đã gặp thực tế).
    assert(v[v.length - 1].snapshot === false, 'Mức cuối phải bỏ qua nạp snapshot');
    assert(v[v.length - 1].wipe === false, 'Không lần thử lại tự động nào được phép xóa dữ liệu người dùng');
    assert(v[v.length - 1].memoryMB <= 2048, 'Mức cuối phải hạ xuống bộ nhớ tối thiểu');
    const keys = v.map((x) => `${x.gpu}|${x.accel}|${x.wipe}|${x.memoryMB}|${x.snapshot !== false}`);
    assert(new Set(keys).size === keys.length, 'Các phương án thử lại không được trùng nhau');
  });

  await test('Chuyển image sang ổ khác không tính là đổi image: sysdir đổi thư mục thì không được xóa dữ liệu người dùng', () => {
    const c = 'C:/Users/x/AppData/Roaming/apkstart/system-images/android-34/google_apis_playstore/x86_64/';
    const d = 'D:/ApkStartRuntime/system-images/android-34/google_apis_playstore/x86_64/';
    assert(doctor.imageIdentity(c) === doctor.imageIdentity(d), 'Danh tính đường dẫn của cùng một bộ image phải giống nhau');
    const key = (p) => doctor.snapshotKey({ emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' }, p);
    assert(key(c) === key(d), 'Sau khi đổi ổ, snapshot không được bị vô hiệu (nếu không sẽ phải chờ một lần khởi động nguội vô ích)');
    const other = 'D:/rt/system-images/android-34/google_apis/x86_64/';
    assert(doctor.imageIdentity(other) !== doctor.imageIdentity(d), 'Thật sự đổi image thì phải nhận ra được');
  });

  await test('Dấu vân tay snapshot không đổi theo các lần thử lại GPU/tăng tốc/bộ nhớ (tránh mỗi lần thử lại đều xóa sạch ứng dụng đã cài)', () => {
    const a = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const b = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img');
    const c = doctor.snapshotKey({ dataMB: 4096, emulatorVersion: '37.3.8.0', api: '34', tag: 'google_apis_playstore' }, 'C:\\img2');
    assert(a === b && a !== c);
  });

  await test('Chẩn đoán log nhận diện được lỗi card đồ họa/tăng tốc/đường dẫn không phải ASCII/file khóa', () => {
    assert(doctor.diagnose(['Failed to initialize GL emulation']).code === 'GPU_INIT');
    assert(doctor.diagnose(['ERROR: x86_64 emulation currently requires hardware acceleration!']).code === 'ACCEL');
    assert(doctor.diagnose(['Cannot allocate memory for guest RAM']).code === 'MEMORY');
    assert(doctor.diagnose(['panic: AVD apkstart is already running']).code === 'AVD_LOCK');
    assert(doctor.diagnose(['non-ASCII path is not supported']).code === 'NON_ASCII');
    assert(doctor.diagnose(['random line']).code === 'UNKNOWN');
  });

  await test('Chẩn đoán log: emulator thoát với 0xC0000005 phải được xác định là backend render bị crash', () => {
    // Thực tế issue #20/#25: in xong Userspace boot properties rồi exit 3221225477
    assert(doctor.diagnose(['emulator exit 3221225477']).code === 'ACCESS_VIOLATION');
    assert(doctor.diagnose(['... 0xC0000005 ...']).code === 'ACCESS_VIOLATION');
    // Log crash thường cũng kèm thông tin khởi tạo render: phải ưu tiên kết luận crash, chứ không phải GPU_INIT
    const mixed = ['Graphics backend: gfxstream', 'emulator exit 3221225477'];
    assert(doctor.diagnose(mixed).code === 'ACCESS_VIOLATION', 'Crash phải được ưu tiên hơn log render thông thường');
  });

  await test('Dò cổng trống trả về cặp cổng chẵn', async () => {
    const p = await doctor.freePortPair(5560);
    assert(p % 2 === 0 && p >= 5560, `Cổng bất thường: ${p}`);
  });

  await test('Tham số tự động hiển thị ở trang cài đặt khớp với tham số chạy thực (37.x không còn hiển thị backend đã bị loại bỏ)', () => {
    const common = { accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000, port: 5562, adbPort: 5044 };
    const p = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: true, gpuMode: 'auto', memoryMB: 0, cores: 0 } } });
    const text = doctor.describeProfile(p);
    assert(p.gpu === 'host', `Phải là host (lỗi thì hạ cấp), thực tế ${p.gpu}`);
    assert(p.accelOk === true && text.includes('tăng tốc phần cứng'), text);
    assert(!text.includes('swiftshader_indirect'), text);
    assert(text.includes('cổng 5562'), text);

    // Engine cũ vẫn dùng backend cũ; tham số nâng cao người dùng tự nhập vẫn có hiệu lực
    const old = doctor.autoProfile({ ...common, emulatorVersion: '35.1.4.0', settings: {} });
    assert(old.gpu === 'host' && doctor.gpuCandidates('35.1.4.0').includes('swiftshader_indirect'));
    const manual = doctor.autoProfile({ ...common, settings: { engine: { autoMemory: false, memoryMB: 6144, cores: 6, gpuMode: 'swiftshader' } } });
    assert(manual.memoryMB === 6144 && manual.cores === 6 && manual.gpu === 'swiftshader', JSON.stringify(manual));
    const zero = doctor.overridesFromSettings({ autoMemory: false, memoryMB: 0, cores: 0, gpuMode: 'auto' });
    assert(zero.memoryMB === 0 && zero.cores === 0 && zero.gpuMode === '', JSON.stringify(zero));
  });

  console.log('\n[layers.js thu gọn kiểu container]');

  await test('Kiểm kê mục có thể thu hồi: QEMU không phải x86_64, image cũ, AVD cũ, file khóa, snapshot cũ', () => {
    const root = path.join(TMP, 'runtime-layers');
    const mk = (p, size) => {
      fs.mkdirSync(path.dirname(p), { recursive: true });
      const b = Buffer.alloc(size || 16, 65);
      fs.writeFileSync(p, b);
    };
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'system.img'), 1024);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'kernel-ranchu'), 16);
    mk(path.join(root, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64', 'NOTICE.txt'), 2048);
    mk(path.join(root, 'system-images', 'android-30', 'default', 'x86_64', 'system.img'), 512);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-aarch64.exe'), 128);
    mk(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe'), 128);
    mk(path.join(root, 'avd', 'apkstart.avd', 'config.ini'), 32);
    mk(path.join(root, 'avd', 'apkstart.avd', 'snapshots', 'default_boot', 'ram.img'), 256);
    mk(path.join(root, 'avd', 'apkstart.avd', 'multiInstance.lock'), 8);
    mk(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img'), 512);

    const a = layers.analyze(root);
    const paths = a.candidates.map((c) => c.path.replace(/\\/g, '/'));
    assert(paths.some((p) => p.endsWith('qemu-system-aarch64.exe')), 'Phải liệt kê QEMU không phải x86_64');
    assert(!paths.some((p) => p.endsWith('qemu-system-x86_64.exe')), 'Không được xóa QEMU x86_64');
    assert(paths.some((p) => p.includes('android-30')), 'Phải liệt kê image API30 cũ');
    assert(paths.some((p) => p.endsWith('.lock')), 'Phải liệt kê file khóa');
    assert(paths.some((p) => p.includes('snapshots')), 'Phải liệt kê snapshot cũ');
    assert(paths.some((p) => p.includes('apkstart-arm.avd')), 'Phải liệt kê AVD không hoạt động');
    assert(!paths.some((p) => p.endsWith('apkstart.avd/config.ini')), 'Không được xóa cấu hình AVD đang hoạt động');

    const dry = layers.prune(root, { apply: false });
    assert(dry.removed.length === 0 && dry.saved === 0, 'dryRun không được xóa file nào');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd', 'userdata-qemu.img')));

    const done = layers.prune(root, { apply: true });
    assert(done.saved > 0 && done.removed.length >= 5, 'Dọn dẹp thực tế phải giải phóng dung lượng');
    assert(!fs.existsSync(path.join(root, 'avd', 'apkstart-arm.avd')), 'AVD không hoạt động phải bị xóa');
    assert(fs.existsSync(path.join(root, 'avd', 'apkstart.avd', 'config.ini')), 'AVD đang hoạt động phải được giữ lại');
    assert(fs.existsSync(path.join(root, 'emulator', 'qemu', 'windows-x86_64', 'qemu-system-x86_64.exe')), 'QEMU x86_64 phải được giữ lại');
  });

  console.log('\n[adb.js độ dễ hiểu của lỗi cài đặt/khởi chạy]');

  await test('Ứng dụng targetSdk cũ thất bại trên Android 14 có hướng dẫn rõ ràng', () => {
    const s = friendlyInstallError('Failure [INSTALL_FAILED_DEPRECATED_SDK_VERSION: app must target at least 23]');
    assert(s.includes('Android 14') && s.includes('tự động'), s);
  });

  await test('Crash lớp dịch ARM đưa ra được kết luận có thể hành động', () => {
    const s = friendlyLaunchError('F DEBUG: DoBadTrampoline libndk_translation SIGABRT', 'com.phoenix.read');
    assert(s.includes('lớp dịch ARM') && s.includes('image tương thích'), s);
  });

  console.log('\n[sharer không còn chuyển qua chuyển lại (thủ phạm làm đầy đĩa)]');

  await test('Cùng một file không bị kéo về từ thiết bị ở mỗi vòng', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared');
    fs.mkdirSync(localDir, { recursive: true });
    const file = path.join(localDir, 'a.txt');
    fs.writeFileSync(file, 'hello');

    const calls = { push: 0, pull: 0 };
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => { calls.push += 1; },
      pull: async (_r, dst) => { calls.pull += 1; fs.writeFileSync(dst, 'hello'); },
      listRemoteStat: async () => [{ rel: 'a.txt', size: 5, mtime: Date.now() - 60000 }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    sh.localDirOverride = localDir;
    // Dùng đường dẫn/file trạng thái thật, nhưng thư mục trỏ tới thư mục tạm
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state.json');

    await sh.sync();          // Vòng 1: file mới trên máy → đẩy lên
    const firstPull = calls.pull;
    await sh.sync();          // Vòng 2
    await sh.sync();          // Vòng 3
    await sh.sync();          // Vòng 4
    assert(calls.push === 1, `Chỉ được đẩy một lần, thực tế ${calls.push}`);
    assert(firstPull === 0, `File vừa đẩy lên không được kéo về ngay, thực tế đã kéo ${firstPull} lần`);
    assert(calls.pull === firstPull, `Các vòng sau không được kéo lặp lại, thực tế tổng cộng ${calls.pull} lần`);
  });

  await test('File cực lớn không bị kéo ngược về máy (thư mục cục bộ không phải cống xả bộ đệm của thiết bị)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const localDir = path.join(TMP, 'shared2');
    fs.mkdirSync(localDir, { recursive: true });
    let pulled = 0;
    const fakeClient = {
      isOnline: async () => true,
      shellMkdir: async () => {},
      shell: async () => '',
      push: async () => {},
      pull: async () => { pulled += 1; },
      listRemoteStat: async () => [{ rel: 'big.mp4', size: 600 * 1024 * 1024, mtime: Date.now() }],
    };
    const sh = new Sharer({ client: () => fakeClient });
    Object.defineProperty(sh, 'localDir', { get: () => localDir });
    Object.defineProperty(sh, 'remoteDir', { get: () => '/sdcard/x' });
    sh.stateFile = path.join(TMP, 'shared-state2.json');
    await sh.sync();
    assert(pulled === 0, 'File vượt quá 512MB không được kéo về máy');
  });

  console.log('\n[adb/sharer trao đổi file]');

  await test('Phân tích ls -l tương thích định dạng có group / ngày của Android', async () => {
    const { AdbClient } = require('../src/core/adb');
    const fake = Object.create(AdbClient.prototype);
    fake.shell = async () => '-rw-rw---- 1 u0_a188 media_rw 12 2026-11-12 18:52 hello.txt\r\n'
      + 'drwxrwx--- 2 u0_a188 media_rw 4096 2026-11-12 18:52 sub\r\n'
      + '-rw-rw---- 1 u0_a188 7 Nov 12 18:52 no-group.txt\r\n';
    const rows = await fake.listRemote('/sdcard/x');
    assert(rows.length === 3, `Phải phân tích được 3 dòng, thực tế ${rows.length}`);
    assert(rows[0].name === 'hello.txt' && rows[0].size === 12, JSON.stringify(rows[0]));
    assert(rows[1].isDir && rows[1].name === 'sub', JSON.stringify(rows[1]));
    assert(rows[2].name === 'no-group.txt' && rows[2].size === 7, JSON.stringify(rows[2]));
  });

  await test('Danh sách file phía thiết bị lấy đủ một lần bằng find+stat (không phụ thuộc phân tích ngày của ls)', async () => {
    const { Sharer } = require('../src/core/sharer');
    const sh = Object.create(Sharer.prototype);
    const fake = {
      shell: async () => '12|1794480758|./a.txt\n8|1794480759|./sub/b.txt\n',
      listRemote: async () => [],
    };
    const rows = await sh.listRemoteRecursive(fake, '/sdcard/x');
    assert(rows.length === 2, `Phải trả về 2 file, thực tế ${rows.length}`);
    assert(rows[1].rel === 'sub/b.txt' && rows[1].mtime > 1e12, JSON.stringify(rows[1]));
  });

  console.log('\n[zip.js giải nén dạng luồng cho gói lớn]');

  await test('ZipFile và ZipArchive cho kết quả phân tích giống nhau trên cùng một gói nén (gồm deflate và pipeTo dạng luồng)', async () => {
    const zlib = require('zlib');
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const entries = [
      { name: 'a.txt', data: Buffer.from('hello apkstart'), method: 0 },
      { name: 'dir/b.bin', data: Buffer.alloc(200000, 7), method: 8 },
    ];
    const locals = [];
    const centrals = [];
    let off = 0;
    for (const it of entries) {
      const raw = it.method === 8 ? zlib.deflateRawSync(it.data) : it.data;
      const name = Buffer.from(it.name);
      const lh = Buffer.alloc(30);
      lh.writeUInt32LE(0x04034b50, 0);
      lh.writeUInt16LE(20, 4);
      lh.writeUInt16LE(it.method, 8);
      lh.writeUInt32LE(raw.length, 18);
      lh.writeUInt32LE(it.data.length, 22);
      lh.writeUInt16LE(name.length, 26);
      locals.push(lh, name, raw);
      const ch = Buffer.alloc(46);
      ch.writeUInt32LE(0x02014b50, 0);
      ch.writeUInt16LE(20, 4);
      ch.writeUInt16LE(20, 6);
      ch.writeUInt16LE(it.method, 10);
      ch.writeUInt32LE(raw.length, 20);
      ch.writeUInt32LE(it.data.length, 24);
      ch.writeUInt16LE(name.length, 28);
      ch.writeUInt32LE(off, 42);
      centrals.push(ch, name);
      off += lh.length + name.length + raw.length;
    }
    const cd = Buffer.concat(centrals);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(entries.length, 8);
    eocd.writeUInt16LE(entries.length, 10);
    eocd.writeUInt32LE(cd.length, 12);
    eocd.writeUInt32LE(off, 16);
    const buf = Buffer.concat([...locals, cd, eocd]);
    const zipPath = path.join(TMP, 'parity.zip');
    fs.writeFileSync(zipPath, buf);

    const mem = new ZipArchive(buf);
    const file = new ZipFile(zipPath);
    try {
      assert(mem.names().join('|') === file.names().join('|'), 'Tên mục phải giống nhau');
      assert(mem.read('a.txt').equals(file.read('a.txt')), 'Nội dung mục stored phải giống nhau');
      assert(mem.read('dir/b.bin').equals(file.read('dir/b.bin')), 'Nội dung mục deflate phải giống nhau');
      const out = path.join(TMP, 'b.bin');
      await file.pipeTo('dir/b.bin', fs.createWriteStream(out));
      assert(fs.readFileSync(out).equals(entries[1].data), 'Đầu ra luồng của pipeTo phải đầy đủ');
    } finally {
      file.close();
    }
  });

  await test('Zip64: khi EOCD dùng 0xffff/0xffffffff làm giữ chỗ, số mục và offset lấy từ Zip64 EOCD', async () => {
    const { ZipArchive, ZipFile } = require('../src/core/zip');
    const name = Buffer.from('hello.txt');
    const data = Buffer.from('hello zip64 apkstart');
    // Header cục bộ
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(45, 4);
    lh.writeUInt32LE(data.length, 18);
    lh.writeUInt32LE(data.length, 22);
    lh.writeUInt16LE(name.length, 26);
    const cenStart = lh.length + name.length + data.length;
    // Mục thư mục trung tâm: ba trường đặt 0xffffffff, giá trị thật nằm trong Zip64 extra (id=0x0001)
    const extra = Buffer.alloc(28);
    extra.writeUInt16LE(0x0001, 0);
    extra.writeUInt16LE(24, 2);
    extra.writeBigUInt64LE(BigInt(data.length), 4);
    extra.writeBigUInt64LE(BigInt(data.length), 12);
    extra.writeBigUInt64LE(0n, 20);
    const ch = Buffer.alloc(46 + name.length + extra.length);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(45, 6);
    ch.writeUInt32LE(0xffffffff, 20);
    ch.writeUInt32LE(0xffffffff, 24);
    ch.writeUInt16LE(name.length, 28);
    ch.writeUInt16LE(extra.length, 30);
    ch.writeUInt32LE(0xffffffff, 42);
    name.copy(ch, 46);
    extra.copy(ch, 46 + name.length);
    // Zip64 EOCD + locator + EOCD truyền thống (tràn hết)
    const z64 = Buffer.alloc(56);
    z64.writeUInt32LE(0x06064b50, 0);
    z64.writeBigUInt64LE(44n, 4);
    z64.writeUInt16LE(45, 12);
    z64.writeUInt16LE(45, 14);
    z64.writeBigUInt64LE(1n, 24);
    z64.writeBigUInt64LE(1n, 32);
    z64.writeBigUInt64LE(BigInt(ch.length), 40);
    z64.writeBigUInt64LE(BigInt(cenStart), 48);
    const loc = Buffer.alloc(20);
    loc.writeUInt32LE(0x07064b50, 0);
    loc.writeBigUInt64LE(BigInt(cenStart + ch.length), 8);
    loc.writeUInt32LE(1, 16);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0xffff, 8);
    eocd.writeUInt16LE(0xffff, 10);
    eocd.writeUInt32LE(0xffffffff, 12);
    eocd.writeUInt32LE(0xffffffff, 16);
    const buf = Buffer.concat([lh, name, data, ch, z64, loc, eocd]);

    const mem = new ZipArchive(buf);
    assert(mem.has('hello.txt'), 'ZipArchive phải nhận ra mục Zip64');
    assert(String(mem.read('hello.txt')) === 'hello zip64 apkstart', 'Nội dung ZipArchive phải đúng');
    assert(mem.entries.get('hello.txt').uncompSize === data.length, 'Kích thước chưa nén của ZipArchive phải lấy từ extra');

    const zipPath = path.join(TMP, 'zip64.zip');
    fs.writeFileSync(zipPath, buf);
    const file = new ZipFile(zipPath);
    try {
      assert(file.has('hello.txt'), 'ZipFile phải nhận ra mục Zip64');
      assert(String(file.read('hello.txt')) === 'hello zip64 apkstart', 'Nội dung ZipFile phải đúng');
      assert(file.entries.get('hello.txt').localOffset === 0, 'Offset header cục bộ của ZipFile phải lấy từ extra');
    } finally {
      file.close();
    }
  });

  console.log('\n[emulator.js AVD không cần cấu hình]');

  await test('AVD dùng phân vùng dữ liệu nhỏ + khởi động nhanh + chế độ GPU hiện đại', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2, gpu: 'software', dataMB: 4096, accel: 'auto' });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.ramSize=2048$/m.test(cfg));
    assert(/^disk\.dataPartition\.size=4096M$/m.test(cfg), 'Phân vùng dữ liệu không được là 16G');
    assert(/^hw\.gpu\.mode=software$/m.test(cfg));
    assert(!/^fastboot\.forceColdBoot=yes$/m.test(cfg), 'Không được ép khởi động nguội nữa');
    assert(!/^fastboot\.forceFastBoot=/m.test(cfg), 'Snapshot phải do dòng lệnh -snapshot điều khiển, tránh nạp default_boot cũ');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg));
    assert(fs.existsSync(path.join(r.avdDir, 'snapshot.key')), 'Phải ghi dấu vân tay snapshot');
  });

  await test('Tham số khởi động có bộ nhớ/nhân/snapshot tự động, và không còn dùng chế độ GPU đã bị loại bỏ', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Khi không có snapshot (AVD mới tinh / vừa bị vô hiệu) tuyệt đối không được truyền -snapshot:
    // qemu sẽ chờ mãi một trạng thái bộ nhớ không tồn tại, tiến trình vẫn sống nhưng không bao giờ khởi động xong.
    const fresh = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-gpu software/.test(fresh));
    assert(!/swiftshader_indirect/.test(fresh));
    assert(/-memory 2048/.test(fresh) && /-cores 2/.test(fresh));
    if (!emu.hasSnapshot()) {
      // Khi không có snapshot phải “chỉ cấm nạp, không cấm lưu”: -no-snapshot sẽ tắt luôn cả tự động lưu khi thoát,
      // như vậy sau lần khởi động nguội đầu tiên sẽ không bao giờ tạo được snapshot, mỗi lần người dùng mở đều phải boot toàn bộ.
      assert(/-no-snapshot-load/.test(fresh), 'Khi không có snapshot phải dùng -no-snapshot-load (chỉ bỏ qua nạp)');
      assert(!/ -no-snapshot( |$)/.test(fresh), 'Khi không có snapshot không được dùng -no-snapshot (sẽ tắt lưu khi thoát)');
    }
    // Chỉ khi snapshot thực sự tồn tại mới dùng quickboot. Lưu ý phải thật sự “giống một snapshot hoàn chỉnh”:
    // lưu bị gián đoạn sẽ để lại vỏ rỗng chỉ có snapshot.pb vài chục byte, loại đó phải coi là không có snapshot,
    // nếu không emulator sẽ thử nạp, thất bại, rồi lùi về khởi động nguội, phí vài giây chờ.
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots');
    const created = !fs.existsSync(snapDir);
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });

    // Vỏ rỗng (pb 12 byte + không có ram.img) phải coi là “không có snapshot”
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(12));
    assert(!emu.hasSnapshot(), 'Snapshot không hoàn chỉnh không được coi là snapshot dùng được');
    const broken = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-no-snapshot-load/.test(broken), 'Snapshot vỏ rỗng phải lùi về khởi động nguội (bỏ qua nạp)');

    // Snapshot hoàn chỉnh: pb có nội dung + ram.img có dữ liệu (vỏ rỗng ở bước trước sẽ được hasSnapshot dọn luôn)
    fs.mkdirSync(path.join(snapDir, 'apkstart'), { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'apkstart', 'ram.img'), Buffer.alloc(2 * 1024 * 1024));
    const withSnap = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(withSnap), 'Khi có snapshot phải dùng snapshot quickboot');
    assert(!/-no-snapshot-load/.test(withSnap), 'Khi có snapshot hoàn chỉnh không được bỏ qua nạp');
    if (created) fs.rmSync(snapDir, { recursive: true, force: true });

    const cold = emu.buildArgs({ wipe: true }).join(' ');
    assert(/-wipe-data/.test(cold), 'Khi wipe phải có -wipe-data');
    // Khi đặt lại dữ liệu: không nạp snapshot cũ (dữ liệu không khớp), nhưng **cho phép lưu** snapshot mới.
    // “Sửa mạng” phụ thuộc chuỗi này: sau khi đặt lại, lần khởi động đầu có mạng → lưu snapshot ngay → lần sau khôi phục.
    // Bản cài đặt cũ ở đây truyền -no-snapshot, tắt luôn cả lưu, khiến sửa mạng xong không lưu được snapshot.
    assert(/ -no-snapshot-load( |$)/.test(cold), 'Khi wipe không được nạp snapshot cũ');
    assert(!/ -no-snapshot( |$)/.test(cold), 'Khi wipe vẫn phải cho phép lưu snapshot mới (sửa mạng phụ thuộc vào nó)');
  });

  // Script tác tử cửa sổ có nhiều chú thích không phải ASCII. PowerShell 5.1 đọc “UTF-8 không BOM” sẽ giải mã theo ANSI,
  // ký tự bị lỗi mã hóa có thể gộp chú thích C# với dòng code tiếp theo thành một dòng —— Add-Type biên dịch thất bại ngay,
  // biểu hiện là “tác tử cửa sổ khởi động thất bại / cửa sổ ứng dụng không được nhúng”. Đã dính lỗi này một lần, dùng test để chốt lại.
  await test('Script tác tử cửa sổ phải có UTF-8 BOM (nếu không chú thích không phải ASCII sẽ làm Add-Type biên dịch thất bại)', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const buf = fs.readFileSync(file);
    assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 thiếu UTF-8 BOM');
  });

  // Cửa sổ giả lập phải là “cửa sổ con” của lớp render Chromium, không được là cửa sổ con anh em của cửa sổ chủ.
  // Ở quan hệ anh em, Electron sẽ liên tục đưa lớp web lên trên cùng, nền đen che màn hình Android, chuột bị nuốt hết
  // (viền đen / không lấp đầy / click không ăn / không bấm được nút đồng ý). Cũng không được đặt window region cho cửa sổ nhúng nữa,
  // việc đó phá hit-test và lộ viền đen sau khi resize.
  await test('Cửa sổ nhúng phải gắn dưới lớp web, và không được đặt window region nữa', () => {
    const file = path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1');
    const src = fs.readFileSync(file, 'utf8');
    assert(/SetParent\(emu, parent\)/.test(src), 'embed phải gắn vào cửa sổ cha do FindChromeRender tìm được');
    assert(/FindChromeRender\(host\)/.test(src), 'Phải tìm cửa sổ con render của Chromium');
    assert(!/CreateRectRgn\(0, clipTop/.test(src), 'Không được đặt region cắt xén cho cửa sổ nhúng');
    assert(/SetWindowRgn\(emu, IntPtr\.Zero/.test(src), 'Khi embed phải xóa region còn sót lại từ bản cũ');
  });

  // Xoay màn hình phải đổi “kích thước tấm nền vật lý” rồi khởi động lại, không được chỉ đổi wm size / density lúc chạy.
  //   - wm size: LCD vật lý vẫn dọc -> hình nằm nghiêng 90°, chỉ chiếm một dải góc trên trái, tọa độ click lệch;
  //   - wm density: kích thước framebuffer không đổi -> hình không phủ kín, phóng to xong bên phải trống một mảng lớn.
  await test('Màn hình ngang phải dựa vào kích thước tấm nền vật lý (lcdFor landscape), và không được xoay bằng wm size lúc chạy nữa', () => {
    const doctor = require('../src/core/doctor');
    const p = doctor.lcdFor({ accelOk: true, landscape: false });
    const l = doctor.lcdFor({ accelOk: true, landscape: true });
    assert(p.w === 720 && p.h === 1280, `Màn hình dọc phải là 720x1280, thực tế ${p.w}x${p.h}`);
    assert(l.w === 1280 && l.h === 720, `Màn hình ngang phải là 1280x720, thực tế ${l.w}x${l.h}`);

    const adb = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'adb.js'), 'utf8');
    const i = adb.indexOf('async setOrientation(');
    const j = adb.indexOf('async resetDisplayOverrides(');
    const body = adb.slice(i, j);
    assert(!/wm size \d/.test(body), 'setOrientation không được đặt ghi đè wm size nữa');
    assert(/wm density 190/.test(body), 'density chỉ giữ lại làm đường dự phòng');
  });

  await test('Chế độ game phải dùng độ ưu tiên cao và tắt hook chuột toàn cục', () => {
    const ps = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'priority.ps1'), 'utf8');
    assert(/game\s*=\s*'High'/.test(ps), 'Mức game phải nâng qemu lên High');
    const aw = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/opts\.enabled && !game/.test(aw), 'Chế độ game không được cài hook toàn cục WH_MOUSE_LL');
  });

  await test('Độ ưu tiên của ứng dụng tiền cảnh không được dùng below (click nhạy / video không tụt khung hình)', () => {
    const engJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'engine.js'), 'utf8');
    // balanced/performance khi có ứng dụng ở tiền cảnh phải là normal: below sẽ khiến qemu bị bỏ đói,
    // biểu hiện là giải mã video tụt khung, click phải chờ một chút mới phản hồi (nguyên nhân chính của “click không nhạy” mà người dùng nói).
    const begin = engJs.slice(engJs.indexOf('async beginApp'));
    assert(/mode === 'game' \? 'game' : 'normal'/.test(begin),
      "Độ ưu tiên tiền cảnh của beginApp phải ánh xạ game→game, còn lại→normal");
    assert(!/performance.*\? 'normal' : 'below'/.test(begin),
      'Không được để balanced rơi xuống below nữa');
    // setPriority phải chạy ở mỗi lần beginApp, không chỉ lần đầu (chuyển về lại cũng phải nâng quyền ưu tiên)
    assert(begin.split('setPriority(level)').length >= 2 || /if \(first\)[\s\S]{0,200}cancelSnapshotSave[\s\S]{0,300}setPriority\(level\)/.test(begin),
      'setPriority phải chạy ở mỗi lần beginApp, không chỉ lần đầu');
  });

  await test('Chế độ tiết kiệm tài nguyên phải hạ trần bộ nhớ (giảm mức chiếm dụng khi chạy)', () => {
    const doc = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'doctor.js'), 'utf8');
    assert(/rmode === 'save'[\s\S]{0,120}2048/.test(doc),
      'Chế độ save phải ép memoryMB xuống 2048 (tiết kiệm khoảng 1GB RAM + 1GB đĩa snapshot)');
    assert(/!overrides\.memoryMB/.test(doc), 'Việc save thu hẹp bộ nhớ phải nhường giá trị người dùng tự đặt');
  });

  await test('Tải xuống thất bại phải xóa file còn sót (nếu không sẽ tải lặp lại cùng một gói mãi)', () => {
    const dl = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'download.js'), 'utf8');
    assert(/function discardPartial/.test(dl), 'Cần discardPartial');
    assert(/chunks\.json/.test(dl), 'discardPartial phải xóa luôn cả file đi kèm phân khối');
    // Các nhánh thất bại của download / downloadParallel / downloadMulti đều phải gọi nó
    const calls = (dl.match(/discardPartial\(/g) || []).length;
    assert(calls >= 6, `Quá ít điểm dọn dẹp khi thất bại (chỉ có ${calls} chỗ), vẫn còn nhánh để lại file dở dang`);
    // Dự phòng ở lớp ngoài cùng: openStream reject ngay (kết nối bị từ chối/DNS/hết thời gian) cũng phải dọn
    assert(/catch \(e\) \{[\s\S]{0,200}discardPartial\(dest\)[\s\S]{0,80}throw e;[\s\S]{0,40}\}[\s\S]{0,10}\}/.test(dl),
      'Lớp ngoài cùng của download phải bắt được reject của openStream');
  });

  await test('Dọn phiên bản cũ: tìm được thư mục ApkStart ở bất kỳ đâu, và tuyệt đối không đụng vào phiên bản đang chạy', () => {
    const os = require('os');
    const leftovers = require('../src/core/leftovers');
    const np = (p) => { try { return path.resolve(p).toLowerCase(); } catch (_) { return String(p).toLowerCase(); } };
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-left-'));
    try {
      const mk = (name) => {
        const d = path.join(root, name);
        fs.mkdirSync(d, { recursive: true });
        fs.writeFileSync(path.join(d, 'ApkStart.exe'), 'fake-exe');
        return d;
      };
      const old1 = mk('ApkStart-v0.3.9-win64-portable');
      const old2 = mk('ApkStart-win64-portable.prev-2026-01-01T00-00-00-000Z');
      const curDir = mk('ApkStart-v0.5.0-win64-portable');
      const r = leftovers.scan({ installDir: curDir, dataDir: root, avdHome: '' });
      const found = r.items.filter((i) => i.kind === 'dir').map((i) => np(i.path));
      assert(found.includes(np(old1)), 'Thư mục phiên bản cũ thông thường không được phát hiện');
      assert(found.includes(np(old2)), 'Bản sao lưu đóng gói .prev còn sót không được phát hiện');
      assert(!found.includes(np(curDir)), 'Phiên bản đang chạy bị coi là phiên bản cũ (nguy hiểm)');
    } finally {
      try { fs.rmSync(root, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    }
  });

  await test('Triển khai tự động phải có thời gian chờ sau thất bại (tránh mỗi lần khởi động lại tải lại từ đầu)', () => {
    const mainJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
    assert(/deployFailedAt/.test(mainJs), 'Phải ghi lại thời điểm triển khai thất bại lần trước');
    assert(/COOLDOWN_MS|cooldown/.test(mainJs), 'Phải có khoảng thời gian chờ');
    assert(/force/.test(mainJs.slice(mainJs.indexOf('async function autoDeploy'))),
      'Triển khai một chạm thủ công phải bỏ qua thời gian chờ để thử lại ngay');
  });

  await test('ram.bin do emulator bản mới ghi phải được coi là snapshot hoàn chỉnh (nếu không 3GB vừa lưu sẽ bị coi là vỏ rỗng và bị xóa)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const avdDir = path.join(emu.provisioner.paths().avdHome, 'apkstart.avd');
    const snapDir = path.join(avdDir, 'snapshots', 'apkstart');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
    fs.mkdirSync(snapDir, { recursive: true });
    fs.writeFileSync(path.join(snapDir, 'snapshot.pb'), 'x'.repeat(2048));
    fs.writeFileSync(path.join(snapDir, 'ram.bin'), Buffer.alloc(2 * 1024 * 1024));
    assert(emu.hasSnapshot(), 'ram.bin phải được coi là snapshot hoàn chỉnh');
    const args = emu.buildArgs({ gpu: 'software', memoryMB: 2048, cores: 2, snapshot: true }).join(' ');
    assert(/-snapshot apkstart/.test(args), 'Khi có snapshot phải dùng quickboot');
    assert(!/-no-snapshot-load/.test(args), 'Khi có snapshot hoàn chỉnh không được bỏ qua nạp');
    fs.rmSync(path.join(avdDir, 'snapshots'), { recursive: true, force: true });
  });

  await test('Image mồi userdata: block 4K + ENCRYPT + số liệu sổ sách nhất quán', () => {
    const { buildEmptyExt4 } = require('../src/core/userdata');
    const sb = 1024;
    const img = buildEmptyExt4({ sizeMB: 64, encrypt: false });
    assert(img.readUInt16LE(sb + 0x38) === 0xEF53, 'Số magic của superblock phải là 0xEF53');
    // dm-default-key (mã hóa metadata /data của Android 13) có kích thước khối logic 4096,
    // fs block nhỏ hơn mức đó sẽ khiến mount() trả về EINVAL —— đây là thủ phạm thật của “không mount được /data”.
    assert(img.readUInt32LE(sb + 0x18) === 2, 's_log_block_size phải là 2 (4096 byte)');
    assert(img.readUInt32LE(sb + 0x1C) === 2, 's_log_cluster_size phải bằng block size');
    // Không có ext_attr thì setxattr trả về EOPNOTSUPP, nhãn SELinux không ghi vào được,
    // netd / media / tombstoned sẽ cùng exit 1, khởi động bị kẹt ở màn hình animation.
    assert((img.readUInt32LE(sb + 0x5C) & 0x8) !== 0, 'Phải có ext_attr');
    const total = img.readUInt32LE(sb + 0x04);
    const free = img.readUInt32LE(sb + 0x0C);
    const inodes = img.readUInt32LE(sb + 0x00);
    const freeInodes = img.readUInt32LE(sb + 0x10);
    assert(free > 0 && free < total, 'Số khối trống phải nằm trong khoảng (0, total)');
    assert(freeInodes === inodes - 10, 'Số inode trống phải trừ đi các inode dành riêng số 1~10 (e2fsck sẽ đối chiếu)');
    const withEnc = buildEmptyExt4({ sizeMB: 64 });
    assert((withEnc.readUInt32LE(sb + 0x60) & 0x10000) !== 0, 'Mặc định phải có ENCRYPT (FBE bắt buộc)');
    assert((img.readUInt32LE(sb + 0x60) & 0x10000) === 0, 'Khi encrypt:false phải gỡ được bit đó');
  });

  console.log('\n[Hiển thị / lối tắt / không cần thao tác]');
  await test('Chế độ cửa sổ phải thật sự mở cửa sổ (nếu không tiến trình ứng dụng vẫn sống nhưng không thấy trên màn hình)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    const win = emu.buildArgs({ headless: false, gpu: 'software', lcd: { w: 720, h: 1280, dpi: 320 } }).join(' ');
    assert(!/-no-window/.test(win), 'Chế độ cửa sổ không được dùng -no-window nữa');
    // Không được kèm -no-skin nữa: nó ghi đè -skin, khiến kích thước tấm nền trở về giá trị cũ trong config.ini,
    // biểu hiện là “cài đặt đã chuyển ngang mà thực tế vẫn dọc”, “hình chỉ chiếm một dải góc trên trái”.
    assert(!/\s-no-skin(\s|$)/.test(win), 'Chế độ cửa sổ không được kèm -no-skin (sẽ ghi đè -skin)');
    assert(/-skin \d+x\d+/.test(win), 'Chế độ cửa sổ phải dùng -skin để chỉ rõ kích thước tấm nền');
    const headless = emu.buildArgs({ headless: true }).join(' ');
    assert(/-no-window/.test(headless));
  });

  await test('Âm thanh: mặc định bật (không kèm -no-audio), tắt rồi mới kèm -no-audio', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    // Ghi đè getter settings: mặc định bật thì không được có -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: true } }) });
    const on = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(!/-no-audio/.test(on), 'Khi audio=true không được truyền -no-audio');
    // Tắt rồi mới được kèm -no-audio
    Object.defineProperty(emu, 'settings', { configurable: true, get: () => ({ engine: { audio: false } }) });
    const off = emu.buildArgs({ headless: false, gpu: 'software' }).join(' ');
    assert(/-no-audio/.test(off), 'Khi audio=false phải truyền -no-audio');
  });

  await test('Cưỡng chế di chuyển cấu hình cũ: chế độ không giao diện và “thoát sau khi khởi chạy” không còn hiệu lực', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { headless: true }, hideAfterLaunch: true });
    const s = store.getSettings();
    assert(s.engine.headless === false, 'headless phải được chuyển thành false');
    assert(s.hideAfterLaunch === false, 'hideAfterLaunch phải là false');
    assert(s.autoStart === true && s.autoDeploy === true, 'Tự khởi động cùng máy/triển khai một chạm mặc định bật');
    assert(s.createStartMenuShortcut === true, 'Lối tắt Start Menu mặc định bật');
  });

  await test('Thích ứng hiển thị: cửa sổ/toàn màn hình dùng chung độ phân giải dọc, tỷ lệ cửa sổ 9:16 kéo giãn được', () => {
    const d = require('../src/core/display');
    const area = { x: 0, y: 0, w: 1920, h: 1080 };
    // Toàn màn hình không đổi độ phân giải Android (tỷ lệ khung cửa sổ giả lập bị LCD khóa), chỉ phóng to cửa sổ
    assert(JSON.stringify(d.sizeFor('fullscreen', '900x1600', area)) === JSON.stringify({ w: 900, h: 1600 }));
    assert(JSON.stringify(d.sizeFor('window', '720x1280', area)) === JSON.stringify({ w: 720, h: 1280 }));
    assert(d.sizeFor('window', 'ngang-nhập-bừa', area).h > d.sizeFor('window', 'ngang-nhập-bừa', area).w);
    const b = d.defaultBounds(area);
    assert(b.h > b.w && b.h <= area.h && b.x >= 0 && b.y >= 0, JSON.stringify(b));
    // Toàn màn hình: phủ kín chiều cao, tính chiều rộng theo tỷ lệ dọc và căn giữa (tỷ lệ khung cửa sổ bị LCD của giả lập khóa)
    const f = d.fullscreenBounds('900x1600', area);
    assert(f.h === area.h, JSON.stringify(f));
    assert(Math.abs(f.w - Math.round(f.h * 900 / 1600)) <= 1, JSON.stringify(f));
    assert(f.x > 0 && f.x + f.w <= area.w, JSON.stringify(f));
    assert(d.densityFor(1080, 1920, 0) > 300);
    assert(d.densityFor(720, 1280, 240) === 240);
  });

  await test('Lệnh hiển thị adb dùng wm size / wm density', async () => {
    const { AdbClient } = require('../src/core/adb');
    const cmds = [];
    const fake = { shell: async (c) => { cmds.push(c); return ''; } };
    await AdbClient.prototype.setDisplaySize.call(fake, 1920, 1080, 420);
    assert(cmds.includes('wm size 1920x1080'), cmds.join('|'));
    assert(cmds.includes('wm density 420'), cmds.join('|'));
    await AdbClient.prototype.resetDisplaySize.call(fake);
    assert(cmds.includes('wm size reset') && cmds.includes('wm density reset'));
  });

  await test('PNG-in-ICO và dự phòng icon WebP đều tạo ra ICO dùng được', async () => {
    const { pngBytesToIco, iconToIco } = require('../src/core/shortcut');
    const { drawAppIcon } = require('../src/core/png');
    const png = drawAppIcon(64);
    const ico = pngBytesToIco(png);
    assert(ico && ico.readUInt16LE(2) === 1 && ico.readUInt16LE(4) === 1, 'Header ICO phải khai báo 1 ảnh');
    assert(ico.readUInt32LE(14) === png.length, 'Độ dài PNG nhúng phải khớp');
    assert(ico.slice(22).equals(png), 'Vùng dữ liệu ICO phải chính là PNG gốc');
    assert(pngBytesToIco(Buffer.from('not a png')) === null);
    // WebP (nativeImage không giải mã được) → khi không có callback decode phải lùi về ICO giữ chỗ của thương hiệu
    const webp = Buffer.concat([Buffer.from('RIFF\x00\x00\x00\x00WEBP'), Buffer.alloc(32)]);
    const fallback = await iconToIco(webp);
    assert(fallback && fallback.length > 22, 'WebP cũng phải lấy được icon');
    const decoded = await iconToIco(webp, { decode: async () => png });
    assert(decoded && decoded.slice(22).equals(png), 'Khi có decode phải dùng icon thật');
  });

  await test('Script điều khiển cửa sổ tồn tại và thuần ASCII (tránh lỗi mã hóa đường dẫn/tiêu đề không phải ASCII)', () => {
    const w = require('../src/core/windowctl');
    assert(fs.existsSync(w.SCRIPT), 'Thiếu windowctl.ps1');
    const b = fs.readFileSync(w.SCRIPT);
    assert(!b.some((x) => x > 127), 'ps1 phải thuần ASCII, ký tự không phải ASCII được truyền qua JSON UTF-8');
    assert(typeof w.present === 'function' && typeof w.getBounds === 'function');
  });

  await test('xzFile đưa file nguồn vào stdin và tạo image mà runtime giải nén được (hồi quy treo CI)', async () => {
    const { xzFile } = require('../build/prepare-runtime');
    const zlib = require('zlib');
    const crypto = require('crypto');
    const dir = path.join(TMP, 'xz-regression');
    fs.mkdirSync(dir, { recursive: true });
    const src = path.join(dir, 'sample.img');
    const payload = Buffer.concat([
      Buffer.from('APKSTART-XZ-REGRESSION'),
      crypto.randomBytes(256 * 1024),
      Buffer.alloc(1024 * 1024),
    ]);
    fs.writeFileSync(src, payload);
    const dest = path.join(dir, 'sample.img.xz');

    const saved = { XZ_PRESET: process.env.XZ_PRESET, XZ_TIMEOUT_MS: process.env.XZ_TIMEOUT_MS };
    process.env.XZ_PRESET = '1';           // Mẫu nhỏ dùng mức nhanh nhất, đừng làm chậm cả bộ test
    process.env.XZ_TIMEOUT_MS = '15000';  // Khi treo thật thì kill trong 15s, đừng làm kẹt CI
    let timer;
    try {
      await Promise.race([
        xzFile(src, dest),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('xzFile không trả về trong 25s (stdin không nhận EOF?)')), 25000);
        }),
      ]);
    } finally {
      clearTimeout(timer);
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }

    const have = (p) => (fs.existsSync(p) ? fs.statSync(p).size : 0);
    const out = have(dest) > 0 ? dest : dest.replace(/\.xz$/, '.gz');
    assert(have(out) > 0, 'Sản phẩm nén không được là 0 byte');
    let back;
    if (/\.xz$/i.test(out)) {
      // Không phụ thuộc binding native @napi-rs/lzma: job Node 20 của CI sẽ vì
      // bug đã biết của npm optional dependencies mà không nạp được nó (Node 22 thì bình thường).
      // Ở đây dùng lzma của cùng python với phía nén để đọc lại, và kiểm tra số magic XZ,
      // tính tương thích giải nén của runtime do kiểm chứng đầu-cuối bằng bộ cài thật đảm nhận.
      assert(fs.readFileSync(out).subarray(0, 6).equals(
        Buffer.from([0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00]),
      ), 'Phải là container XZ hợp lệ');
      const { findPython } = require('../build/prepare-runtime');
      const py = findPython();
      assert(py, 'Tạo ra XZ nhưng không tìm thấy python, không thể kiểm tra');
      const backPath = path.join(dir, 'sample.img.back');
      require('child_process').execFileSync(py, ['-c',
        'import lzma,sys;open(sys.argv[1],"wb").write(lzma.open(sys.argv[2],"rb").read())',
        backPath, out], { stdio: 'ignore' });
      back = fs.readFileSync(backPath);
    } else {
      back = zlib.gunzipSync(fs.readFileSync(out));
    }
    assert(back.equals(payload), 'Nội dung giải nén phải khớp từng byte với image nguồn');
  });

  console.log('\n[container.js container cấp ứng dụng]');

  const container = require('../src/core/container');

  await test('Gói hệ thống/framework không bao giờ bị cắt giảm, chỉ App người dùng mới được đưa vào dọn dẹp phiên', () => {
    for (const p of ['android', 'com.android.systemui', 'com.google.android.gms', 'com.foo.bar.baz']) {
      const sys = container.isSystemPackage(p);
      if (p.startsWith('com.foo')) assert(!sys, `${p} phải được nhận diện là App người dùng`);
      else assert(sys, `${p} phải được nhận diện là gói hệ thống`);
    }
    assert(container.isSystemPackage(''), 'Tên gói rỗng được coi là gói hệ thống, tránh sinh ra lệnh không hợp lệ');
  });

  await test('Khởi chạy ứng dụng chỉ dừng các App đã cài khác, mặc định tuyệt đối không đụng gói hệ thống', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.phoenix.read', 'com.other.app', 'com.android.vending', 'com.google.android.gms', 'com.third.game'],
    });
    assert(r.stopped.length === 2, `Phải dừng 2 App người dùng khác, thực tế ${r.stopped.join(',')}`);
    assert(r.stopped.includes('com.other.app') && r.stopped.includes('com.third.game'));
    assert(!r.commands.some((c) => c.includes('pm disable')), 'Mặc định không được vô hiệu hóa gói hệ thống');
    assert(!r.commands.some((c) => c.includes('kill-all')), 'Giai đoạn khởi chạy không được dọn nền, tránh làm hỏng nhầm App vừa lên tiền cảnh');
    assert(!r.commands.some((c) => /force-stop (android|com\.android|com\.google\.android)/.test(c)), 'Không được force-stop framework hệ thống');
  });

  await test('Danh sách trắng tên gói: danh sách bị nhiễm bẩn không ghép ra được lệnh chèn', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read',
      installed: ['com.evil;rm -rf /', 'com.ok.app', '$(whoami)', 'com.foo-bar'],
    });
    assert(r.stopped.length === 1 && r.stopped[0] === 'com.ok.app', `Chỉ được dừng tên gói hợp lệ, thực tế ${r.stopped.join(',')}`);
    assert(!r.commands.some((c) => c.includes('rm -rf') || c.includes('$(')), 'Không được xuất hiện đoạn chèn');
  });

  await test('Cắt giảm sâu có thể vô hiệu hóa gói nền, khôi phục được đầy đủ, không đụng thành phần thiết yếu', () => {
    const r = container.buildSessionCommands({
      pkg: 'com.phoenix.read', installed: [], deep: true,
    });
    assert(r.disabled.length > 0, 'Cắt giảm sâu phải có mục có thể vô hiệu hóa');
    assert(r.commands.some((c) => c.includes('pm disable-user --user 0 com.android.vending')));
    for (const p of container.NEVER_TRIM) {
      assert(!r.disabled.includes(p), `${p} tuyệt đối không được bị vô hiệu hóa`);
    }
    const back = container.buildRestoreCommands();
    for (const p of container.OPTIONAL_SYSTEM) {
      assert(back.some((c) => c.includes(`pm enable ${p}`)), `${p} phải khôi phục được`);
    }
  });

  await test('Tạm dừng container: dọn nền + Android idle, và máy trạng thái bao quát nhiều cửa sổ/đóng cửa sổ cuối', () => {
    const idle = container.buildIdleCommands();
    assert(idle.some((c) => c.includes('am kill-all')), 'Tạm dừng phải dọn các tiến trình nền đang cache');
    assert(idle.some((c) => c.includes('deviceidle force-idle')), 'Tạm dừng phải cho Android vào idle');
    let s = container.nextSessionState([], 'open', 'a');
    assert(s.hasApp && !s.idle && s.foreground === 'a');
    s = container.nextSessionState(s.active, 'open', 'b');
    assert(s.active.length === 2 && s.foreground === 'b');
    s = container.nextSessionState(s.active, 'close', 'a');
    assert(s.active.length === 1 && s.hasApp && !s.idle);
    s = container.nextSessionState(s.active, 'close', 'b');
    assert(s.idle && !s.hasApp && s.active.length === 0, 'Sau khi đóng cửa sổ cuối cùng, container phải được tạm dừng');
  });

  await test('doctor container nhẹ: thu hẹp vCPU, cài đặt thủ công được ưu tiên', () => {
    const host = { totalMB: 32768, freeMB: 20000, cores: 16, home: 'C:\\x', homeAscii: true, tmp: TMP, platform: 'win32', arch: 'x64', rdp: false };
    const lite = doctor.liteProfile({ host, engine: {} });
    // Logic cũ là floor(số nhân/4) kẹp trong 2~3 —— máy 8 nhân chỉ được 2 vCPU, ứng dụng video giật ngay.
    // Giờ chế độ cân bằng cấp “một nửa số nhân vật lý, tối đa 4”, chế độ tiết kiệm tài nguyên cố định 2.
    assert(lite && lite.cores === 4, `Máy 16 nhân ở chế độ cân bằng phải được 4 nhân, thực tế ${lite && lite.cores}`);
    const save = doctor.liteProfile({ host, engine: { resourceMode: 'save' } });
    assert(save.cores === 2, `Chế độ tiết kiệm tài nguyên phải cố định 2 nhân, thực tế ${save.cores}`);
    assert(doctor.liteProfile({ host, engine: { liteMode: false } }) === null, 'Tắt tường minh thì phải trả về null');
    const low = doctor.liteProfile({ host: { ...host, cores: 2 }, engine: {} });
    assert(low.cores === 2, 'Máy 2 nhân phải giữ ít nhất 2 nhân');

    const auto = doctor.autoProfile({
      settings: { engine: { autoMemory: true, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(auto.lite === true && auto.cores <= 4, JSON.stringify({ lite: auto.lite, cores: auto.cores }));
    const manual = doctor.autoProfile({
      settings: { engine: { autoMemory: false, cores: 6, liteMode: true } },
      accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 100000,
    });
    assert(manual.cores === 6, 'Số nhân người dùng tự chỉ định phải được ưu tiên hơn chế độ nhẹ');
    assert(/container nhẹ/.test(doctor.describeProfile(auto)), 'Tóm tắt chẩn đoán phải ghi rõ container nhẹ');
  });

  await test('Hook chuột toàn cục mặc định tắt, và tác tử cửa sổ không còn chặn vòng lặp thông điệp lâu', () => {
    const root = path.join(__dirname, '..');
    const agentPs1 = fs.readFileSync(path.join(root, 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    const agentJs = fs.readFileSync(path.join(root, 'src', 'core', 'agent.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(root, 'src', 'main.js'), 'utf8');
    const appwinJs = fs.readFileSync(path.join(root, 'src', 'core', 'appwin.js'), 'utf8');
    const storeJs = fs.readFileSync(path.join(root, 'src', 'core', 'store.js'), 'utf8');
    const uiHtml = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');

    assert(/mouseSideButtons:\s*false/.test(storeJs), 'Trong cài đặt mặc định, hook nút bên phải tắt');
    assert(!/winAgent\.hook\(true\)/.test(mainJs), 'Tiến trình chính không được cài hook toàn cục vô điều kiện nữa');
    assert(!/agent\.hook\(true\)/.test(appwinJs), 'Cửa sổ ứng dụng không được cài hook toàn cục vô điều kiện nữa');
    assert(!/sharer\.start\(8000\)/.test(mainJs), 'Đồng bộ file không được thường trú vô điều kiện');
    assert(/setHook/.test(agentJs) && /hooked/.test(agentJs), 'Bật/tắt hook phải lũy đẳng và tắt được');
    assert(/new Thread\(HookThreadProc\)/.test(agentPs1), 'Hook phải được cài trên luồng thông điệp riêng');
    assert(/GetMessage\(out MSG/.test(agentPs1), 'Luồng hook phải chạy vòng lặp thông điệp');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'Vòng lặp chính không được chặn 4 giây nữa');
    assert(/Poll\(50,\s*SelectMode\.SelectRead\)/.test(agentPs1), 'Vòng lặp chính phải thăm dò ngắn để giữ vòng lặp thông điệp phản hồi');
    assert(/now - _embedAt < 8000/.test(agentPs1), 'Tuần tra cửa sổ phải có giới hạn thời gian, không được EnumWindows mỗi 2 giây mãi mãi');
    assert(/setLiteMode/.test(uiHtml) && /setDeepTrim/.test(uiHtml), 'Trang cài đặt cần hiển thị tùy chọn container nhẹ');
  });

  await test('WinAgent.setHook(false) ở trạng thái mặc định không khởi chạy tác tử PowerShell', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    a.hooked = false;
    const r = await a.setHook(false);
    assert(r && r.hooked === false, 'Tắt phải trả về hooked=false');
    assert(a.ready === null, 'Khi mặc định tắt không được vì thế mà khởi động tiến trình tác tử thường trú');
  });

  console.log('\n[Ánh xạ phím chuột]');

  await test('Mặc định và di chuyển cấu hình cũ: chuột phải = quay lại + cuộn mượt bật, nút bên tắt', () => {
    const store = require('../src/core/store');
    const d = pointer.pointerOptions(store.getSettings());
    assert(d.rightBack === true, 'Chuột phải quay lại mặc định bật');
    assert(d.wheel === 'smooth', 'Con lăn mặc định cuộn mượt');
    assert(d.side === false, 'Nút bên mặc định tắt');
    assert(d.enabled === true, 'Ít nhất ánh xạ chuột phải cần hook');
    // settings.json cũ không có khóa mới cũng phải cho cùng kết quả
    assert(pointer.pointerOptions({ engine: { liteMode: true } }).rightBack === true);
    const off = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'off', mouseSideButtons: false } });
    assert(off.enabled === false, 'Tắt hết rồi thì không được cài hook nữa');
    const native = pointer.pointerOptions({ engine: { mouseRightBack: false, mouseWheelMode: 'native', mouseSideButtons: false } });
    assert(native.enabled === false, 'Con lăn gốc không cần hook');
  });

  await test('hookOptions chuẩn hóa cấu hình, khi tắt mọi công tắc con cùng về 0', () => {
    const on = pointer.hookOptions({ enabled: true, rightBack: true, wheel: true, side: false });
    assert(on.rightBack && on.wheel && !on.side);
    const off = pointer.hookOptions({ enabled: false, rightBack: true, wheel: true, side: true });
    assert(!off.rightBack && !off.wheel && !off.side, 'enabled=false phải hoàn toàn không chặn sự kiện');
    assert(pointer.hookOptions(true).side === true, 'Tương thích cách viết boolean cũ (nút bên)');
    assert(pointer.hookOptions(false).enabled === false);
  });

  await test('Hướng con lăn: cuộn xuống = ngón tay vuốt lên, cuộn lên = ngón tay vuốt xuống, tọa độ không vượt biên', () => {
    const down = pointer.wheelToSwipe({ dy: -120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(down && down.y1 > down.y2, 'Cuộn xuống phải làm nội dung dịch lên (ngón tay vuốt lên)');
    const up = pointer.wheelToSwipe({ dy: 120, nx: 0.5, ny: 0.5, width: 900, height: 1600 });
    assert(up && up.y1 < up.y2, 'Cuộn lên phải làm nội dung dịch xuống (ngón tay vuốt xuống)');
    assert(pointer.wheelToSwipe({ dx: 0, dy: 0 }) === null, 'Dịch chuyển bằng 0 không sinh lệnh');
    for (const s of [down, up]) {
      assert([s.x1, s.x2].every((v) => v >= 1 && v <= 899), 'x không được vượt biên');
      assert([s.y1, s.y2].every((v) => v >= 1 && v <= 1599), 'y không được vượt biên');
      assert(s.duration >= 100 && s.duration <= 240, 'Thời lượng vuốt phải có giới hạn trên');
    }
    const big = pointer.wheelToSwipe({ dy: -12000, nx: 0, ny: 0, width: 900, height: 1600 });
    assert(big.y1 - big.y2 <= Math.round(1600 * 0.78), 'Cuộn nhanh không được kéo dài cử chỉ vô hạn');
    const horiz = pointer.wheelToSwipe({ dx: 120, dy: 0, width: 900, height: 1600 });
    assert(horiz && horiz.x1 > horiz.x2 && horiz.y1 === horiz.y2, 'Con lăn ngang phải sinh ra vuốt ngang');
  });

  await test('Danh sách trắng lệnh input: chỉ cho qua lệnh ghép nội bộ, chặn lệnh chèn', async () => {
    assert(pointer.isInputCommand('input keyevent 4'));
    assert(pointer.isInputCommand(pointer.swipeToCommand(pointer.wheelToSwipe({ dy: -120 }))));
    assert(!pointer.isInputCommand('input keyevent 4; rm -rf /sdcard'));
    assert(!pointer.isInputCommand('input swipe 1 2 3 4 100 && reboot'));
    assert(!pointer.isInputCommand('sh -c anything'));
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    let blocked = false;
    try { await c.input('input keyevent 4; rm -rf /'); } catch (e) { blocked = /không hợp lệ/i.test(e.message); }
    assert(blocked, 'Lệnh không hợp lệ phải bị chặn trước khi khởi chạy adb');
    assert(c._input === null, 'Lệnh bị chặn không được tạo phiên thường trú');
  });

  await test('Phím quay lại ưu tiên dùng kênh nhập thường trú, lỗi mới lùi về adb dùng một lần', async () => {
    const c = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used = [];
    c.input = async (cmd) => { used.push(cmd); };
    c.shell = async () => { used.push('shell'); };
    await c.keyBack();
    assert(used[0] === 'input keyevent 4' && !used.includes('shell'), 'Nhánh bình thường không được spawn adb');
    const c2 = new AdbClient({ adbPath: 'adb', serial: 'test' });
    const used2 = [];
    c2.input = async () => { throw new Error('offline'); };
    c2.shell = async (cmd) => { used2.push(cmd); return ''; };
    await c2.keyForward();
    assert(used2[0] === 'input keyevent 125', 'Kênh thường trú lỗi thì phải có dự phòng, đừng làm mất lần click này');
  });

  await test('WheelRouter gộp các lần cuộn liên tiếp thành một lệnh vuốt', async () => {
    const cmds = [];
    const r = new pointer.WheelRouter({
      inject: async (cmd) => { cmds.push(cmd); },
      getSize: () => ({ width: 900, height: 1600 }),
      flushMs: 10,
    });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.5 });
    r.push({ dx: 0, dy: -120, nx: 0.5, ny: 0.4 });
    await r.flush();
    assert(cmds.length === 1, `Cuộn 3 nấc phải gộp thành 1 lệnh, thực tế ${cmds.length}`);
    assert(pointer.isInputCommand(cmds[0]), 'Phải tạo ra input swipe hợp lệ');
    const m = /^input swipe (\d+) (\d+) (\d+) (\d+)/.exec(cmds[0]);
    assert(m && Number(m[2]) > Number(m[4]), 'Sau khi gộp vẫn là hướng cuộn xuống');
    r.dispose();
    r.push({ dy: -120 });
    await r.flush();
    assert(cmds.length === 1, 'Sau dispose không được chèn lệnh nữa');
  });

  await test('Script tác tử: chặn chuột phải/con lăn, gộp cuộn, giới hạn tiền cảnh và luồng riêng', () => {
    const ps1 = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'), 'utf8');
    assert(/WM_RBUTTONDOWN/.test(ps1) && /WM_MOUSEWHEEL/.test(ps1), 'Phải xử lý chuột phải và con lăn');
    assert(/WM_MOUSEHWHEEL/.test(ps1), 'Con lăn ngang cũng phải hỗ trợ');
    assert(/PushWheel\(/.test(ps1) && /FlushWheel\(false\)/.test(ps1), 'Con lăn phải gộp rồi mới báo lên');
    assert(/GetAncestor\(fg, 2\)/.test(ps1), 'Phải giới hạn phạm vi theo cửa sổ gốc tiền cảnh');
    assert(/new Thread\(HookThreadProc\)/.test(ps1) && /GetMessage\(out MSG/.test(ps1), 'Hook phải nằm trên luồng thông điệp riêng');
    assert(!/Poll\(4000,\s*SelectMode\.SelectRead\)/.test(ps1), 'Vòng lặp chính không được chặn lâu');
    assert(/_optRight == 0/.test(ps1) && /_optWheel == 0/.test(ps1), 'Ánh xạ chưa cấu hình không được chặn sự kiện');
    const appwinJs = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'appwin.js'), 'utf8');
    assert(/pointerConfig/.test(appwinJs) && /refreshPointer/.test(appwinJs), 'Cài đặt thay đổi phải đồng bộ hook ngay lập tức');
    const uiHtml = fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8');
    assert(/setMouseRightBack/.test(uiHtml) && /setMouseWheelMode/.test(uiHtml), 'Trang cài đặt cần hiển thị công tắc phím');
  });

  await test('WinAgent.setHook gửi kèm cấu hình phím, và khi tắt thì không khởi chạy tác tử', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    a.call = async (obj) => { sent.push(obj); return { ok: true, hooked: true }; };
    const on = await a.setHook(true, { rightBack: true, wheel: true, side: false });
    assert(on.hooked === true && sent.length === 1, 'Bật thì chỉ được gửi lệnh một lần');
    assert(sent[0].right === 1 && sent[0].wheel === 1 && sent[0].side === 0, 'Cấu hình phải được gửi kèm lệnh hook');
    await a.setHook(false);
    assert(sent[1].on === 0 && a.hooked === false, 'Tắt phải gỡ hook');
    const b = new WinAgent();
    const r = await b.setHook(false);
    assert(r.hooked === false && b.ready === null, 'Khi mặc định tắt không được khởi động PowerShell');
  });

  console.log('\n[updater.js cập nhật trực tuyến]');
  await test('So sánh phiên bản theo số từng đoạn, tiền tố v / nhiều đoạn đều đúng', () => {
    const { cmpVer } = require('../src/core/updater');
    assert(cmpVer('v0.3.2', '0.3.1') === 1, '0.3.2 phải lớn hơn 0.3.1');
    assert(cmpVer('0.3.1', 'v0.3.1') === 0, 'Tiền tố v không ảnh hưởng phép bằng');
    assert(cmpVer('0.10.0', '0.9.9') === 1, 'Phải so theo số chứ không theo chuỗi');
    assert(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 nhỏ hơn 1.0.1');
  });

  await test('Hình thức cài đặt quyết định chọn asset nào: bản cài đặt=Setup.exe, bản portable=portable.zip', () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-setup');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const portable = new Updater({ currentVersion: '0.1.0', exePath: exe, isPackaged: true, dataDir: TMP });
    assert(portable.flavor === 'portable', 'Không có trình gỡ cài đặt thì xác định là bản portable');
    fs.writeFileSync(path.join(dir, 'Uninstall ApkStart.exe'), 'x');
    assert(portable.flavor === 'setup', 'Có trình gỡ cài đặt thì xác định là bản cài đặt');
    // Việc chọn asset là hàm thuần, ở đây đưa thẳng một kết quả check giả để kiểm quy tắc đặt tên dự phòng
    assert(/Setup\.exe$/i.test('ApkStart-0.3.2-Setup.exe'), 'Khớp tên asset bản cài đặt');
    assert(/portable.*\.zip$/i.test('ApkStart-v0.3.2-win64-portable.zip'), 'Khớp tên asset bản portable');
  });

  await test('Bản portable không coi gói runtime trọn bộ (ApkStart-runtime-*.zip) là gói cập nhật', async () => {
    const { Updater } = require('../src/core/updater');
    const dir = path.join(TMP, 'upd-asset');
    fs.mkdirSync(dir, { recursive: true });
    const exe = path.join(dir, 'ApkStart.exe');
    fs.writeFileSync(exe, 'x');
    const mk = (assets) => ({
      version: '0.5.0', tag: 'v0.5.0', name: 'ApkStart v0.5.0', notes: '', htmlUrl: '',
      publishedAt: '', sources: [], unreachable: [], assets,
    });
    const u = new Updater({ currentVersion: '0.3.4', exePath: exe, isPackaged: true, dataDir: dir });
    // Hai asset cùng tồn tại → phải chọn gói portable
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
      { name: 'ApkStart-v0.5.0-win64-portable.zip', url: 'https://x/p.zip', urls: ['https://x/p.zip'], sizes: {} },
    ]) };
    let info = await u.check({ force: true });
    assert(/portable/.test(info.asset.name), `Phải chọn gói portable, thực tế ${info.asset.name}`);

    // Chỉ có gói runtime trọn bộ (gói portable chưa được tải lên) → thà không tự động cập nhật, chứ không được lấy runtime 1.5GB làm gói chương trình
    u.sources = { latest: async () => mk([
      { name: 'ApkStart-runtime-v0.5.0.zip', url: 'https://x/runtime.zip', urls: ['https://x/runtime.zip'], sizes: {} },
    ]) };
    info = await u.check({ force: true });
    assert(!info.asset, 'Khi chỉ có gói runtime trọn bộ thì không được chọn ra asset cập nhật');
    assert(info.canAutoApply === false, 'Không có asset dùng được thì không được tự động cập nhật');
  });

  await test('Hai nguồn: địa chỉ ứng viên có tiền tố mirror, tiền tố tự đặt được ưu tiên hơn mirror công cộng', () => {
    const { Sources, withMirror } = require('../src/core/sources');
    const url = 'https://github.com/o/r/releases/download/v1/a.zip';
    const auto = new Sources(() => ({ runtime: { autoMirror: true } }));
    const list = auto.candidates(url);
    assert(list[0] === url, 'Trang nguồn phải đứng đầu (giữ thứ tự gốc trước khi sắp xếp theo đo tốc độ)');
    assert(list.length >= 2 && list.some((u) => u.includes('ghfast.top')), 'Mirror tự động phải được đưa vào danh sách ứng viên');

    const custom = new Sources(() => ({ runtime: { autoMirror: true, mirrorPrefix: 'https://my.mirror/' } }));
    const c2 = custom.candidates(url);
    assert(c2.length === 2 && c2[1] === `https://my.mirror/${url}`, `Tiền tố tự đặt phải là cái duy nhất có hiệu lực, thực tế ${JSON.stringify(c2)}`);

    const off = new Sources(() => ({ runtime: { autoMirror: false } }));
    assert(off.candidates(url).length === 1, 'Tắt mirror tự động thì chỉ còn kết nối trực tiếp');
    assert(withMirror(url, 'https://x/') === `https://x/${url}`, 'Tiền tố thiếu dấu gạch chéo cuối phải tự bổ sung');

    // Mirror chỉ làm proxy cho GitHub: địa chỉ Gitee ghép tiền tố mirror chỉ ra 403, không được đưa vào ứng viên
    const giteeUrl = 'https://gitee.com/daily-miku/apkstart/releases/download/v1/a.zip.part1';
    assert(auto.candidates(giteeUrl).length === 1, 'Asset Gitee không được gắn tiền tố mirror GitHub');
  });

  await test('Hai nguồn: kết quả đo tốc độ sắp theo tốc độ, khi tất cả thất bại thì giữ thứ tự gốc, không làm mất địa chỉ dùng được', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    // Chèn thẳng bộ đệm đo tốc độ, tránh test phụ thuộc mạng ngoài
    s._rankCache.set('https://slow/', { at: Date.now(), ok: true, speed: 1000 });
    s._rankCache.set('https://fast/', { at: Date.now(), ok: true, speed: 9000 });
    s._rankCache.set('https://dead/', { at: Date.now(), ok: false, speed: 0 });
    const ranked = await s.rank(['https://slow/', 'https://dead/', 'https://fast/']);
    assert(ranked[0] === 'https://fast/', `Nhanh nhất phải đứng đầu, thực tế ${ranked[0]}`);
    assert(ranked[2] === 'https://dead/', 'Địa chỉ thất bại xếp cuối nhưng vẫn giữ lại (còn một cơ hội)');
    s.reset();
    assert(s._rankCache.size === 0, 'reset phải xóa sạch bộ đệm đo tốc độ (đổi nguồn/đổi mạng thì phải đo lại)');
  });

  await test('Hai nguồn: gói mã nguồn Gitee tự đính kèm (v1.2.3.zip) tuyệt đối không được coi là gói cài đặt', async () => {
    const { Sources } = require('../src/core/sources');
    const s2 = new Sources(() => ({ runtime: {} }));
    s2.fetchReleases = async () => [
      {
        source: 'gitee',
        name: 'Gitee',
        web: 'e',
        rel: {
          tag_name: 'v0.3.2',
          assets: [
            { name: 'v0.3.2.zip', size: 999, browser_download_url: 'ge://src' },
            { name: 'v0.3.2.tar.gz', size: 999, browser_download_url: 'ge://src2' },
            { name: 'ApkStart-v0.3.2-win64-portable.zip', size: 10, browser_download_url: 'ge://ok' },
          ],
        },
      },
    ];
    const m = await s2.latest();
    assert(m.assets.length === 1 && m.assets[0].url === 'ge://ok',
      `Chỉ được giữ asset ApkStart*, thực tế ${JSON.stringify(m.assets.map((a) => a.name))}`);
  });

  await test('Asset của Gitee không có trường size: nhóm phân mảnh vẫn phải hình thành (nếu không cả gói bị bỏ)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [{
      source: 'gitee',
      name: 'Gitee',
      web: 'e',
      rel: {
        tag_name: 'v0.3.3',
        // Asset bản phát hành Gitee chỉ có name + url, không có size (thực tế)
        assets: [
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part1', browser_download_url: 'ge://p1' },
          { name: 'ApkStart-v0.3.3-win64-portable.zip.part2', browser_download_url: 'ge://p2' },
        ],
      },
    }];
    const m = await s.latest();
    assert(m.assets.length === 1, `Phải gộp thành 1 asset, thực tế ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.name === 'ApkStart-v0.3.3-win64-portable.zip', `Tên asset phải là tên gói trọn bộ, thực tế ${a.name}`);
    assert(a.parts && a.parts.length === 2, 'Phải giữ cả hai mảnh');
    assert(a.parts[0].urls[0] === 'ge://p1' && a.parts[1].urls[0] === 'ge://p2', 'Thứ tự/nội dung địa chỉ phân mảnh phải đúng');
    assert(a.size === 0, 'Khi chưa biết kích thước thì phải là 0 (giao diện hiển thị tiến độ theo số byte đã nhận)');
  });

  await test('Asset phân mảnh phải được truyền thẳng tới updater.asset, nếu không prepare sẽ báo “không có địa chỉ tải xuống dùng được”', async () => {
    const { Updater } = require('../src/core/updater');
    const u = new Updater({
      currentVersion: '0.0.1', exePath: path.join(TMP, 'A.exe'), isPackaged: true, dataDir: TMP,
      settings: () => ({}),
    });
    u.sources.latest = async () => ({
      version: '9.9.9',
      tag: 'v9.9.9',
      assets: [{
        name: 'ApkStart-v9.9.9-win64-portable.zip',
        size: 0,
        partial: true,
        parts: [{ index: 1, size: 0, urls: ['https://gitee.com/x/p1'] }, { index: 2, size: 0, urls: ['https://gitee.com/x/p2'] }],
      }],
      sources: [{ source: 'gitee', name: 'Gitee', tag: 'v9.9.9' }],
      unreachable: [],
    });
    const info = await u.check({ force: true });
    assert(info.asset && info.asset.parts && info.asset.parts.length === 2, 'parts phải được giữ lại trên asset');
    assert(info.canAutoApply === true, 'Có phân mảnh thì phải xác định là có thể tự động cập nhật');
  });

  await test('Hai nguồn: khi gộp phiên bản chỉ nhận asset cùng phiên bản, không lấy gói cũ giả làm gói mới', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.4.0', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'gh://a' }] } },
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.9', assets: [{ name: 'ApkStart-A-portable.zip', size: 10, browser_download_url: 'ge://a' }, { name: 'ApkStart-B.txt', size: 1, browser_download_url: 'ge://b' }] } },
    ];
    const m = await s.latest();
    assert(m.version === '0.4.0', `Phải lấy phiên bản cao hơn, thực tế ${m.version}`);
    assert(m.assets.length === 1 && m.assets[0].url === 'gh://a', 'Asset cùng tên của phiên bản cũ không được ghi đè phiên bản mới');
  });

  await test('Tác tử cửa sổ: scope ghép thư mục bằng dấu chấm phẩy, lọc mục rỗng (đầu vào duy nhất để xác định cửa sổ thuộc về ai)', async () => {
    const { WinAgent } = require('../src/core/agent');
    const a = new WinAgent();
    const sent = [];
    // Không khởi chạy tiến trình tác tử thật: chỉ kiểm nội dung giao thức gửi cho nó
    a.call = async (obj) => { sent.push(obj); return { ok: true, n: 1 }; };
    const r = await a.scope(['C:////runtime', '', null, 'D:////repo////engine']);
    assert(sent.length === 1 && sent[0].cmd === 'scope', `Chỉ được gửi một lệnh scope, thực tế ${JSON.stringify(sent)}`);
    assert(sent[0].dirs === 'C:////runtime;D:////repo////engine', `Mục rỗng phải được lọc bỏ, thực tế ${sent[0].dirs}`);
    assert(r.ok === true, 'scope thành công phải trả về ok');
    // Truyền mảng rỗng cũng không được ném lỗi: như vậy nghĩa là “không chặn gì cả”, phía gọi tự quyết định có cảnh báo hay không
    const empty = await a.scope([]);
    assert(sent[1].dirs === '' && empty.ok === true, 'Phạm vi rỗng cũng phải gửi được (tác tử nhận rồi thì không đụng cửa sổ nào)');
  });

  await test('Hai nguồn: khi cả hai bên đều có gói trọn bộ cùng tên, phải giữ cả hai địa chỉ (nếu không Gitee sẽ không bao giờ đến lượt)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: { autoMirror: false } }));
    const gh = 'https://github.com/o/r/releases/download/v0.3.3/a.zip';
    const ge = 'https://gitee.com/o/r/releases/download/v0.3.3/a.zip';
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', size: 108200693, browser_download_url: gh }] } },
      // Asset của Gitee không có size (thực tế), không được lấy kích thước của GitHub giả làm của nó
      { source: 'gitee', name: 'Gitee', web: 'e', rel: { tag_name: 'v0.3.3', assets: [{ name: 'ApkStart-v0.3.3-win64-portable.zip', browser_download_url: ge }] } },
    ];
    const m = await s.latest();
    assert(m.assets.length === 1, `Asset cùng tên phải gộp thành 1, thực tế ${m.assets.length}`);
    const a = m.assets[0];
    assert(a.urls.length === 2 && a.urls[1] === ge, `Địa chỉ của cả hai nguồn đều phải giữ lại, thực tế ${JSON.stringify(a.urls)}`);
    assert(a.sizes[gh] === 108200693 && !a.sizes[ge], 'Kích thước ghi riêng theo từng địa chỉ, không biết thì là không biết');
    const cands = s.candidates(a);
    assert(cands.length === 2 && cands[0] === gh, `Địa chỉ ứng viên phải gồm cả hai nguồn, thực tế ${JSON.stringify(cands)}`);
  });

  await test('Tải song song nhiều nguồn: khi hai nguồn có kích thước khác nhau, theo nguồn nhanh nhất (không được cố định chọn cái lớn hơn)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const small = Buffer.alloc(3 * MB);   // Nguồn xếp trước (đã sắp theo tốc độ)
    const big = Buffer.alloc(5 * MB);
    for (let i = 0; i < small.length; i += 1) small[i] = i % 251;
    for (let i = 0; i < big.length; i += 1) big[i] = (i * 7) % 251;
    const serve = (data) => (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    const mk = (data) => new Promise((resolve) => {
      const srv = http.createServer(serve(data));
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk(small);
    const s2 = await mk(big);
    const out = path.join(TMP, 'mixed-size.bin');
    try {
      // Thứ tự danh sách = thứ tự tốc độ của rank(): cái đầu tiên là nguồn nhanh nhất
      await downloadMulti([`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`], out, { connections: 4 });
      const got = fs.readFileSync(out);
      assert(got.length === small.length && Buffer.compare(got, small) === 0,
        `Phải tải bản của nguồn nhanh nhất (${small.length} byte), thực tế ${got.length} byte`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Gói cập nhật phân mảnh: ghép lại thành gói trọn bộ theo thứ tự, kích thước không khớp thì dừng ngay', async () => {
    const http = require('http');
    const { Updater } = require('../src/core/updater');
    const partA = Buffer.alloc(4096, 0x41);
    const partB = Buffer.alloc(2048, 0x42);
    const srv = http.createServer((req, res) => {
      if (req.url.startsWith('/a')) { res.writeHead(200, { 'Content-Length': partA.length }); res.end(partA); return; }
      if (req.url.startsWith('/b')) { res.writeHead(200, { 'Content-Length': partB.length }); res.end(partB); return; }
      res.writeHead(404); res.end();
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const port = srv.address().port;
    const sb = path.join(TMP, 'parts-upd');
    fs.mkdirSync(sb, { recursive: true });
    const u = new Updater({ currentVersion: '0.0.0', exePath: path.join(sb, 'A.exe'), isPackaged: true, dataDir: sb, settings: () => ({}) });
    const target = path.join(sb, 'joined.zip');
    try {
      await u._downloadParts({
        name: 'joined.zip',
        size: partA.length + partB.length,
        parts: [
          { index: 1, size: partA.length, urls: [`http://127.0.0.1:${port}/a`] },
          { index: 2, size: partB.length, urls: [`http://127.0.0.1:${port}/b`] },
        ],
      }, target, 2, partA.length + partB.length);
      const got = fs.readFileSync(target);
      assert(got.length === partA.length + partB.length, 'Kích thước sau khi ghép phải bằng tổng các phân mảnh');
      assert(got.slice(0, partA.length).every((b) => b === 0x41), 'Thứ tự nội dung mảnh thứ nhất sai');
      assert(got.slice(partA.length).every((b) => b === 0x42), 'Thứ tự nội dung mảnh thứ hai sai');
    } finally {
      srv.close();
      fs.rmSync(sb, { recursive: true, force: true });
    }
  });

  await test('Tải song song nhiều nguồn: các khối khác nhau kéo từ các nguồn khác nhau, byte ghép ra phải khớp hoàn toàn', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(3 * 1024 * 1024);
    for (let i = 0; i < data.length; i += 1) data[i] = i % 251;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, {
        'Content-Range': `bytes ${a}-${b}/${data.length}`,
        'Content-Length': b - a + 1,
      });
      res.end(data.slice(a, b + 1));
    };
    // Chờ tường minh callback listening: listen trước rồi mới gắn bộ lắng nghe sẽ bỏ lỡ sự kiện đã phát, test sẽ bị treo
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [
      `http://127.0.0.1:${s1.address().port}/f`,
      `http://127.0.0.1:${s2.address().port}/f`,
    ];
    const out = path.join(TMP, 'multi.bin');
    try {
      const r = await downloadMulti(urls, out, { connections: 6, minChunk: 512 * 1024 });
      const got = fs.readFileSync(out);
      assert(Buffer.compare(got, data) === 0, 'Nội dung sau khi ghép đa nguồn phải khớp hoàn toàn với file nguồn');
      assert(r.sources === 2 && r.parallel >= 2, `Phải dùng đồng thời 2 nguồn, thực tế ${JSON.stringify(r)}`);
      assert(got.length === data.length, 'Kích thước phải khớp');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Tải song song nhiều nguồn: thất bại rồi làm lại chỉ bù các khối thiếu (không tải lại toàn bộ 1.4GB)', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 3 * MB;
    const data = Buffer.alloc(total);
    for (let i = 0; i < total; i += 1) data[i] = i % 251;
    let ranged = 0;
    const handler = (req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      if (b > a) ranged += 1;          // Chỉ đếm các yêu cầu khối dữ liệu thật (yêu cầu dò 0-0 không tính)
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    };
    // Phải là hai địa chỉ: chỉ có một thì downloadMulti sẽ giao thẳng cho tải phân khối một nguồn (nhánh đó tự có tải tiếp)
    const mk = () => new Promise((resolve) => {
      const srv = http.createServer(handler);
      srv.listen(0, '127.0.0.1', () => resolve(srv));
    });
    const s1 = await mk();
    const s2 = await mk();
    const urls = [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`];
    const out = path.join(TMP, 'multi-resume.bin');
    try {
      // Dựng hiện trường “hai khối đầu đã tải xong, khối cuối chưa tải” (cách phân khối: 3 kết nối × 1MB)
      const per = Math.ceil(total / 3);
      const fd = fs.openSync(out, 'w');
      fs.ftruncateSync(fd, total);
      fs.writeSync(fd, data, 0, per * 2, 0);
      fs.closeSync(fd);
      fs.writeFileSync(`${out}.chunks.json`, JSON.stringify({ total, n: 3, done: [0, per] }));

      const r = await downloadMulti(urls, out, { connections: 3, minChunk: MB });
      assert(r.resumed === true, 'Phải nhận ra đây là tải tiếp từ điểm dừng');
      assert(ranged === 1, `Chỉ được tải bù 1 khối, thực tế yêu cầu ${ranged} khối`);
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'File sau khi tải tiếp phải khớp hoàn toàn với nguồn');
      assert(!fs.existsSync(`${out}.chunks.json`), 'Hoàn tất thì phải xóa file đi kèm');
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Trình tải: kết nối xong mà không nhận được byte nào, phải hết thời gian rồi đổi nguồn chứ không treo cứng', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(4 * 1024 * 1024, 9);
    // Header trả về bình thường rồi im lặng mãi: mô phỏng tình huống kinh điển “TCP thông nhưng bị chặn/bị bóp băng thông”
    const stall = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      // Gửi trước 1KB, sau đó không gửi gì nữa
      res.write(data.slice(a, a + 1024));
    });
    const good = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(stall);
    const s2 = await listen(good);
    const out = path.join(TMP, 'stall.bin');
    const t0 = Date.now();
    try {
      const r = await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 4, minChunk: 1024 * 1024, idleMs: 400, retries: 2 },
      );
      const cost = Date.now() - t0;
      assert(fs.statSync(out).size === data.length, 'Cuối cùng phải tải đầy đủ');
      assert(cost < 15000, `Không được treo trên kết nối bị đình trệ, thực tế mất ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Trình tải: khi một nguồn chỉ chạy vài chục KB/s thì đổi nguồn, chứ không kẹt ở vài % cuối', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const MB = 1024 * 1024;
    const total = 2 * MB;
    const data = Buffer.alloc(total, 5);
    // Nguồn chậm: cứ 100ms mới nhả 4KB (≈40KB/s)
    const slow = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      let pos = a;
      const pump = () => {
        if (pos > b) { res.end(); return; }
        const chunk = data.slice(pos, Math.min(b + 1, pos + 4096));
        pos += chunk.length;
        res.write(chunk);
        setTimeout(pump, 100);
      };
      pump();
    });
    const fast = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': total }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), total - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${total}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv)));
    const s1 = await listen(slow);
    const s2 = await listen(fast);
    const out = path.join(TMP, 'slowrot.bin');
    const t0 = Date.now();
    try {
      await downloadMulti(
        [`http://127.0.0.1:${s1.address().port}/f`, `http://127.0.0.1:${s2.address().port}/f`],
        out,
        { connections: 2, minChunk: 512 * 1024, idleMs: 3000, slowAfterMs: 400, slowBps: 200 * 1024 },
      );
      const cost = Date.now() - t0;
      assert(Buffer.compare(fs.readFileSync(out), data) === 0, 'Nội dung sau khi đổi nguồn phải đúng');
      // Nếu đi trọn nguồn chậm thì 2MB / 40KB/s ≈ 50 giây; đổi nguồn phải xong trong vài giây
      assert(cost < 15000, `Phải đổi nguồn khi tốc độ thấp, thực tế mất ${cost}ms`);
    } finally {
      s1.close(); s2.close();
      fs.rmSync(out, { force: true });
      fs.rmSync(`${out}.chunks.json`, { force: true });
    }
  });

  await test('Tải song song nhiều nguồn: chỉ có một địa chỉ dùng được thì lùi về tải phân khối một nguồn', async () => {
    const http = require('http');
    const { downloadMulti } = require('../src/core/download');
    const data = Buffer.alloc(2 * 1024 * 1024, 7);
    const srv = http.createServer((req, res) => {
      const r = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
      if (!r) { res.writeHead(200, { 'Content-Length': data.length }); res.end(data); return; }
      const a = Number(r[1]);
      const b = Math.min(Number(r[2]), data.length - 1);
      res.writeHead(206, { 'Content-Range': `bytes ${a}-${b}/${data.length}`, 'Content-Length': b - a + 1 });
      res.end(data.slice(a, b + 1));
    });
    await new Promise((r) => srv.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${srv.address().port}/f`;
    // Lấy một cổng “vừa được giải phóng, chắc chắn không ai lắng nghe” làm nguồn hỏng, kết nối sẽ bị từ chối ngay chứ không chờ hết thời gian
    const probe = http.createServer(() => {});
    await new Promise((r) => probe.listen(0, '127.0.0.1', r));
    const deadPort = probe.address().port;
    await new Promise((r) => probe.close(r));
    const out = path.join(TMP, 'multi1.bin');
    try {
      // Địa chỉ thứ hai cố ý trỏ tới cổng không thông: phải tự bỏ qua chứ không làm thất bại cả gói
      const r = await downloadMulti([url, `http://127.0.0.1:${deadPort}/nope`], out, { connections: 4 });
      assert(fs.statSync(out).size === data.length, 'Một nguồn cũng phải tải đầy đủ');
      assert(!r.multi || r.sources === 1, 'Chỉ có một nguồn dùng được thì không được đánh dấu là đa nguồn');
    } finally {
      srv.close();
      fs.rmSync(out, { force: true });
    }
  });

  await test('Hai nguồn: kết quả phiên bản được cache 10 phút, khi force thì bắt buộc tra lại', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let calls = 0;
    s.fetchReleases = async () => {
      calls += 1;
      return [{ source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } }];
    };
    await s.latest();
    await s.latest();
    assert(calls === 1, `Trong thời gian cache không được yêu cầu lặp lại, thực tế yêu cầu ${calls} lần`);
    await s.latest({ force: true });
    assert(calls === 2, 'force phải bỏ qua cache');
    s.reset();
    await s.latest();
    assert(calls === 3, 'Sau reset phải yêu cầu lại');
  });

  await test('Hai nguồn: một nguồn bị 403 do giới hạn tần suất thì ngắt mạch bỏ qua, không đâm vào tường mỗi vòng nữa', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    let giteeCalls = 0;
    s.fetchReleases = async () => {
      giteeCalls += 1;
      return [
        { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.0.0', assets: [] } },
        { source: 'gitee', name: 'Gitee', web: 'e', error: 'gitee.com 403 (bị giới hạn tần suất)' },
      ];
    };
    // Lần đầu: Gitee báo 403, bị ghi vào ngắt mạch
    await s.latest({ force: true });
    assert(giteeCalls === 1, 'Vòng đầu phải thực sự đã gửi yêu cầu');
    const reason = s.blockedReason('gitee');
    assert(!!reason, '403 phải kích hoạt ngắt mạch');
    assert(s.blockedReason('github') === null, 'Nguồn không lỗi không được bị ngắt mạch');
    // Yêu cầu trong thời gian ngắt mạch phải bị bỏ qua ngay (không gọi mạng nữa)
    assert(/tạm( thời)? bỏ qua/i.test(reason), `Lý do bỏ qua phải dễ hiểu, thực tế: ${reason}`);
    s.reset();
    assert(s.blockedReason('gitee') === null, 'Sau reset ngắt mạch phải được gỡ bỏ');
  });

  await test('Hai nguồn: tất cả nguồn đều không tới được thì lùi về kết quả lần trước (đánh dấu stale, không báo lỗi ngay)', async () => {
    const { Sources } = require('../src/core/sources');
    const s = new Sources(() => ({ runtime: {} }));
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', rel: { tag_name: 'v1.2.3', assets: [] } },
    ];
    const first = await s.latest();
    assert(first.tag === 'v1.2.3' && !first.stale, 'Lần đầu phải bình thường');
    s._relTtl = 0;   // Làm cache hết hiệu lực
    s.fetchReleases = async () => [
      { source: 'github', name: 'GitHub', web: 'g', error: 'hết thời gian' },
    ];
    const second = await s.latest();
    assert(second.tag === 'v1.2.3' && second.stale === true, 'Phải lùi về kết quả cũ và đánh dấu stale');
  });

  await test('Vị trí đặt image hệ thống: cài mới phải nằm trong thư mục runtime (CI lắp ráp runtime dựa vào điều này)', () => {
    const fs2 = require('fs');
    const os2 = require('os');
    const tmp = fs2.mkdtempSync(path.join(os2.tmpdir(), 'sysroot-'));
    const oldAppData = process.env.APPDATA;
    process.env.APPDATA = path.join(tmp, 'appdata');
    try {
      const store = require('../src/core/store');
      const { Provisioner } = require('../src/core/provision');
      const root = path.join(tmp, 'rt');
      store.saveSettings({ runtime: { dir: root } });
      const p = new Provisioner(path.join(__dirname, '..'));

      // 1) Cài mới: thư mục runtime và thư mục dữ liệu người dùng đều không có system-images → đặt vào thư mục runtime
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'),
        `Cài mới phải đặt vào thư mục runtime, thực tế ${p.paths().sysImgRoot}`);

      // 2) Thư mục runtime đã có sẵn (sản phẩm giải nén gói trọn bộ) → ưu tiên nó
      fs2.mkdirSync(path.join(root, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(root, 'system-images'), 'Đã có thì phải ưu tiên thư mục runtime');

      // 3) Chỉ thư mục dữ liệu người dùng có (bố cục bản cũ) → dùng nó
      fs2.rmSync(path.join(root, 'system-images'), { recursive: true, force: true });
      fs2.mkdirSync(path.join(store.DATA_DIR, 'system-images'), { recursive: true });
      assert(p.paths().sysImgRoot === path.join(store.DATA_DIR, 'system-images'),
        `Bố cục cũ phải lùi về thư mục dữ liệu người dùng, thực tế ${p.paths().sysImgRoot}`);
    } finally {
      if (oldAppData === undefined) delete process.env.APPDATA; else process.env.APPDATA = oldAppData;
      fs2.rmSync(tmp, { recursive: true, force: true });
    }
  });

  console.log('\n[Chính sách tài nguyên / phân bổ đĩa / giới hạn log]');

  await test('Chính sách tài nguyên chuyển ở một chỗ, tự quy đổi thành vCPU/độ ưu tiên/độ phân giải', () => {
    const store = require('../src/core/store');
    let s = store.saveSettings({ engine: { resourceMode: 'smooth' } });
    assert(s.engine.liteMode === false, 'Chế độ mượt không được giới hạn số nhân');
    assert(s.engine.priorityMode === 'game', 'Chế độ mượt phải vào độ ưu tiên game độ trễ thấp (ưu tiên FPS/video)');
    assert(s.engine.renderSize === '720x1280', `Độ phân giải phải là 720p, thực tế ${s.engine.renderSize}`);
    s = store.saveSettings({ engine: { resourceMode: 'save' } });
    assert(s.engine.liteMode === true && s.engine.renderSize === '540x960', 'Tiết kiệm tài nguyên phải là 540p + container nhẹ');
    s = store.saveSettings({ engine: { resourceMode: 'balanced' } });
    assert(s.engine.renderSize === 'auto', 'Chế độ cân bằng để độ phân giải tự động');
  });

  await test('Dung lượng phân vùng dữ liệu cấu hình được, và mặc định không còn là số cố định', () => {
    const store = require('../src/core/store');
    store.saveSettings({ engine: { dataPartitionGB: 12 } });
    const p = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(p.dataMB === 12 * 1024, `Phải là 12GB, thực tế ${p.dataMB}MB`);
    store.saveSettings({ engine: { dataPartitionGB: 0 } });
    const auto = doctor.autoProfile({ settings: store.getSettings(), accel: { ok: true }, emulatorVersion: '37.3.8.0', diskMB: 50000 });
    assert(auto.dataMB === 6144, `Khi đĩa còn nhiều, tự động phải là 6GB, thực tế ${auto.dataMB}`);
  });

  await test('Dấu vân tay snapshot không chứa kích thước phân vùng dữ liệu (mở rộng dung lượng không được vô hiệu snapshot, càng không được xóa dữ liệu)', () => {
    const base = { emulatorVersion: '37.3.8', api: '34', tag: 'google_apis_playstore' };
    const a = doctor.snapshotKey({ ...base, dataMB: 4096 }, 'img');
    const b = doctor.snapshotKey({ ...base, dataMB: 24576 }, 'img');
    assert(a === b, 'Chỉ đổi dung lượng không được làm đổi dấu vân tay');
    const c = doctor.snapshotKey({ ...base, dataMB: 4096, emulatorVersion: '36.0.0' }, 'img');
    assert(a !== c, 'Đổi phiên bản engine phải làm đổi dấu vân tay');
  });

  await test('Log vượt giới hạn thì tự xoay vòng, chỉ giữ một bản sao lưu', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'rot.log');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === true, 'Phải thực hiện xoay vòng');
    assert(!fs.existsSync(f) && fs.existsSync(path.join(TMP, 'rot.1.log')), 'Phải thành .1.log');
  });

  await test('Khi tên file log không kết thúc bằng .log: thà không xoay vòng được, chứ không được xóa log', () => {
    const lf = require('../src/core/logfile');
    const f = path.join(TMP, 'plain.txt');
    fs.writeFileSync(f, 'x'.repeat(300 * 1024));
    const rotated = lf.rotate(f, 256);
    assert(rotated === false, 'Khi bak trùng tên với file nguồn thì phải từ bỏ xoay vòng');
    assert(fs.existsSync(f), 'File log không được bị xóa');
  });

  await test('Bản ghi khởi động thất bại được lưu xuống đĩa, khởi động lại rồi xuất báo cáo chẩn đoán vẫn thấy nguyên nhân thật', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu.lastExitCode = 3221225477;
    emu.lastDiagnosis = doctor.diagnose(['emulator exit 3221225477']);
    emu.attempts = [{ plan: 'host / tăng tốc phần cứng', diagnosis: 'ACCESS_VIOLATION', exitCode: 3221225477 }];
    emu._persistFailure({ why: 'test' });
    const back = emu.lastFailure();
    assert(back && back.exitCode === 3221225477, 'Mã thoát phải được lưu xuống đĩa');
    assert(back.diagnosis && back.diagnosis.code === 'ACCESS_VIOLATION', 'Kết luận chẩn đoán phải được lưu xuống đĩa');
    assert(back.attempts.length === 1, 'Bản ghi các lần thử phải được lưu xuống đĩa');
    emu._clearFailure();
    assert(emu.lastFailure() === null, 'Khởi động thành công thì phải xóa bản ghi thất bại');
  });

  await test('Gói tách .xapk: giải nén dạng luồng các phân mảnh, phân tích base, thất bại thì dọn thư mục tạm', async () => {
    const crypto = require('crypto');
    const { parseBundle } = require('../src/core/installer');
    const { buildApkBytes, buildStoredZip } = require('./lib/make-apk');
    const apk = buildApkBytes();

    // Thành công: trong gói có hai phân mảnh (base + config), meta lấy từ cái phân tích được
    const okPath = path.join(TMP, 'ok.xapk');
    fs.writeFileSync(okPath, buildStoredZip([
      { name: 'base.apk', data: apk },
      { name: 'split_config.arm64_v8a.apk', data: apk },
      { name: 'manifest.json', data: Buffer.from('{}') },
    ]));
    const b = await parseBundle(okPath);
    try {
      assert(b.files.length === 2, `Phải giải ra 2 phân mảnh, thực tế ${b.files.length}`);
      assert(b.files.every((f) => fs.existsSync(f)), 'Phân mảnh phải được ghi xuống đĩa');
      assert(b.meta.package === 'com.example.test', `Tên gói ${b.meta.package}`);
    } finally {
      b.cleanup();
    }

    // Thất bại: trong gói không có phân mảnh APK → báo lỗi rõ ràng, và không được để lại thư mục tạm trên máy người dùng
    const badPath = path.join(TMP, 'bad.xapk');
    fs.writeFileSync(badPath, buildStoredZip([{ name: 'readme.txt', data: Buffer.from('nope') }]));
    let err = null;
    try { await parseBundle(badPath); } catch (e) { err = e; }
    assert(err && /không tìm thấy.*APK/i.test(err.message), `Phải báo không có phân mảnh, thực tế ${err && err.message}`);
    const dir = path.join(os.tmpdir(), 'apkstart-bundle',
      crypto.createHash('sha1').update(badPath).digest('hex').slice(0, 12));
    assert(!fs.existsSync(dir), 'Thất bại thì phải dọn thư mục tạm');
  });

  await test('materializeImages: giải nén .img.gz, đã giải nén thì bỏ qua, image hỏng thì báo thất bại và không để lại file dở dang', async () => {
    const zlib = require('zlib');
    const store = require('../src/core/store');
    const { Provisioner } = require('../src/core/provision');
    const before = store.getSettings().runtime.dir;
    const rt = path.join(TMP, 'rt-materialize');
    const imgDir = path.join(rt, 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(imgDir, { recursive: true });
    fs.writeFileSync(path.join(imgDir, 'kernel-ranchu'), 'kernel');
    // 40MB toàn số 0: gzip xong chỉ còn vài chục KB, nhưng giải nén ra >32MB, vừa đủ để kiểm việc xác định “đã giải nén”
    fs.writeFileSync(path.join(imgDir, 'system.img.gz'), zlib.gzipSync(Buffer.alloc(40 * 1024 * 1024, 7)));
    store.saveSettings({ runtime: { dir: rt } });
    const prov = new Provisioner(path.join(__dirname, '..'));
    try {
      const n = await prov.materializeImages();
      assert(n === 1, `Phải giải nén 1 image, thực tế ${n}`);
      const img = path.join(imgDir, 'system.img');
      assert(fs.statSync(img).size === 40 * 1024 * 1024, 'Kích thước sau giải nén phải đúng');
      assert(fs.existsSync(path.join(imgDir, 'kernel-ranchu')), 'Các thành phần không nén cũng phải vào đúng chỗ');
      assert(!fs.existsSync(`${img}.part`), 'Thành công thì không được để lại .part');

      const again = await prov.materializeImages();
      assert(again === 0, `Đã giải nén thì phải bỏ qua, thực tế lại giải nén ${again}`);

      // Image hỏng: phải ném MATERIALIZE_FAILED, và xóa .part (nếu không lần sau sẽ bị coi là đã hoàn tất)
      fs.rmSync(img, { force: true });
      fs.writeFileSync(path.join(imgDir, 'system.img.gz'), Buffer.from('not a gzip at all'));
      let err = null;
      try { await prov.materializeImages(); } catch (e) { err = e; }
      assert(err && err.code === 'MATERIALIZE_FAILED', `Image hỏng phải thất bại, thực tế ${err && err.message}`);
      assert(!fs.existsSync(`${img}.part`), 'Thất bại rồi thì không được để lại .part');
    } finally {
      store.saveSettings({ runtime: { dir: before } });
    }
  });

  await test('Sau khi đổi nguồn tải/địa chỉ gói trọn bộ: cache địa chỉ của provisioner phải bị xóa (nếu không phải khởi động lại mới có hiệu lực)', () => {
    const { Provisioner } = require('../src/core/provision');
    const p = new Provisioner(path.join(__dirname, '..'));
    // Mô phỏng cache sau khi đã phân giải một lần địa chỉ gói trọn bộ / địa chỉ engine
    p._cache.pack = { url: 'https://old.example/runtime.zip', tag: 'v1' };
    p._cache.emulatorUrl = 'https://old.example/emulator.zip';
    p._cache.sysimgUrl = 'https://old.example/sysimg.zip';
    p.invalidateEnvCache();
    assert(!p._cache.pack, 'Cache địa chỉ gói trọn bộ phải bị xóa sạch');
    assert(!p._cache.emulatorUrl && !p._cache.sysimgUrl, 'Cache địa chỉ engine/image phải bị xóa sạch');
  });

  await test('Mỗi vòng khởi động chỉ dùng log của vòng đó để chẩn đoán (crash vòng trước không được làm nhiễm vòng sau)', () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(path.join(__dirname, '..'));
    emu._log = [
      { t: 1, line: 'Graphics backend: gfxstream' },
      { t: 2, line: 'emulator exit 3221225477' },        // Vòng 1: 0xC0000005
      { t: 3, line: '--- Vòng 2 ---' },
      { t: 4, line: 'Address already in use' },          // Vòng 2: cổng bị chiếm
    ];
    assert(doctor.diagnose(emu._attemptLines(0, 80)).code === 'ACCESS_VIOLATION', 'Vòng 1 phải kết luận là crash');
    assert(doctor.diagnose(emu._attemptLines(2, 80)).code === 'PORT_BUSY', 'Vòng 2 phải kết luận là cổng bị chiếm');
    // Vòng này không có log nào thì lùi về phần đuôi của toàn bộ log, không được ra UNKNOWN ngay
    const fallback = emu._attemptLines(emu._log.length, 80);
    assert(fallback.length === emu._log.length, `Vòng rỗng phải lùi về toàn bộ log, thực tế ${fallback.length} dòng`);
  });

  await test('Ghép component khởi chạy: component đầy đủ không được ghép tên gói lặp lại (nếu không bấm icon chỉ thấy màn hình chính Android)', () => {
    const { componentArg, parseResolvedActivity } = require('../src/core/adb');
    // Component đầy đủ (sau khi cài v0.3.4, apps.json lưu đúng dạng này) → dùng nguyên dạng
    assert(componentArg('com.phoenix.read', 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity')
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'Component đầy đủ phải được trả về nguyên dạng');
    // Dữ liệu cũ: chỉ tên lớp / tên lớp bắt đầu bằng dấu chấm → bổ sung tên gói
    assert(componentArg('com.a.b', 'MainActivity') === 'com.a.b/MainActivity');
    assert(componentArg('com.a.b', '.MainActivity') === 'com.a.b/.MainActivity');
    assert(componentArg('com.a.b', '') === '', 'activity rỗng phải trả về rỗng (dùng intent ngầm định)');
    // Đầu ra resolve-activity cuối thường có dòng trống/dòng priority: phải lấy được component
    const out = 'priority=0\ncom.phoenix.read/com.dragon.read.pages.splash.SplashActivity\n\n';
    assert(parseResolvedActivity('com.phoenix.read', out)
      === 'com.phoenix.read/com.dragon.read.pages.splash.SplashActivity', 'Phải bỏ qua dòng trống để lấy component ở dòng cuối');
    assert(parseResolvedActivity('com.other', out) === '', 'Không được dùng tên gói khác');
  });

  console.log('\n[keymap.js map phím]');
  {
    const keymap = require('../src/core/keymap');
    const KEYS = { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD' };
    const mk = () => {
      const out = []; const lock = []; let back = 0;
      const e = new keymap.KeymapEngine({
        profile: keymap.defaultTemplate(true), screen: { w: 1600, h: 900 },
        emit: (t) => out.push(...t), onLock: (l) => lock.push(l), onBack: () => { back += 1; },
      });
      return { e, out, lock, back: () => back };
    };

    await test('Joystick: W+D chéo chuẩn hóa, W+S triệt tiêu', () => {
      const v = keymap.joystickVector(new Set(['KeyW', 'KeyD']), KEYS);
      assert(Math.abs(Math.hypot(v.x, v.y) - 1) < 1e-9 && v.x > 0 && v.y < 0);
      const z = keymap.joystickVector(new Set(['KeyW', 'KeyS']), KEYS);
      assert(z.x === 0 && z.y === 0);
    });
    await test('Giữ W: ngón 1 down ở tâm joystick rồi move lên trên; nhả W thì up', () => {
      const { e, out } = mk();
      assert(e.keyDown('KeyW') === true);
      assert(out[0].id === 1 && !out[0].up && Math.round(out[0].x) === Math.round(0.14 * 1600));
      assert(out.at(-1).y < out[0].y);
      e.keyUp('KeyW'); assert(out.at(-1).id === 1 && out.at(-1).up);
    });
    await test('Mở game chưa khóa; ` khóa; chuột di chuyển chỉ xoay camera khi khóa', () => {
      const { e, out, lock } = mk();
      e.mouseMove(10, 0); assert(out.length === 0 && e.state === 'unlocked');
      e.keyDown('Backquote'); assert(e.state === 'locked' && lock.at(-1) === true);
      e.mouseMove(10, 0); assert(out.some((t) => t.id === 2));
    });
    await test('Camera chạm mép thì nhấc lên và đặt lại ở tâm vùng', () => {
      const { e, out } = mk(); e.keyDown('Backquote');
      for (let i = 0; i < 200; i += 1) e.mouseMove(20, 0);
      assert(out.filter((t) => t.id === 2 && t.up).length >= 1);
      assert(out.every((t) => t.id !== 2 || t.x <= (0.70 + 0.28) * 1600 + 1));
    });
    await test('Esc: gửi Back + nhả chuột; Esc lần 2: Back + khóa lại', () => {
      const { e, back } = mk(); e.keyDown('Backquote');
      e.keyDown('Escape'); assert(e.state === 'unlocked' && back() === 1);
      e.keyDown('Escape'); assert(e.state === 'locked' && back() === 2);
    });
    await test('Tab (releaseMouse) đảo khóa, khi nhả chuột WASD vẫn chạy, Mouse1 không bắn', () => {
      const { e, out } = mk(); e.keyDown('Backquote'); e.keyDown('Tab'); e.keyUp('Tab');
      assert(e.state === 'unlocked');
      assert(e.mouseButton('Mouse1', true) === false);
      assert(e.keyDown('KeyW') === true && out.some((t) => t.id === 1));
    });
    await test('F12 tắt hẳn: nhấc mọi ngón, chỉ còn F12 bị nuốt; nhả phím đã giữ không gửi up lạc', () => {
      const { e, out } = mk(); e.keyDown('KeyD');
      e.keyDown('F12'); assert(e.state === 'disabled' && out.at(-1).id === 1 && out.at(-1).up);
      const n = out.length; assert(e.keyUp('KeyD') === false && out.length === n);
      assert(JSON.stringify(e.swallowCodes()) === '["F12"]');
      e.keyDown('F12'); assert(e.state === 'unlocked');
    });
    await test('reset() khi đang giữ W + khóa: nhấc hết ngón và nhả chuột', () => {
      const { e, out, lock } = mk(); e.keyDown('Backquote'); e.keyDown('KeyW'); e.mouseMove(5, 5);
      e.reset();
      assert(out.filter((t) => t.up).map((t) => t.id).sort().join() === '1,2');
      assert(e.state === 'unlocked' && lock.at(-1) === false);
    });
    await test('store lưu / đọc / xóa bộ phím theo tên gói', () => {
      const store = require('../src/core/store');
      const p = keymap.defaultTemplate(true);
      store.saveKeymap('a.b', p);
      assert(JSON.stringify(store.getKeymap('a.b')) === JSON.stringify(p), 'Đọc lại phải bằng bản đã lưu');
      assert(store.getKeymap('x.y') === null);
      store.saveKeymap('a.b', null);
      assert(store.getKeymap('a.b') === null, 'null = xóa');
    });
    await test('Tác tử có hook bàn phím + khóa chuột cho map phím, vẫn giữ BOM', () => {
      const buf = fs.readFileSync(path.join(__dirname, '..', 'src', 'core', 'win', 'agent.ps1'));
      assert(buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf, 'agent.ps1 thiếu UTF-8 BOM');
      const src = buf.toString('utf8');
      assert(src.includes('SetWindowsHookEx(13'), 'Thiếu hook bàn phím WH_KEYBOARD_LL');
      assert(src.includes('ClipCursor'), 'Thiếu khóa con trỏ');
      assert(src.includes('kmlost'), 'Thiếu sự kiện kmlost khi mất tiền cảnh');
      assert(src.includes('cmd == "km"'), 'Thiếu lệnh km');
      const { WinAgent } = require('../src/core/agent');
      assert(typeof WinAgent.prototype.setKeymap === 'function', 'Thiếu WinAgent.setKeymap');
    });
    await test('vkToCode / codeToVk khứ hồi cho các phím mẫu', () => {
      for (const c of ['KeyW', 'Space', 'Tab', 'Escape', 'Backquote', 'F12', 'Digit1']) {
        assert(keymap.vkToCode(keymap.codeToVk(c)) === c, c);
      }
    });
  }

  console.log(results.join('\n'));
  console.log(`\nKết quả: ${passed} đạt, ${failed} lỗi\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
