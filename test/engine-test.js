'use strict';
/**
 * Kiểm thử engine và chuỗi tự khởi tạo (không phụ thuộc QEMU / adb / Android thật)
 * Phạm vi: trình tải (gồm tải tiếp từ điểm dừng), giải nén ZIP, kiểm tra môi trường, tham số khởi động QEMU, giao thức monitor
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const http = require('http');
const net = require('net');

// Cô lập thư mục dữ liệu test, tránh làm bẩn cấu hình người dùng thật
const TMP = path.join(os.tmpdir(), `apkstart-test-${Date.now()}`);
process.env.APPDATA = TMP;
fs.mkdirSync(path.join(TMP, 'apkstart'), { recursive: true });

let passed = 0;
let failed = 0;
const results = [];

function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed++; results.push(`  ✓ ${name}`); })
    .catch((e) => { failed++; results.push(`  ✗ ${name}\n    ${e.message}`); });
}

function assert(cond, msg) { if (!cond) throw new Error(msg || 'Khẳng định thất bại'); }

(async () => {
  console.log('\n[download.js]');
  const { download, downloadParallel, head, sha256File } = require('../src/core/download');

  // Dịch vụ HTTP cục bộ mô phỏng nguồn tải (có tải tiếp bằng Range)
  const payload = Buffer.alloc(300 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const server = http.createServer((req, res) => {
    if (req.url === '/big.bin') {
      const range = req.headers.range;
      if (range) {
        const start = Number(/bytes=(\d+)-/.exec(range)[1]);
        res.writeHead(206, {
          'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
          'Content-Length': payload.length - start,
        });
        return res.end(payload.subarray(start));
      }
      res.writeHead(200, { 'Content-Length': payload.length });
      return res.end(payload);
    }
    // Hỗ trợ đầy đủ Range start-end (dùng cho test tải phân khối song song)
    if (req.url === '/ranged.bin') {
      server.rangeHits = (server.rangeHits || 0) + 1;
      const range = /^bytes=(\d+)-(\d+)$/.exec(req.headers.range || '');
      if (!range) {
        res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'bytes' });
        return res.end(payload);
      }
      const start = Number(range[1]);
      const end = Math.min(Number(range[2]), payload.length - 1);
      res.writeHead(206, {
        'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${payload.length}`,
        'Content-Length': end - start + 1,
      });
      return res.end(payload.subarray(start, end + 1));
    }
    // Cố ý không hỗ trợ Range
    if (req.url === '/norange.bin') {
      res.writeHead(200, { 'Content-Length': payload.length, 'Accept-Ranges': 'none' });
      return res.end(payload);
    }
    if (req.url === '/redirect') {
      res.writeHead(302, { Location: '/big.bin' });
      return res.end();
    }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  await test('Tải trọn vẹn + đi theo chuyển hướng', async () => {
    const dest = path.join(TMP, 'dl1.bin');
    await download(`http://127.0.0.1:${port}/redirect`, dest);
    assert(fs.statSync(dest).size === payload.length, 'Kích thước không khớp');
  });

  await test('Tải tiếp từ điểm dừng (đã có file dở dang)', async () => {
    const dest = path.join(TMP, 'dl2.bin');
    fs.writeFileSync(dest, payload.subarray(0, 100000));
    let lastPercent = 0;
    await download(`http://127.0.0.1:${port}/big.bin`, dest, {
      onProgress: (p) => { lastPercent = p.percent; },
    });
    assert(fs.statSync(dest).size === payload.length, `Kích thước sau khi tải tiếp ${fs.statSync(dest).size}`);
    assert(fs.readFileSync(dest).equals(payload), 'Nội dung tải tiếp không khớp');
    assert(lastPercent > 50, 'Không báo tiến độ');
  });

  await test('Dò HEAD + SHA256', async () => {
    const h = await head(`http://127.0.0.1:${port}/big.bin`);
    assert(h.size === payload.length, 'Kích thước HEAD không khớp');
    const sum = await sha256File(path.join(TMP, 'dl1.bin'));
    assert(/^[0-9a-f]{64}$/.test(sum), 'Định dạng sha256 bất thường');
  });

  await test('Kiểm tra SHA256 thất bại sẽ dọn file', async () => {
    const dest = path.join(TMP, 'dl3.bin');
    let threw = false;
    try {
      await download(`http://127.0.0.1:${port}/big.bin`, dest, { expectSha256: 'deadbeef'.repeat(8) });
    } catch (_) { threw = true; }
    assert(threw, 'Phải ném lỗi');
    assert(!fs.existsSync(dest), 'Kiểm tra thất bại phải xóa file');
  });

  await test('Tải phân khối song song: nội dung ghép từ nhiều kết nối phải khớp', async () => {
    const dest = path.join(TMP, 'dl4.bin');
    server.rangeHits = 0;
    let maxPercent = 0;
    const r = await downloadParallel(`http://127.0.0.1:${port}/ranged.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
      onProgress: (p) => { maxPercent = Math.max(maxPercent, p.percent); },
    });
    assert(fs.readFileSync(dest).equals(payload), 'Nội dung sau khi ghép phân khối không khớp');
    assert(r.parallel > 1, `Không bật song song: ${r.parallel}`);
    assert(server.rangeHits >= r.parallel, `Số yêu cầu phân khối quá ít: ${server.rangeHits}`);
    assert(maxPercent > 0, 'Không báo tiến độ');
  });

  await test('Nguồn không hỗ trợ Range thì tự lùi về một luồng', async () => {
    const dest = path.join(TMP, 'dl5.bin');
    const r = await downloadParallel(`http://127.0.0.1:${port}/norange.bin`, dest, {
      connections: 8,
      minChunk: 32 * 1024,
    });
    assert(fs.readFileSync(dest).equals(payload), 'Nội dung sau khi lùi về không khớp');
    assert(!r.parallel, 'Không được chạy song song');
  });

  server.close();

  console.log('\n[provision.js]');
  const { Provisioner } = require('../src/core/provision');
  const store = require('../src/core/store');

  await test('Thư mục runtime mặc định nằm trong thư mục dữ liệu', async () => {
    const p = new Provisioner('C:/fake/app');
    assert(p.paths().root.startsWith(store.DATA_DIR), `Đường dẫn bất thường: ${p.paths().root}`);
    assert(p.paths().qemuExe.endsWith('qemu-system-x86_64.exe'), 'Đường dẫn qemu bất thường');
    assert(p.paths().adbExe.endsWith('adb.exe'), 'Đường dẫn adb bất thường');
  });

  await test('Kiểm tra môi trường trống: adb chưa sẵn sàng, cấu trúc thành phần đầy đủ', async () => {
    const p = new Provisioner(path.join(TMP, 'nonexistent'));
    const env = await p.checkEnv();
    assert(env.adb.ok === false, 'adb không được ở trạng thái sẵn sàng');
    // QEMU có thể đã được cài ở cấp hệ thống (vd. winget vào Program Files), khi đó phải được phát hiện
    if (env.qemu.ok) assert(env.qemu.version, 'Khi qemu sẵn sàng phải có số phiên bản');
    assert(env.ready === false, 'Không được ở trạng thái sẵn sàng');
    assert(typeof env.hypervisor.whpx === 'boolean', 'Thiếu thông tin hypervisor');
  });

  await test('Giải nén ZIP tích hợp hoạt động', async () => {
    const { ZipArchive } = require('../src/core/zip');
    // Dựng một zip tối thiểu ở chế độ stored
    const name = Buffer.from('platform-tools/adb.exe');
    const data = Buffer.from('fake-adb-binary');
    const loc = Buffer.alloc(30);
    loc.writeUInt32LE(0x04034b50, 0);
    loc.writeUInt16LE(0, 8);
    loc.writeUInt32LE(data.length, 18);
    loc.writeUInt32LE(data.length, 14);
    loc.writeUInt16LE(name.length, 26);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(name.length, 28);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt32LE(data.length, 20);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(1, 10);
    eocd.writeUInt32LE(46 + name.length, 12);
    eocd.writeUInt32LE(30 + name.length + data.length, 16);
    const zipPath = path.join(TMP, 'pt.zip');
    fs.writeFileSync(zipPath, Buffer.concat([loc, name, data, cen, name, eocd]));

    const out = path.join(TMP, 'unzip');
    const p = new Provisioner(TMP);
    await p.extractZip(zipPath, out);
    assert(fs.readFileSync(path.join(out, 'platform-tools', 'adb.exe')).toString() === 'fake-adb-binary', 'Nội dung giải nén không khớp');
    assert(new ZipArchive(fs.readFileSync(zipPath)).has('platform-tools/adb.exe'), 'Đọc zip bất thường');
  });

  await test('url tương đối trong chỉ mục SDK được bổ sung thành địa chỉ tuyệt đối', async () => {
    const { absUrl, baseOf, SOURCES } = require('../src/core/provision');
    // repository2-3.xml (emulator) tương đối so với gốc kho
    assert(absUrl('emulator-windows_x64-16847572.zip') === `${baseOf(SOURCES.sdkIndex)}emulator-windows_x64-16847572.zip`,
      'Đường dẫn tương đối của emulator chưa được bổ sung');
    // Chỉ mục sys-img tương đối so với sys-img/android/, không được ghép nhầm vào gốc kho
    const sysBase = baseOf(SOURCES.sysImgIndexes[0]);
    assert(sysBase.endsWith('/sys-img/android/'), `Thư mục gốc sys-img bất thường: ${sysBase}`);
    assert(absUrl('x86_64-30_r11.zip', sysBase) === 'https://dl.google.com/android/repository/sys-img/android/x86_64-30_r11.zip',
      'Bổ sung đường dẫn tương đối sys-img bị sai');
    // Địa chỉ tuyệt đối trả về nguyên dạng
    assert(absUrl('https://example.com/a.zip') === 'https://example.com/a.zip', 'Địa chỉ tuyệt đối bị viết lại');
  });

  await test('Địa chỉ emulator / image hệ thống phân giải ra đều là URL tuyệt đối tải được', async () => {
    const p = new Provisioner(TMP);
    const emuUrl = await p.resolveEmulatorUrl();
    const imgUrl = await p.resolveSysimgUrl();
    for (const u of [emuUrl, imgUrl]) {
      assert(/^https?:\/\//i.test(u), `Không phải URL tuyệt đối: ${u}`);
      assert(/\.zip$/i.test(u), `Không phải gói zip: ${u}`);
    }
    assert(/windows_x64/i.test(emuUrl), `Nền tảng của gói emulator không đúng: ${emuUrl}`);
  });

  await test('Cấu hình AVD dùng kiến trúc 64 bit (x86_64 không được bị cắt thành x86)', async () => {
    const { EmulatorEngine } = require('../src/core/emulator');
    const emu = new EmulatorEngine(TMP);
    const r = emu.ensureAvd({ memoryMB: 2048, cores: 2 });
    const cfg = fs.readFileSync(path.join(r.avdDir, 'config.ini'), 'utf8');
    assert(/^hw\.cpu\.arch=x86_64$/m.test(cfg), `hw.cpu.arch phải là x86_64, thực tế: ${cfg.match(/^hw\.cpu\.arch=.*$/m)}`);
    assert(/^abi\.type=x86_64$/m.test(cfg), 'abi.type phải là x86_64');
    assert(/^image\.sysdir\.1=\S*system-images\//m.test(cfg), 'Thiếu image.sysdir.1');
  });

  await test('Dịch nguyên nhân cài đặt thất bại: NO_MATCHING_ABIS đưa ra hướng dẫn dễ hiểu', async () => {
    const { friendlyInstallError } = require('../src/core/adb');
    const out = friendlyInstallError(
      'Performing Streamed Install\nadb.exe: failed to install x.apk: '
      + 'Failure [INSTALL_FAILED_NO_MATCHING_ABIS: Failed to extract native libraries, res=-113]',
    );
    assert(out.includes('thư viện native ARM'), `Phải giải thích vấn đề thư viện native ARM: ${out}`);
    assert(out.includes('INSTALL_FAILED_NO_MATCHING_ABIS'), 'Phải giữ mã lỗi gốc');
    const other = friendlyInstallError('Failure [INSTALL_FAILED_INVALID_APK: x]');
    assert(other.includes('hỏng') || other.includes('không đầy đủ'), `Lỗi không xác định cũng phải dễ đọc: ${other}`);
  });

  await test('Kiểm tra image: phân biệt ISO9660 hợp lệ / hỏng / chưa tải xong', async () => {
    const p = new Provisioner(TMP);
    const mk = (file, size, writeMagic) => {
      const fd = fs.openSync(file, 'w');
      fs.ftruncateSync(fd, size);
      if (writeMagic) {
        fs.writeSync(fd, Buffer.from([1]), 0, 1, 0x8000);
        fs.writeSync(fd, Buffer.from('CD001', 'latin1'), 0, 5, 0x8001);
      }
      fs.closeSync(fd);
      return file;
    };

    const good = mk(path.join(TMP, 'good.iso'), 450 * 1024 * 1024, true);
    const a = p.inspectIso(good);
    assert(a.ok && a.iso9660, `ISO hợp lệ bị xác định là không hợp lệ: ${a.reason}`);

    const broken = mk(path.join(TMP, 'broken.iso'), 450 * 1024 * 1024, false);
    const b = p.inspectIso(broken);
    assert(!b.ok && /ISO9660/.test(b.reason), `Image hỏng không bị chặn: ${JSON.stringify(b)}`);

    const partial = mk(path.join(TMP, 'partial.iso'), 2 * 1024 * 1024, true);
    const c = p.inspectIso(partial);
    assert(!c.ok && /chưa (tải )?(xong|hoàn tất)/i.test(c.reason), `Image chưa tải xong không bị chặn: ${JSON.stringify(c)}`);

    for (const f of [good, broken, partial]) fs.rmSync(f, { force: true });
  });

  await test('Phân tích danh sách stat phía thiết bị (mtime thật, tránh truyền lại vô hạn)', async () => {
    const { parseStatList } = require('../src/core/adb');
    const rows = parseStatList('1794309868|1234|./a.txt\n1794309900|99|./sub/b.png');
    assert(rows && rows.length === 2, `Số lượng phân tích được bất thường: ${JSON.stringify(rows)}`);
    assert(rows[0].rel === 'a.txt' && rows[0].size === 1234, 'Trường ở dòng đầu sai');
    assert(rows[1].rel === 'sub/b.png', 'Đường dẫn tương đối của thư mục con sai');
    assert(rows[1].mtime === 1794309900000, 'mtime chưa được quy đổi sang mili giây');
    assert(parseStatList('ls: /nope: No such file') === null, 'Đầu ra không phải stat phải trả về null để lùi về cách khác');
    assert(Array.isArray(parseStatList('')) && parseStatList('').length === 0, 'Thư mục rỗng phải trả về mảng rỗng');
  });

  console.log('\n[engine.js]');
  const { Runtime } = require('../src/core/engine');

  await test('Tham số khởi động QEMU: chế độ cài đặt gắn ISO và khởi động từ ổ quang', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: true };
    store.saveSettings({
      runtime: { isoPath: 'C:/img/android.iso', diskPath: 'C:/img/disk.qcow2' },
      engine: { memoryMB: 4096, cores: 4 },
    });
    const args = rt.buildArgs({ install: true }).join(' ');
    assert(args.includes('-cdrom C:/img/android.iso'), 'Thiếu -cdrom');
    assert(/order=d/.test(args), 'Phải khởi động từ ổ quang');
    assert(/accel=whpx/.test(args), 'Phải dùng WHPX');
    assert(/-cpu host/.test(args), 'WHPX phải dùng CPU host');
    assert(/hostfwd=tcp:127\.0\.0\.1:5555-:5555/.test(args), 'Thiếu chuyển tiếp cổng adb');
    assert(args.includes('-monitor tcp:127.0.0.1:5556'), 'Thiếu monitor');
    assert(/-m 4096/.test(args), 'Tham số bộ nhớ sai');
  });

  await test('Tham số khởi động QEMU: khởi động bình thường thì boot từ đĩa', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ install: false }).join(' ');
    assert(!args.includes('-cdrom'), 'Không được gắn ISO');
    assert(/order=c/.test(args), 'Phải khởi động từ ổ cứng');
    assert(/accel=tcg/.test(args), 'Không có WHPX thì phải lùi về TCG');
    assert(/-cpu max/.test(args), 'TCG phải dùng CPU max');
    assert(args.includes('if=virtio,format=qcow2'), 'Tham số đĩa sai');
  });

  await test('Chế độ headless ẩn cửa sổ máy ảo', async () => {
    const rt = new Runtime(TMP);
    rt._hv = { whpx: false };
    const args = rt.buildArgs({ headless: true }).join(' ');
    assert(args.includes('-display none'), 'Không được có cửa sổ');
  });

  await test('Giao thức QEMU monitor: bắt tay và gửi lệnh', async () => {
    // Mô phỏng QEMU monitor: kết nối xong trả "(qemu) ", nhận lệnh thì trả ok
    const srv = net.createServer((sock) => {
      sock.write('QEMU 8.2.0 monitor - type \'help\' for more information\r\n(qemu) ');
      sock.on('data', (d) => {
        srv.lastCmd = d.toString().trim();
        sock.write('ok\r\n(qemu) ');
      });
    });
    await new Promise((r) => srv.listen(5556, '127.0.0.1', r));

    const rt = new Runtime(TMP);
    await rt.monitorCmd('system_powerdown');
    assert(srv.lastCmd === 'system_powerdown', `Thực tế nhận được: ${srv.lastCmd}`);
    await new Promise((r) => srv.close(r));
  });

  await test('Chưa cài hệ thống thì ensure trả về needsSetup', async () => {
    store.saveSettings({ runtime: { installed: false }, engine: { mode: 'builtin' } });
    const rt = new Runtime(TMP);
    // Dùng adb giả để isOnline thất bại nhanh
    const r = await rt.ensure({ onLog: () => {} });
    assert(r.ok === false, 'Không được ở trạng thái sẵn sàng');
    assert(['provision', 'install'].includes(r.needsSetup), `needsSetup=${r.needsSetup}`);
  });

  await test('Khởi động trước và click đồng thời thì chỉ khởi chạy runtime một lần (lũy đẳng, không mở máy trùng lặp)', async () => {
    const rt = new Runtime(TMP);
    rt.provisioner.checkEnv = async () => ({ adb: { ok: true }, emulator: { ok: true }, sysimg: { ok: true } });
    rt.emulator.setPriority = async () => 0;
    let calls = 0;
    rt._ensureInner = async () => {
      calls += 1;
      await new Promise((r) => setTimeout(r, 60));
      return { ok: true, engine: 'emulator' };
    };
    // Khởi động trước (tự chạy sau 4 giây kể từ khi mở) và người dùng mở ứng dụng (ensure) sẽ xảy ra cùng lúc
    const [a, b] = await Promise.all([rt.prewarm({}), rt.ensure({})]);
    assert(calls === 1, `Khởi động tầng dưới bị kích hoạt ${calls} lần, chỉ được khởi chạy một máy giả lập`);
    assert(a && a.ok && b && b.ok, 'Cả hai nhánh đều phải nhận được kết quả sẵn sàng');
  });

  await test('Xác định sẵn sàng khởi động: phải chờ tới boot_completed + trình quản lý gói', async () => {
    const rt = new Runtime(TMP);
    const calls = [];
    const fake = {
      isOnline: async () => true,
      connect: async () => true,
      shell: async (cmd) => {
        calls.push(cmd);
        if (cmd.includes('sys.boot_completed')) return '1';
        if (cmd.includes('pm path android')) return 'package:/system/framework/framework-res.apk';
        return '';
      },
    };
    const r = await rt.waitAndroidReady(fake, 5000, () => {});
    assert(r.ok, 'Phải được xác định là đã sẵn sàng');
    assert(calls.some((c) => c.includes('sys.boot_completed')), 'Chưa kiểm tra boot_completed');
    assert(calls.some((c) => c.includes('pm path android')), 'Chưa kiểm tra trình quản lý gói');
  });

  await test('Hệ thống chưa khởi động xong thì trả về giai đoạn (kernel)', async () => {
    const rt = new Runtime(TMP);
    const fake = { isOnline: async () => true, connect: async () => true, shell: async () => '0' };
    const r = await rt.waitAndroidReady(fake, 1200, () => {});
    assert(!r.ok && r.stage === 'kernel', `Phải dừng ở giai đoạn kernel: ${JSON.stringify(r)}`);
  });

  console.log('\n[provision.js image tương thích / bản đầy đủ]');

  await test('playImageInfo kiểm tra tính toàn vẹn của image tương thích API 34', async () => {
    const dir = path.join(TMP, 'apkstart', 'runtime', 'system-images', 'android-34', 'google_apis_playstore', 'x86_64');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'kernel-ranchu'), 'k');
    const prov = new Provisioner(path.join(__dirname, '..'));
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(64));
    assert(!prov.playImageInfo().ok, 'Image quá nhỏ không được xác định là sẵn sàng');
    fs.writeFileSync(path.join(dir, 'system.img'), Buffer.alloc(301 * 1024 * 1024));
    const info = prov.playImageInfo();
    assert(info.ok && info.api === '34' && info.tag === 'google_apis_playstore', `Phải xác định image tương thích API 34 đã sẵn sàng: ${JSON.stringify(info)}`);
  });

  await test('Tài sản thương hiệu bản đầy đủ và lối liên hệ Douyin đã vào chỗ', async () => {
    const root = path.join(__dirname, '..');
    assert(fs.existsSync(path.join(root, 'src', 'ui', 'assets', 'douyin-qr.jpg')), 'Thiếu ảnh mã QR Douyin');
    assert(fs.existsSync(path.join(root, 'build', 'fetch-runtime.js')), 'Thiếu script lắp ráp runtime bản đầy đủ');
    const html = fs.readFileSync(path.join(root, 'src', 'ui', 'index.html'), 'utf8');
    assert(html.includes('douyin-qr.jpg'), 'Mục Giới thiệu chưa tham chiếu mã QR Douyin');
    assert(html.includes('https://v.douyin.com/9TIIxVCANig/'), 'Thiếu liên kết trang chủ Douyin');
  });

  console.log(results.join('\n'));
  console.log(`\nKết quả: ${passed} đạt, ${failed} lỗi\n`);
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
  process.exit(failed ? 1 : 0);
})();
