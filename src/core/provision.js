'use strict';
/**
 * Tự dựng runtime (Provisioning)
 *
 * ApkStart không phụ thuộc trình giả lập bên thứ ba nào: adb, QEMU, system image đều tự tải/kiểm tra/quản lý.
 * Mọi tệp runtime đều nằm trong %APPDATA%\apkstart\runtime, đảm bảo ghi được dù cài ở bất kỳ đâu.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { spawn, execFile } = require('child_process');
const store = require('./store');
const doctor = require('./doctor');
const { download, downloadAny, downloadAnyParallel, downloadMulti, head, discardPartial } = require('./download');
const { ZipArchive, ZipFile } = require('./zip');
const { Sources } = require('./sources');
const { cmpVer } = require('./version');

const IS_WIN = process.platform === 'win32';

const SOURCES = {
  adb: [
    'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
  ],
  qemuIndex: 'https://qemu.weilnetz.de/w64/',
  qemuFallback: [
    'https://qemu.weilnetz.de/w64/qemu-w64-setup-20260811.exe',
  ],
  // Chỉ mục SDK chính thức của Google: địa chỉ thật của emulator và system image được phân giải động từ đây, không ghi cứng phiên bản
  sdkIndex: 'https://dl.google.com/android/repository/repository2-3.xml',
  sysImgIndexes: [
    'https://dl.google.com/android/repository/sys-img/android/sys-img2-3.xml',
    'https://dl.google.com/android/repository/sys-img/google_apis/sys-img2-3.xml',
  ],
  aehdFallback: 'https://dl.google.com/android/repository/aehd-windows_v2.2.zip',
  // Dự phòng: phiên bản đã biết, dùng trực tiếp khi chỉ mục không khả dụng
  emulatorFallback: 'https://dl.google.com/android/repository/emulator-windows_x64-16847572.zip',
  sysimgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Image tương thích ARM (bản Google Play, có sẵn native bridge)
  playImgIndex: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/sys-img2-3.xml',
  playImgFallback: 'https://dl.google.com/android/repository/sys-img/google_apis_playstore/x86_64-34_r14.zip',
  // Android-x86 9.0-r2 (x86_64): chỉ dùng khi người dùng đã tự có ISO
  iso: [
    'https://master.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso?viasf=1',
    'https://nchc.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://phoenixnap.dl.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
    'https://downloads.sourceforge.net/project/android-x86/Release%209.0/android-x86_64-9.0-r2.iso',
  ],
  isoSizeHint: 900 * 1024 * 1024,
  // Bản nhẹ (không kèm runtime) lấy「gói runtime trọn bộ」từ đây: GitHub Release của chính dự án.
  // Trước đây bản nhẹ phải tải riêng emulator / system image từ dl.google.com, mạng trong nước (TQ) thường
  // kẹt ở vài chục KB/s thậm chí 404 luôn; đổi sang gói trọn bộ + GitHub của dự án thì nguồn tải và nguồn cập nhật
  // là cùng một chỗ, có sự cố cũng chỉ cần sửa ở một nơi.
  ghReleaseApi: 'https://api.github.com/repos/RoutineMiku/apkstart/releases',
  ghReleasePage: 'https://github.com/RoutineMiku/apkstart/releases',
  // Mirror Gitee cùng nội dung: ở TQ kết nối thẳng api.github.com thường mất vài chục giây mới phản hồi, Gitee thường vài trăm mili giây.
  // Hỏi cả hai bên, bên nào đưa ra「phiên bản cao nhất có gói runtime trọn bộ」thì dùng bên đó.
  giteeReleaseApi: 'https://gitee.com/api/v5/repos/daily-miku/apkstart/releases',
  giteeReleasePage: 'https://gitee.com/daily-miku/apkstart/releases',
};

/**
 * <url> trong chỉ mục SDK là đường dẫn tương đối, thư mục gốc mỗi nơi một khác:
 *   repository2-3.xml      → https://dl.google.com/android/repository/
 *   sys-img/android/*.xml  → https://dl.google.com/android/repository/sys-img/android/
 * Vì vậy thư mục gốc luôn lấy「thư mục chứa chính tệp chỉ mục」. Trước đây lấy thẳng tên tệp làm URL sẽ ném Invalid URL.
 */
const REPO_BASE = 'https://dl.google.com/android/repository/';

function baseOf(indexUrl) {
  const s = String(indexUrl || '');
  const i = s.lastIndexOf('/');
  return i > 0 ? s.slice(0, i + 1) : REPO_BASE;
}

function absUrl(u, base = REPO_BASE) {
  const s = String(u || '').trim();
  if (!s) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(s)) return s;
  return base + s.replace(/^\/+/, '');
}

/**
 * Chỉ giữ một bản「image nền dùng chung」.
 * Bản cũ mặc định AOSP API30 + image tương thích Play API34 tùy chọn, dẫn đến:
 *   - người dùng cài ứng dụng ARM của TQ chắc chắn thất bại, còn phải tự chuyển image (rào cản thực tế);
 *   - hai image mỗi cái 0.6~3GB, thư mục runtime dễ lên mười mấy GB;
 *   - chuyển image phải wipe-data, mất sạch ứng dụng đã cài.
 * Giờ thống nhất là Android 14 Google Play x86_64: ứng dụng x86, ứng dụng ARM, GMS đều chạy được,
 * cả máy chỉ lưu một lớp nền chỉ đọc (chia sẻ kiểu container), tải một lần khi cần là xong.
 */
const PLAY_SYSIMG = { api: '34', tag: 'google_apis_playstore', abi: 'x86_64' };
const DEFAULT_SYSIMG = PLAY_SYSIMG;

const MIN_SIZE = {
  adb: 5 * 1024 * 1024,
  qemu: 60 * 1024 * 1024,
  iso: 400 * 1024 * 1024,
  disk: 1024 * 1024,
  emulator: 200 * 1024 * 1024,
  sysimg: 300 * 1024 * 1024,
  aeHD: 64 * 1024,
};

function run(cmd, args, { timeout = 60000, cwd, windowsHide = true } = {}) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout, cwd, windowsHide, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, code: err ? (err.code ?? 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || ''), error: err });
    });
  });
}

function fileSize(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

/**
 * Kiểm tra tính toàn vẹn sau khi tải. Không đạt thì **xóa tệp không đầy đủ này**.
 *
 * Trước đây chỗ này chỉ ném lỗi, không xóa tệp, nên trong tmp luôn còn một tệp zip dở dang. Lần sau vào
 * download() thấy đã có tệp thì tải tiếp bằng Range —— nếu máy chủ/nguồn đã đổi, các byte tải tiếp
 * không khớp với nửa đầu, lại lỗi, lại để dở…… người dùng thấy là「cứ tải đi tải lại mãi」.
 */
function assertComplete(file, minBytes, label) {
  const size = fileSize(file);
  if (size >= minBytes) return size;
  discardPartial(file);
  throw new Error(`${label} tải về không đầy đủ (${(size / 1048576).toFixed(1)} MB), đã dọn dẹp, hãy thử lại`);
}

/**
 * Cache trên đĩa cho kết quả dò môi trường.
 *
 * `emulator -version` và `emulator -accel-check` mỗi lần đều phải khởi một tiến trình emulator mới,
 * trên Windows đo được 1~3 giây; mà hai mục này khi「engine/driver không đổi」thì kết quả cố định.
 * Trước đây chỉ cache trong bộ nhớ 30 giây, tức mỗi lần khởi động nguội lại trả giá lại từ đầu, và vài giây này rơi đúng
 * vào lúc người dùng bấm mở ứng dụng. Ở đây lấy「kích thước + thời gian sửa exe + thời gian driver AEHD + thành phần WHPX」
 * làm vân tay và lưu vào %APPDATA%, phần mềm/phần cứng đổi là tự mất hiệu lực.
 */
const ENV_CACHE_TTL = 6 * 60 * 60 * 1000;
const ENV_CACHE_NEG_TTL = 10 * 60 * 1000; // tăng tốc「không khả dụng」chỉ tin 10 phút: người dùng có thể vừa bật ảo hóa

function envCacheFile() {
  return path.join(store.DATA_DIR, 'cache', 'env.json');
}

function statKey(p) {
  try {
    const s = fs.statSync(p);
    return `${s.size}:${Math.round(s.mtimeMs)}`;
  } catch (_) { return ''; }
}

class Provisioner {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this._hypervisor = null;
    this._cache = { adbVersion: '', qemuVersion: '' };
    this._sources = new Sources(() => store.getSettings());
  }

  /** Lối vào chung cho hai nguồn/mirror (cache đo tốc độ cũng ở đây, các thành phần dùng chung một bản) */
  get sources() {
    return this._sources;
  }

  /** Vân tay cache: tệp engine hoặc driver tăng tốc đổi bất kỳ cái nào là đổi key */
  _envKey(exe) {
    const aehd = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    return [
      String(exe || '').replace(/\\/g, '/').toLowerCase(),
      statKey(exe),
      statKey(aehd),
      fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll') ? '1' : '0',
    ].join('|');
  }

  envCacheGet(exe) {
    try {
      const j = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8'));
      if (!j || j.key !== this._envKey(exe)) return null;
      return j;
    } catch (_) { return null; }
  }

  envCacheSet(exe, patch) {
    try {
      const key = this._envKey(exe);
      let cur = {};
      try { cur = JSON.parse(fs.readFileSync(envCacheFile(), 'utf8')) || {}; } catch (_) { /* lần đầu */ }
      const base = cur.key === key ? cur : { key, version: null, accel: null, accelAt: 0 };
      const next = { ...base, ...patch, key, at: Date.now() };
      fs.mkdirSync(path.dirname(envCacheFile()), { recursive: true });
      fs.writeFileSync(envCacheFile(), JSON.stringify(next));
    } catch (_) { /* không ghi được cache cũng không ảnh hưởng luồng chính */ }
  }

  /** Gọi khi khởi động lỗi (vấn đề tăng tốc/image): lần sau khởi động dò lại, tránh dùng mãi kết luận sai */
  invalidateEnvCache() {
    this._cache = { adbVersion: '', qemuVersion: '' };
    try { fs.rmSync(envCacheFile(), { force: true }); } catch (_) { /* ignore */ }
  }

  // ---------------- Đường dẫn ----------------

  get root() {
    const r = store.getSettings().runtime.dir;
    return r && r.trim() ? r : path.join(store.DATA_DIR, 'runtime');
  }

  paths() {
    const root = this.root;
    const sysTag = DEFAULT_SYSIMG.tag;
    const sysApi = DEFAULT_SYSIMG.api;
    const sysAbi = DEFAULT_SYSIMG.abi;
    // AVD (gồm dữ liệu người dùng, ứng dụng đã cài, snapshot quickboot) bắt buộc nằm ở chỗ ghi được và không bị dọn.
    // Runtime của bản phát hành một tệp được giải nén theo gói vào thư mục tạm, đặt AVD vào đó tức mỗi lần thoát là mất ứng dụng.
    // Chỉ cần thư mục runtime không nằm trong %APPDATA% thì cố định AVD trỏ về thư mục dữ liệu người dùng.
    // Ngoài ra: cho phép chỉ định riêng「thư mục dữ liệu Android」trong cài đặt —— nó mới là thứ thật sự ngốn ổ
    // (phân vùng dữ liệu 6~24GB + snapshot 2~3GB), chỉ chuyển runtime mà không chuyển nó thì ổ C vẫn đầy.
    const explicitAvd = String(store.getSettings().runtime.avdDir || '').trim();
    const writable = explicitAvd || path.join(store.DATA_DIR, 'avd');
    const insideData = root.toLowerCase().startsWith(store.DATA_DIR.toLowerCase());
    // Đặt system image ở đâu: **ưu tiên thư mục runtime**.
    // Thứ tự trước đây là「ưu tiên thư mục dữ liệu người dùng」, hậu quả là —— người dùng đổi thư mục runtime sang ổ D để tiết kiệm ổ C,
    // gói trọn bộ 1.4GB giải nén ra ổ D xong, materializeImages lại bung system.img 3.3GB ngược về
    // C://Users//...//AppData//Roaming//apkstart//system-images, ổ C vẫn bị ngốn, mà
    // cùng một bộ image lưu hai nơi mỗi nơi một bản (đo thực tế 1.2GB + 3.3GB cùng tồn tại).
    // Giờ: thư mục runtime đã có system-images (sản phẩm giải nén gói trọn bộ) thì dùng nó;
    // không có mới lùi về thư mục dữ liệu người dùng (bản cũ, bản phát hành một tệp đều có bố cục này).
    const rootImg = path.join(root, 'system-images');
    const dataImg = path.join(store.DATA_DIR, 'system-images');
    // Ba trường hợp:
    //  1) Thư mục runtime đã có image (sản phẩm giải nén gói trọn bộ) → dùng của nó;
    //  2) Người dùng cũ/bản phát hành một tệp để image trong thư mục dữ liệu người dùng → dùng ở đó;
    //  3) Cài mới hoàn toàn (cả hai nơi đều không có) → đặt vào thư mục runtime, vì thư mục dữ liệu người dùng có thể là
    //     thư mục tạm đã bị chuyển hướng (CI dựng runtime chính là trường hợp này, ghi lệch là kiểm tra thất bại ngay).
    const sysRoot = fs.existsSync(rootImg) ? rootImg : (fs.existsSync(dataImg) ? dataImg : rootImg);
    return {
      root,
      qemuDir: path.join(root, 'qemu'),
      qemuExe: path.join(root, 'qemu', 'qemu-system-x86_64.exe'),
      qemuImg: path.join(root, 'qemu', 'qemu-img.exe'),
      adbDir: path.join(root, 'platform-tools'),
      adbExe: path.join(root, 'platform-tools', 'adb.exe'),
      // Runtime emulator (chính thức của Google): root đồng thời đóng vai ANDROID_SDK_ROOT
      emulatorDir: path.join(root, 'emulator'),
      emulatorExe: path.join(root, 'emulator', 'emulator.exe'),
      sysImgRoot: sysRoot,
      sysImgDir: path.join(sysRoot, `android-${sysApi}`, sysTag, sysAbi),
      avdHome: insideData ? path.join(root, 'avd') : writable,
      aehdDir: path.join(root, 'aehd'),
      imagesDir: path.join(root, 'images'),
      iso: path.join(root, 'images', 'android-x86.iso'),
      disk: path.join(root, 'images', 'android.qcow2'),
      tmp: path.join(root, '_tmp'),
      sysTag, sysApi, sysAbi,
    };
  }

  ensureDirs() {
    const p = this.paths();
    for (const d of [p.root, p.qemuDir, p.adbDir, p.imagesDir, p.tmp, p.avdHome]) {
      fs.mkdirSync(d, { recursive: true });
    }
    return p;
  }

  /**
   * Bảo vệ ổ đĩa: trước khi tải / giải nén một thành phần dung lượng lớn, xác nhận ổ đích còn đủ chỗ trống.
   * Nếu không sẽ tải được nửa chừng thì làm đầy ổ hệ thống, hoặc lỗi ngay ở bước giải nén (và còn sót tệp dở dang).
   * Dự phòng 1GB: sau khi giải nén trình giả lập/image còn snapshot, phân vùng dữ liệu người dùng sẽ tiếp tục phình ra.
   * @param {string} component tên thành phần (quyết định ước tính dung lượng cần)
   * @param {string} targetDir thư mục ghi (dựa vào đó xác định ổ đĩa)
   */
  async guardDisk(component, targetDir) {
    const need = {
      adb: 64, emulator: 600, sysimg: 1800, playimg: 1800, qemu: 320, iso: 1100, aehd: 64,
      // Gói runtime trọn bộ: tệp nén 1.5GB + image ~3.3GB sau khi bung, lúc đỉnh tồn tại đồng thời
      runtime: 5000,
    }[component] || 512; // MB
    const buf = 1024; // dự phòng thêm 1GB (snapshot / phân vùng dữ liệu / tệp trung gian khi giải nén)
    const dir = targetDir || this.root;
    const free = doctor.freeDiskMB(dir);
    if (free && free < need + buf) {
      throw new Error(
        `Ổ đĩa đích không đủ dung lượng: thành phần này cần khoảng ${need + buf} MB, nhưng ổ chứa「${dir}」chỉ còn ${free} MB.\n`
        + 'Gợi ý: chuyển「Thư mục dữ liệu runtime」sang ổ còn nhiều chỗ hơn (Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu runtime → Duyệt), '
        + 'hoặc dọn dẹp ổ đĩa / gỡ các ứng dụng không dùng rồi thử lại.',
      );
    }
    return free;
  }

  // ---------------- Kiểm tra môi trường ----------------

  async hypervisor() {
    if (this._hypervisor !== null) return this._hypervisor;
    if (!IS_WIN) { this._hypervisor = { whpx: false, note: 'Không phải nền tảng Windows' }; return this._hypervisor; }
    // Chỉ kiểm tra tệp cấp mili giây. Câu trả lời chính xác cho "WHPX có dùng được không" do emulator -accel-check đưa ra,
    // tránh khởi PowerShell ở đây (khởi động nguội 1-2 giây) làm chậm mỗi lần thăm dò trạng thái.
    const dll = fs.existsSync('C:\\Windows\\System32\\WinHvPlatform.dll');
    this._hypervisor = {
      whpx: false,          // sẽ bị emulatorAccel() ghi đè bằng giá trị thật
      dll,
      hypervisorPresent: false,
      note: dll
        ? 'Có thành phần Virtual Machine Platform (khả năng dùng được do engine runtime kiểm tra)'
        : 'Không phát hiện thành phần Windows Hypervisor Platform: có thể bật「Virtual Machine Platform」trong「Turn Windows features on or off」rồi khởi động lại',
    };
    return this._hypervisor;
  }

  async adbVersion() {
    // Cache 30s, tránh việc thăm dò trạng thái liên tục khởi tiến trình bên ngoài
    if (this._adbCache && Date.now() - this._adbCache.at < 30000) return this._adbCache.value;
    const { adbExe, adbDir } = this.paths();
    const candidates = [adbExe, path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['version'], { timeout: 10000 });
      if (r.ok) {
        const m = /version\s+([\d.]+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : r.stdout.split('\n')[0].trim() };
        this._adbCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._adbCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._adbCache.value;
  }

  async qemuVersion() {
    if (this._qemuCache && Date.now() - this._qemuCache.at < 30000) return this._qemuCache.value;
    const p = this.paths();
    const candidates = [
      p.qemuExe,
      store.getSettings().runtime.qemuPath,
      'C:\\Program Files\\qemu\\qemu-system-x86_64.exe',   // vị trí cài mặc định của winget
      path.join(this.appRoot, 'engine', 'qemu', 'qemu-system-x86_64.exe'),
    ].filter(Boolean);
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      const r = await run(c, ['--version'], { timeout: 15000 });
      if (r.ok || r.stdout) {
        const m = /QEMU emulator version\s+(\S+)/i.exec(r.stdout);
        const v = { ok: true, path: c, version: m ? m[1] : (r.stdout || '').split('\n')[0].trim() };
        this._qemuCache = { at: Date.now(), value: v };
        return v;
      }
    }
    this._qemuCache = { at: Date.now(), value: { ok: false, path: '', version: '' } };
    return this._qemuCache.value;
  }

  /** Kiểm tra bộ mô tả volume chính ISO9660 ("CD001" ở offset 0x8001), tránh coi trang lỗi/tệp dở dang là image */
  inspectIso(file) {
    const size = fileSize(file);
    if (!size) return { ok: false, iso9660: false, size: 0, reason: 'Chưa tải' };
    let magic = '';
    try {
      const fd = fs.openSync(file, 'r');
      const b = Buffer.alloc(5);
      fs.readSync(fd, b, 0, 5, 0x8001);
      fs.closeSync(fd);
      magic = b.toString('latin1');
    } catch (_) { /* ignore */ }

    const iso9660 = magic === 'CD001';
    // Image đĩa raw/đã cài do người dùng nhập không có vùng khởi động ISO, cho qua theo kích thước
    const rawImage = !iso9660 && /\.(img|raw|qcow2)$/i.test(file) && size > MIN_SIZE.iso;
    const ok = size > MIN_SIZE.iso && (iso9660 || rawImage);

    let reason = '';
    if (!ok) {
      reason = size <= MIN_SIZE.iso
        ? `Tệp chỉ có ${(size / 1048576).toFixed(1)}MB, tải chưa xong`
        : 'Tệp không phải image ISO9660 hợp lệ (có thể đã tải nhầm trang lỗi hoặc tệp đã hỏng)';
    }
    return { ok, iso9660, rawImage, size, reason, magic };
  }

  async checkEnv() {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const [adb, qemu, hv, emulator, accel] = await Promise.all([
      this.adbVersion(), this.qemuVersion(), this.hypervisor(),
      this.emulatorVersion(), this.emulatorAccel(),
    ]);

    const isoPath = s.runtime.isoPath || p.iso;
    const diskPath = s.runtime.diskPath || p.disk;
    const iso = this.inspectIso(isoPath);
    const diskSize = fileSize(diskPath);
    const sysimg = this.systemImageInfo();

    // Bản đầy đủ (kèm runtime) chỉ mang một image Google Play API 34, nó vừa là image chính vừa là image tương thích;
    // không còn phụ thuộc công tắc compatImage, tránh「image rõ ràng có đó, nhưng vì chưa bật công tắc nên bị coi là chưa triển khai」
    const compatReady = this.playImageInfo().ok;
    const emulatorReady = emulator.ok && (sysimg.ok || compatReady);
    const qemuReady = qemu.ok && diskSize > MIN_SIZE.disk;

    return {
      adb: { ...adb, required: true },
      emulator: { ...emulator, required: true, note: emulator.ok ? emulator.version : 'Chưa cài' },
      sysimg: {
        ok: sysimg.ok || compatReady,
        dir: sysimg.dir,
        size: sysimg.ok ? sysimg.size : (compatReady ? this.playImageInfo().size : 0),
        api: sysimg.ok ? sysimg.api : (compatReady ? PLAY_SYSIMG.api : sysimg.api),
        required: false,
        note: sysimg.ok
          ? `Android ${sysimg.api} (${(sysimg.size / 1073741824).toFixed(2)} GB)`
          : (compatReady ? `Android ${PLAY_SYSIMG.api} (image tương thích ARM)` : (sysimg.note || 'Chưa tải')),
      },
      playImage: this.playImageInfo(),
      accel,
      qemu: { ...qemu, required: false },
      iso: {
        ok: iso.ok,
        path: isoPath,
        size: iso.size,
        iso9660: iso.iso9660,
        required: false,
        note: iso.size ? `${(iso.size / 1073741824).toFixed(2)} GB` : 'Chưa tải',
        reason: iso.reason,
      },
      disk: {
        ok: diskSize > MIN_SIZE.disk,
        path: diskPath,
        size: diskSize,
        required: false,
        note: diskSize ? `${(diskSize / 1073741824).toFixed(2)} GB` : 'Chưa tạo',
      },
      hypervisor: hv,
      ready: !!(adb.ok && (emulatorReady || qemuReady)),
      engine: emulatorReady ? 'emulator' : (qemuReady ? 'qemu' : 'none'),
      paths: p,
    };
  }

  // ---------------- adb ----------------

  async installAdb(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('adb', p.root);
    const zipPath = path.join(p.tmp, 'platform-tools.zip');
    onProgress({ stage: 'download', message: 'Đang tải Android platform-tools (khoảng 8MB)…', percent: 2 });

    await downloadAny(SOURCES.adb, zipPath, {
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải adb… ${(pr.got / 1048576).toFixed(1)}MB / ${(pr.total / 1048576).toFixed(1)}MB`,
        percent: pr.percent,
        speed: pr.speed,
      }),
    });

    assertComplete(zipPath, MIN_SIZE.adb, 'Gói cài đặt adb');

    onProgress({ stage: 'extract', message: 'Đang giải nén adb…', percent: 92 });
    await this.extractZip(zipPath, p.root);

    const v = await this.adbVersion();
    if (!v.ok) throw new Error('adb không chạy được sau khi giải nén, hãy kiểm tra xem có bị phần mềm diệt virus chặn không');

    fs.rmSync(zipPath, { force: true });
    store.saveSettings({ adbPath: v.path });
    this._cache.adbVersion = v.version;
    onProgress({ stage: 'done', message: `adb ${v.version} đã sẵn sàng`, percent: 100 });
    return v;
  }

  /**
   * Giải nén bằng bộ phân tích ZIP tự có (tránh phụ thuộc công cụ giải nén của hệ thống)
   * Mục lớn (system.img cỡ GB) đi theo luồng, mục nhỏ đọc nguyên khối, tránh chạm giới hạn một Buffer của Node.
   */
  // ---------------- Gói runtime trọn bộ trên GitHub của dự án (bản nhẹ) ----------------

  async _fetchJson(url) {
    const text = await this._fetchText(url).catch(() => '');
    try { return JSON.parse(text); } catch (_) { return null; }
  }

  /**
   * Phân giải địa chỉ tải「gói runtime trọn bộ」.
   * Quy ước tên asset: ApkStart-runtime-<tag>.zip (do .github/workflows/release.yml tạo ra,
   * nội dung chính là bộ build/runtime: emulator/ + platform-tools/ + aehd/ + system-images/).
   * Quét cả GitHub lẫn Gitee, lấy cái có phiên bản cao nhất; không tìm thấy thì ném lỗi, để tầng trên lùi về
   * tải từng thành phần từ nguồn chính thức của Google.
   */
  async resolveRuntimePack() {
    const custom = String(store.getSettings().runtime.runtimePackUrl || '').trim();
    if (custom) return { url: absUrl(custom), name: path.basename(custom.split('?')[0]), size: 0, tag: 'custom' };
    if (this._cache.pack) return this._cache.pack;

    const pref = String(store.getSettings().runtime.sourcePreference || 'auto');
    const apis = [];
    if (pref !== 'gitee') apis.push({ api: SOURCES.ghReleaseApi, page: SOURCES.ghReleasePage, name: 'GitHub' });
    if (pref !== 'github') apis.push({ api: SOURCES.giteeReleaseApi, page: SOURCES.giteeReleasePage, name: 'Gitee' });

    // Hỏi song song hai bên; bên nào lỗi cũng không ảnh hưởng bên kia
    const lists = await Promise.all(apis.map(async (a) => {
      const j = await this._fetchJson(`${a.api}?per_page=15`).catch(() => null);
      return { ...a, list: Array.isArray(j) ? j : null };
    }));

    const cands = [];
    for (const item of lists) {
      if (!item.list) continue;
      for (const rel of item.list) {
        if (!rel || rel.draft) continue;
        const hit = (rel.assets || []).find((x) => /^ApkStart-runtime-.*\.zip$/i.test(x.name || ''));
        if (!hit) continue;
        cands.push({
          url: hit.browser_download_url || hit.url,
          name: hit.name,
          size: hit.size || 0,
          tag: String(rel.tag_name || rel.name || '').replace(/^v/i, ''),
          page: rel.html_url || item.page,
          from: item.name,
        });
      }
    }
    if (!cands.length) {
      const errs = lists.filter((x) => !x.list).map((x) => `${x.name} không truy cập được`).join(', ');
      throw new Error(`Cả hai nguồn đều không có gói runtime trọn bộ${errs ? ` (${errs})` : ''}`);
    }
    cands.sort((a, b) => cmpVer(b.tag, a.tag));
    this._cache.pack = cands[0];
    return this._cache.pack;
  }

  /**
   * Triển khai một chạm cho bản nhẹ: tải gói runtime trọn bộ từ GitHub của dự án rồi giải nén.
   * System image trong gói là .xz, lần khởi động đầu do materializeImages() bung ra (chỉ làm một lần).
   */
  async installRuntimePack(onProgress = () => {}) {
    const p = this.ensureDirs();
    // Báo tiến độ trước: đoạn tìm phiên bản + đo tốc độ không có số byte, không báo thì người dùng tưởng「treo rồi」.
    onProgress({ stage: 'download', message: 'Đang lấy thông tin phiên bản runtime…', percent: 1 });
    const pack = await this.resolveRuntimePack();
    await this.guardDisk('runtime', p.root);
    const zip = path.join(p.tmp, 'runtime-pack.zip');
    const total = pack.size || 0;
    const s = store.getSettings().runtime || {};
    const conn = Math.max(1, Math.min(16, Number(s.downloadConnections) || 8));

    onProgress({ stage: 'download', message: `Đang chọn nguồn tải nhanh nhất (${pack.from || 'GitHub'} · ${pack.tag})…`, percent: 1 });
    // Ứng viên = nguồn gốc + tiền tố mirror. Tải thử mỗi nguồn 128KB đo tốc độ thật rồi mới quyết định dùng cái nào:
    //「đoán theo tên miền」thực tế hay sai —— cùng một địa chỉ buổi sáng 30KB/s, buổi tối 5MB/s.
    const urls = await this.sources
      .rank(this._downloadUrls(pack.url), { onProgress: (pp) => onProgress({ stage: 'download', message: pp.message, percent: 1 }) })
      .catch(() => this._downloadUrls(pack.url));

    onProgress({ stage: 'download', message: `Đang tải runtime (khoảng 1.5 GB, chỉ một lần, ${conn} luồng)…`, percent: 2 });
    // Tải song song theo khối (8 luồng) nhanh hơn nhiều so với một luồng: GitHub giới hạn tốc độ mỗi kết nối rất phổ biến, một luồng đo thực tế chỉ
    // một hai trăm KB/s, 8 luồng chạy hết băng thông nội bộ. Đứt giữa chừng sẽ lùi về tải tiếp một luồng.
    await downloadMulti(urls, zip, {
      connections: conn,
      onProgress: (pr) => {
        const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
        const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
        const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
        const eta = Number(pr.eta) > 0 ? ` · còn khoảng ${Math.ceil(pr.eta / 60)} phút` : '';
        onProgress({
          stage: 'download',
          message: `Đang tải runtime ${mb}${sp}${eta}`,
          percent: Math.max(1, Math.min(90, Math.round(pct * 0.9))),
          speed: pr.speed,
        });
      },
    });
    assertComplete(zip, 200 * 1024 * 1024, 'Gói runtime trọn bộ');

    onProgress({ stage: 'extract', message: 'Đang giải nén runtime (khoảng 1 phút)…', percent: 91 });
    await this.extractZip(zip, p.root, {
      onEntry: (name, done, all) => {
        if (done % 50 === 0) {
          onProgress({ stage: 'extract', percent: Math.min(99, 91 + Math.round((done / all) * 8)), message: `Đang giải nén ${done}/${all}` });
        }
      },
    });
    try {
      fs.writeFileSync(path.join(p.root, '.runtime-pack.json'), JSON.stringify({
        name: pack.name, tag: pack.tag, at: new Date().toISOString(), from: pack.url,
      }));
      fs.rmSync(zip, { force: true });
    } catch (_) { /* không ghi được dấu đánh dấu cũng không ảnh hưởng sử dụng */ }

    // system.img trong gói trọn bộ được nén .xz (giống gói cài bản đầy đủ). Ở đây bung ra ngay,
    // nếu không thì checkEnv() ngay sau đó sẽ cho là「chưa cài system image」, lại đi tải từ Google thêm một bộ 1.4 GB.
    // Bung thất bại thì bắt buộc để việc triển khai thất bại kèm lý do: bản cũ ở đây catch thành 0, người dùng thấy tiến độ
    // dừng ở 99% rồi lại nhảy về「chuyển sang nguồn chính thức để bổ sung」, tải phí thêm một bộ 1.4GB.
    onProgress({ stage: 'extract', message: 'Đang bung system image (khoảng 1 phút, chỉ một lần)…', percent: 99 });
    await this.materializeImages((m) => onProgress({ stage: 'extract', message: m, percent: 99 }));

    onProgress({ stage: 'done', message: 'Runtime đã sẵn sàng', percent: 100 });
    return { ok: true, name: pack.name, tag: pack.tag };
  }

  /**
   * Ứng viên địa chỉ tải: ưu tiên kết nối thẳng, sau đó tới tiền tố mirror.
   * Đi qua Sources xử lý chung, lợi ích là「mirror tự động (ghfast / gh-proxy)」và tiền tố người dùng tự đặt
   * chỉ cần duy trì ở một chỗ, và dùng chung một bản cache đo tốc độ với tải đa luồng.
   */
  _downloadUrls(url) {
    return this.sources.candidates(url);
  }

  async extractZip(zipPath, destDir, opts = {}) {
    // Gói lớn (emulator / system image) dùng bản đọc từ tệp: không đọc nguyên zip 1.5GB vào bộ nhớ,
    // máy ít RAM cũng giải nén ổn định; gói nhỏ vẫn dùng bản trong bộ nhớ, nhanh hơn.
    const big = fileSize(zipPath) > 64 * 1024 * 1024;
    const zip = big ? new ZipFile(zipPath) : new ZipArchive(fs.readFileSync(zipPath));
    const STREAM_THRESHOLD = 64 * 1024 * 1024;
    const total = zip.names().length;
    let done = 0;

    try {
      for (const name of zip.names()) {
        if (name.endsWith('/')) {
          fs.mkdirSync(path.join(destDir, name), { recursive: true });
          continue;
        }
        const target = path.join(destDir, name);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        const e = zip.entries.get(name);
        if (e.uncompSize > STREAM_THRESHOLD) {
          // eslint-disable-next-line no-await-in-loop
          await zip.pipeTo(name, fs.createWriteStream(target));
        } else {
          fs.writeFileSync(target, zip.read(name));
        }
        done += 1;
        if (opts.onEntry) opts.onEntry(name, done, total);
      }
    } finally {
      if (zip.close) zip.close();
    }
    return destDir;
  }

  // ---------------- Emulator (runtime chính thức của Google) ----------------

  /** Lấy một đoạn văn bản XML (có giới hạn kích thước, tệp chỉ mục khoảng 400KB) */
  async _fetchText(url, limit = 2 * 1024 * 1024) {
    const { openStream } = require('./download');
    const res = await openStream(url);
    return new Promise((resolve, reject) => {
      let d = '';
      res.on('data', (c) => { d += c; if (d.length > limit) res.destroy(); });
      res.on('end', () => resolve(d));
      res.on('error', () => resolve(d));
    });
  }

  /** Phân giải động địa chỉ gói emulator Windows mới nhất từ chỉ mục SDK */
  async resolveEmulatorUrl() {
    const cached = store.getSettings().runtime.emulatorUrl;
    if (cached && cached.trim()) return absUrl(cached);
    if (this._cache.emulatorUrl) return this._cache.emulatorUrl;
    try {
      const xml = await this._fetchText(SOURCES.sdkIndex);
      const block = /<remotePackage path="emulator"[\s\S]*?<\/remotePackage>/.exec(xml);
      if (block) {
        const base = baseOf(SOURCES.sdkIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base));
        const win = urls.find((u) => /windows_x64.*\.zip$/i.test(u));
        if (win) {
          this._cache.emulatorUrl = win;
          return win;
        }
      }
    } catch (_) { /* rơi về dự phòng */ }
    this._cache.emulatorUrl = SOURCES.emulatorFallback;
    return SOURCES.emulatorFallback;
  }

  /** Phân giải địa chỉ system image AOSP mặc định từ chỉ mục sys-img */
  async resolveSysimgUrl() {
    const cached = store.getSettings().runtime.sysimgUrl;
    if (cached && cached.trim()) return absUrl(cached, baseOf(SOURCES.sysImgIndexes[0]));
    if (this._cache.sysimgUrl) return this._cache.sysimgUrl;
    const want = `system-images;android-${DEFAULT_SYSIMG.api};${DEFAULT_SYSIMG.tag};${DEFAULT_SYSIMG.abi}`;
    for (const idx of [SOURCES.playImgIndex, ...SOURCES.sysImgIndexes]) {
      try {
        // eslint-disable-next-line no-await-in-loop
        const xml = await this._fetchText(idx);
        const re = new RegExp(`<remotePackage path="${want.replace(/[;]/g, ';')}"[\\s\\S]*?</remotePackage>`);
        const block = re.exec(xml);
        if (block) {
          const base = baseOf(idx);
          const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
            .filter((u) => /x86_64.*\.zip$/i.test(u));
          if (urls.length) {
            this._cache.sysimgUrl = urls[urls.length - 1];
            return this._cache.sysimgUrl;
          }
        }
      } catch (_) { /* chuyển sang chỉ mục tiếp theo */ }
    }
    this._cache.sysimgUrl = SOURCES.sysimgFallback;
    return SOURCES.sysimgFallback;
  }

  async emulatorVersion() {
    if (this._cache.emulatorVersion && this._cache.emulatorVerAt && Date.now() - this._cache.emulatorVerAt < 30000) {
      return this._cache.emulatorVersion;
    }
    const p = this.paths();
    const candidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    for (const c of candidates) {
      if (!fs.existsSync(c)) continue;
      // Phiên trước đã dò, và tệp engine không đổi: dùng thẳng kết quả trên đĩa (bỏ được một lần khởi tiến trình 1s+)
      const cached = this.envCacheGet(c);
      if (cached && cached.version && cached.version.ok && Date.now() - (cached.at || 0) < ENV_CACHE_TTL) {
        this._cache.emulatorVersion = cached.version;
        this._cache.emulatorVerAt = Date.now();
        return cached.version;
      }
      // eslint-disable-next-line no-await-in-loop
      const r = await run(c, ['-version'], { timeout: 20000 });
      const text = `${r.stdout}${r.stderr}`;
      const m = /Android emulator version\s+([\d.]+)/i.exec(text);
      if (m) {
        this._cache.emulatorVersion = { ok: true, path: c, version: m[1] };
        this._cache.emulatorVerAt = Date.now();
        this.envCacheSet(c, { version: this._cache.emulatorVersion });
        return this._cache.emulatorVersion;
      }
    }
    return { ok: false, path: '', version: '' };
  }

  /**
   * Lần khởi động đầu, bung image nén đi kèm gói vào thư mục người dùng (chỉ làm một lần).
   * Trong bản phát hành một tệp system.img là .gz (3.1GB→khoảng 580MB), không bung thì trình giả lập không dùng được.
   * Bung vào %APPDATA% chứ không phải trong gói: thư mục runtime của bản portable mỗi lần khởi động là một thư mục tạm mới,
   * đặt vào đó tức mỗi lần khởi động lại giải nén lại một lượt.
   */
  async materializeImages(onLog = () => {}) {
    const srcRoot = path.join(this.root, 'system-images');
    // Đích bung ra bắt buộc dùng cùng quy tắc với paths().sysImgRoot, nếu không sẽ xảy ra
    //「gói trọn bộ giải ra ổ D, image lại bung về APPDATA ổ C」chiếm chỗ trùng lặp (đo thực tế 1.2GB + 3.3GB).
    const destRoot = this.paths().sysImgRoot;
    const jobs = [];
    const copies = []; // các tệp ngoài image nén (kernel-ranchu / ramdisk / .img không nén…) phải cùng đặt vào thư mục bung
    const found = new Map(); // dest -> job (cùng image có cả .xz/.gz thì ưu tiên .xz)
    const walk = (dir, rel = '') => {
      let entries = [];
      try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
      for (const e of entries) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) { walk(p, path.join(rel, e.name)); continue; }
        // Hỗ trợ .img.xz (LZMA2, nhỏ hơn .gz ~25%) và .img.gz cũ
        if (/\.img\.(xz|gz)$/i.test(e.name)) {
          const dest = path.join(destRoot, rel, e.name.replace(/\.img\.(xz|gz)$/i, '.img'));
          const job = { src: p, dest, xz: /\.xz$/i.test(e.name) };
          const prev = found.get(dest);
          if (!prev || (job.xz && !prev.xz)) found.set(dest, job);
        } else {
          copies.push({ src: p, dest: path.join(destRoot, rel, e.name) });
        }
      }
    };
    walk(srcRoot);
    jobs.push(...found.values());
    if (!jobs.length && !copies.length) return 0;

    // Bổ sung các tệp không phải image trước (trình giả lập dựa vào kernel-ranchu… để định vị/khởi động, thiếu sẽ báo "còn thiếu system image")
    for (const c of copies) {
      try {
        if (path.resolve(c.src) === path.resolve(c.dest)) continue;   // bung tại chỗ, không cần sao chép
        const have = fileSize(c.dest);
        if (have > 0 && have === fileSize(c.src)) continue;
        fs.mkdirSync(path.dirname(c.dest), { recursive: true });
        fs.copyFileSync(c.src, c.dest);
      } catch (e) { onLog(`Sao chép thành phần image thất bại: ${e.message}`); }
    }

    let done = 0;
    const failures = [];
    for (const j of jobs) {
      const have = fileSize(j.dest);
      // Xác định「đã bung rồi」không được chỉ nhìn 32MB: bản cũ không có .part, bị ngắt giữa chừng có thể để lại
      // image dở dang vài trăm MB, vượt ngưỡng là bị coi là xong, khởi động thì nổ vì system image hỏng.
      // Image thật sau khi giải nén chắc chắn lớn hơn tệp nén, nên「nhỏ hơn kích thước tệp nén」= chắc chắn chưa bung xong.
      const srcSize = fileSize(j.src);
      if (have > 32 * 1024 * 1024 && (srcSize <= 0 || have >= srcSize)) continue;
      // Giải nén ra .part trước, thành công mới đổi tên: giải nén bị ngắt giữa chừng (đóng chương trình / mất điện / đầy đĩa)
      // sẽ không để lại một system.img dở dang「trông như đã xong」, nếu không lần sau sẽ bỏ qua bước bung,
      // khởi động thì chết vì image hỏng, người dùng chỉ còn cách xóa dữ liệu làm lại.
      const part = `${j.dest}.part`;
      try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
      fs.mkdirSync(path.dirname(j.dest), { recursive: true });
      onLog(`Khởi động lần đầu: đang bung system image ${path.basename(j.dest)} (khoảng 1 phút, chỉ một lần)`);
      try {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((resolve, reject) => {
          const { pipeline, Readable } = require('stream');
          if (j.xz) {
            // Giải nén LZMA2: bắt buộc require thẳng binding native index.js.
            // Entry mặc định của gói main.js / xz.js bên trong sẽ require('stream-polyfill.mjs'),
            // Node 20 của Electron không hỗ trợ require(ESM) nên sẽ ném lỗi; mà exports lại không cho
            // viết thẳng '@napi-rs/lzma/index.js', nên dùng require.resolve định vị thư mục rồi require theo đường dẫn tệp.
            const path0 = require('path');
            const lzmaDir = path0.dirname(require.resolve('@napi-rs/lzma'));
            const { xz } = require(path0.join(lzmaDir, 'index.js'));
            const webIn = Readable.toWeb(fs.createReadStream(j.src));
            const webOut = xz.decompressStream(webIn);
            pipeline(Readable.fromWeb(webOut), fs.createWriteStream(part), (err) => (err ? reject(err) : resolve()));
          } else {
            pipeline(
              fs.createReadStream(j.src),
              zlib.createGunzip(),
              fs.createWriteStream(part),
              (err) => (err ? reject(err) : resolve()),
            );
          }
        });
        fs.renameSync(part, j.dest);
        done += 1;
      } catch (e) {
        try { fs.rmSync(part, { force: true }); } catch (_) { /* ignore */ }
        // Không được nuốt im lặng nữa: caller (triển khai một chạm / khởi động) phải biết image chưa bung thành công,
        // nếu không sẽ「tải thêm một bộ 1.4GB từ nguồn chính thức」hoặc khởi động thất bại luôn.
        failures.push(`${path.basename(j.dest)}: ${e.message}`);
        onLog(`Bung image thất bại: ${e.message}`);
      }
    }
    if (failures.length) {
      const err = new Error(`Bung system image thất bại (${failures.join('; ')})`);
      err.code = 'MATERIALIZE_FAILED';
      err.failed = failures;
      throw err;
    }
    return done;
  }

  /** System image có đầy đủ không (system.img là chỉ tiêu cứng, thiếu hoặc quá nhỏ đều coi là chưa tải xong) */
  systemImageInfo() {
    const p = this.paths();
    const roots = [p.sysImgRoot, path.join(this.root, 'system-images'), path.join(this.appRoot, 'engine', 'system-images')];
    // Tìm ở vị trí mặc định (API34 Play) trước, rồi mới lùi về「bộ image nào cũng được」.
    // Bản phát hành một tệp có thể chỉ kèm một bộ image AOSP nhỏ hơn, ghi cứng API34 sẽ khiến
    // image rõ ràng có trong gói mà vẫn báo "chưa tải", người dùng bị buộc lên mạng tải một bộ mới.
    const preferred = [p.sysImgDir,
      path.join(this.appRoot, 'engine', 'system-images',
        `android-${DEFAULT_SYSIMG.api}`, DEFAULT_SYSIMG.tag, DEFAULT_SYSIMG.abi)];
    const candidates = [...preferred];
    for (const root of roots) {
      let apis = [];
      try { apis = fs.readdirSync(root).filter((d) => /^android-\d+$/.test(d)); } catch (_) { continue; }
      apis.sort((a, b) => Number(b.split('-')[1]) - Number(a.split('-')[1]));
      for (const api of apis) {
        let tags = [];
        try { tags = fs.readdirSync(path.join(root, api)); } catch (_) { continue; }
        for (const tag of tags) {
          let abis = [];
          try { abis = fs.readdirSync(path.join(root, api, tag)); } catch (_) { continue; }
          for (const abi of abis) candidates.push(path.join(root, api, tag, abi));
        }
      }
    }
    let missing = null;
    for (const dir of candidates) {
      const system = path.join(dir, 'system.img');
      const kernel = path.join(dir, 'kernel-ranchu');
      const size = fileSize(system);
      const m = /system-images[\\/]android-(\d+)[\\/]([^\\/]+)[\\/]([^\\/]+)$/.exec(dir);
      const api = m ? Number(m[1]) : DEFAULT_SYSIMG.api;
      const tag = m ? m[2] : DEFAULT_SYSIMG.tag;
      const abi = m ? m[3] : DEFAULT_SYSIMG.abi;
      if (size > MIN_SIZE.sysimg && fs.existsSync(kernel)) {
        return { ok: true, dir, size, api, tag, abi };
      }
      if (!missing && fs.existsSync(dir)) {
        missing = { ok: false, dir, size, api, tag, abi, note: size ? 'Image không đầy đủ' : 'Thiếu system.img' };
      }
    }
    if (missing) return missing;
    return { ok: false, dir: p.sysImgDir, size: 0, api: DEFAULT_SYSIMG.api, tag: DEFAULT_SYSIMG.tag, note: 'Chưa tải' };
  }

  /**
   * Trạng thái tăng tốc phần cứng.
   * Trên Windows emulator hỗ trợ hai kiểu tăng tốc: WHPX (tính năng hệ thống, cần khởi động lại) và AEHD (driver của chính Google, cài xong dùng ngay).
   */
  async emulatorAccel() {
    // Thăm dò trạng thái vài giây một lần, mà -accel-check phải khởi một tiến trình emulator, bắt buộc phải cache
    if (this._cache.accel && this._cache.accelAt && Date.now() - this._cache.accelAt < 30000) {
      return this._cache.accel;
    }
    const p = this.paths();
    const exe = fs.existsSync(p.emulatorExe) ? p.emulatorExe
      : path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe');
    if (!fs.existsSync(exe)) return { ok: false, kind: 'none', note: 'Chưa cài emulator' };

    // Cache trên đĩa: khi khởi động nguội không còn khởi tiến trình emulator cho mục này nữa.
    // Kết luận「không khả dụng」chỉ tin 10 phút —— người dùng có thể vừa bật ảo hóa/cài AEHD, phải phản ánh ngay được.
    const cached = this.envCacheGet(exe);
    if (cached && cached.accel) {
      const ttl = cached.accel.ok ? ENV_CACHE_TTL : ENV_CACHE_NEG_TTL;
      if (Date.now() - (cached.accelAt || 0) < ttl) {
        this._cache.accel = cached.accel;
        this._cache.accelAt = Date.now();
        return cached.accel;
      }
    }

    const aehdSys = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'aehd.sys');
    const hasAehdFile = fs.existsSync(aehdSys) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    const hv = await this.hypervisor();

    const r = await run(exe, ['-accel-check'], { timeout: 30000 });
    const text = `${r.stdout}${r.stderr}`;
    const usable = /accel:\s*\n?0\b/.test(text) && !/ERROR_ACCESS_DENIED|not installed/i.test(text);

    let result;
    if (usable) {
      const kind = hasAehdFile && /aehd/i.test(text) ? 'aehd' : 'whpx';
      result = { ok: true, kind, note: kind === 'whpx' ? 'Đã bật tăng tốc phần cứng WHPX' : 'Đã bật tăng tốc phần cứng AEHD' };
    } else if (/can't find the emulator-check|corrupted tools installation/i.test(text) && hasAehdFile) {
      // Một số gói runtime rút gọn bỏ sót emulator-check.exe, khiến -accel-check không đưa ra được kết luận.
      // Lúc này chỉ cần driver AEHD đã cài thì xử lý là「khả dụng」: khi khởi động emulator tự gắn driver,
      // tránh bị nhận nhầm là không có tăng tốc rồi ép -accel off (giả lập phần mềm trên một số máy sẽ sập luôn).
      result = { ok: true, kind: 'aehd', note: 'Đã bật tăng tốc phần cứng AEHD (thiếu emulator-check, xác định theo driver)' };
    } else if (hasAehdFile && /aehd/i.test(text) && !/ERROR_ACCESS_DENIED/i.test(text)) {
      result = { ok: true, kind: 'aehd', note: 'Đã bật tăng tốc phần cứng AEHD' };
    } else if (hv.dll && /whpx/i.test(text) && !/error|denied/i.test(text)) {
      result = { ok: true, kind: 'whpx', note: 'Đã bật tăng tốc phần cứng WHPX' };
    } else {
      result = {
        ok: false,
        kind: 'none',
        whpx: hv.whpx,
        aehdInstalled: hasAehdFile,
        viaTcg: true,
        note: 'Chưa bật tăng tốc phần cứng: sẽ chuyển về giả lập phần mềm (chạy được nhưng rất chậm). Nên cài driver AEHD hoặc bật「Virtual Machine Platform」',
      };
    }
    this._cache.accel = result;
    this._cache.accelAt = Date.now();
    this.envCacheSet(exe, { accel: result, accelAt: Date.now() });
    return result;
  }

  /** Tải và cài emulator (cấp cao nhất của zip chính là emulator/, giải thẳng vào SDK root) */
  async installEmulator(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('emulator', p.root);
    const url = await this.resolveEmulatorUrl();
    const zip = path.join(p.tmp, 'emulator.zip');
    onProgress({ stage: 'download', message: 'Đang tải engine runtime (khoảng 440MB, từ nguồn chính thức của Google)…', percent: 1 });

    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải engine runtime ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.85),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.emulator, 'Engine runtime');

    onProgress({ stage: 'extract', message: 'Đang giải nén engine runtime…', percent: 88 });
    await this.extractZip(zip, p.root);
    fs.rmSync(zip, { force: true });

    // SDK root bắt buộc phải có cả platform-tools, nếu không emulator từ chối khởi động
    this.ensurePlatformTools();

    const v = await this.emulatorVersion();
    if (!v.ok) throw new Error('emulator không chạy được sau khi giải nén, hãy kiểm tra xem có bị phần mềm diệt virus chặn không');
    this._cache.emulatorVersion = v.version;
    onProgress({ stage: 'done', message: `Engine runtime ${v.version} đã sẵn sàng`, percent: 100 });
    return v;
  }

  /** emulator yêu cầu SDK root có thư mục platform-tools, nếu không sẽ FATAL ngay */
  ensurePlatformTools() {
    const p = this.paths();
    fs.mkdirSync(p.adbDir, { recursive: true });
    if (fs.existsSync(p.adbExe)) return true;
    const src = [
      path.join(this.appRoot, 'engine', 'platform-tools'),
      path.join(this.appRoot, 'tools', 'platform-tools'),
      path.dirname(this.adbVersionPath() || ''),
    ].find((d) => d && fs.existsSync(path.join(d, 'adb.exe')));
    if (!src) return false;
    for (const f of ['adb.exe', 'AdbWinApi.dll', 'AdbWinUsbApi.dll']) {
      const from = path.join(src, f);
      if (fs.existsSync(from)) fs.copyFileSync(from, path.join(p.adbDir, f));
    }
    return fs.existsSync(p.adbExe);
  }

  adbVersionPath() {
    try {
      const s = store.getSettings();
      if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    } catch (_) { /* ignore */ }
    return '';
  }

  /** Chỉ tải một image nền dùng chung (Android 14 Play x86_64), không còn hai bộ「thường/tương thích」 */
  async installSystemImage(onProgress = () => {}) {
    if (this.playImageInfo().ok) return this.playImageInfo();
    return this.installPlayImage(onProgress);
  }

  /** Image tương thích ARM (bản Google Play) đã sẵn sàng chưa */
  playImageInfo() {
    const p = this.paths();
    const dir = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag, PLAY_SYSIMG.abi);
    const size = fileSize(path.join(dir, 'system.img'));
    if (size > MIN_SIZE.sysimg && fs.existsSync(path.join(dir, 'kernel-ranchu'))) {
      return { ok: true, dir, size, api: PLAY_SYSIMG.api, tag: PLAY_SYSIMG.tag };
    }
    return { ok: false, dir, size, note: size ? 'Image không đầy đủ' : 'Chưa tải' };
  }

  /** Phân giải địa chỉ image bản Google Play (<url> tương đối với thư mục chứa tệp chỉ mục) */
  async resolvePlayUrl() {
    if (this._cache.playUrl) return this._cache.playUrl;
    try {
      const xml = await this._fetchText(SOURCES.playImgIndex);
      const want = `system-images;android-${PLAY_SYSIMG.api};${PLAY_SYSIMG.tag};${PLAY_SYSIMG.abi}`;
      const block = new RegExp(`<remotePackage path="${want}"[\\s\\S]*?</remotePackage>`).exec(xml);
      if (block) {
        const base = baseOf(SOURCES.playImgIndex);
        const urls = [...block[0].matchAll(/<url>([^<]+)<\/url>/g)].map((m) => absUrl(m[1], base))
          .filter((u) => /x86_64.*\.zip$/i.test(u));
        if (urls.length) {
          this._cache.playUrl = urls[urls.length - 1];
          return this._cache.playUrl;
        }
      }
    } catch (_) { /* rơi về dự phòng */ }
    this._cache.playUrl = SOURCES.playImgFallback;
    return this._cache.playUrl;
  }

  /** Tải và cài image tương thích ARM (bản Google Play, khoảng 1.5GB) */
  async installPlayImage(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('playimg', p.sysImgRoot);
    const url = await this.resolvePlayUrl();
    const zip = path.join(p.tmp, 'play-sysimg.zip');
    onProgress({ stage: 'download', message: 'Đang tải image tương thích ARM (Android 14, khoảng 1.5GB)…', percent: 1 });
    await downloadAnyParallel(this._downloadUrls(url), zip, {
      connections: 8,
      minChunk: 4 * 1024 * 1024,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải image tương thích ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1048576).toFixed(1)} MB/s)` : ''),
        percent: Math.round(pr.percent * 0.8),
        canResume: true,
      }),
    });
    assertComplete(zip, MIN_SIZE.sysimg, 'Image tương thích');

    const dest = path.join(p.sysImgRoot, `android-${PLAY_SYSIMG.api}`, PLAY_SYSIMG.tag);
    fs.mkdirSync(dest, { recursive: true });
    onProgress({ stage: 'extract', message: 'Đang giải nén image tương thích (3GB, mất hơn chục giây)…', percent: 82 });
    await this.extractZip(zip, dest, {
      onEntry: (_n, i, total) => onProgress({
        stage: 'extract',
        message: `Đang giải nén image tương thích ${i}/${total}`,
        percent: 82 + Math.round((i / Math.max(1, total)) * 15),
      }),
    });
    fs.rmSync(zip, { force: true });

    const info = this.playImageInfo();
    if (!info.ok) throw new Error('Kiểm tra image tương thích sau khi giải nén thất bại');
    // Image tương thích bản cũ (API 30) không còn dùng, cài xong thành công thì dọn để giải phóng chỗ
    for (const old of ['android-30']) {
      const legacy = path.join(p.sysImgRoot, old, 'google_apis_playstore');
      if (fs.existsSync(legacy)) fs.rmSync(legacy, { recursive: true, force: true });
    }
    onProgress({ stage: 'done', message: 'Image tương thích ARM đã sẵn sàng, khởi động lại runtime là có hiệu lực', percent: 100 });
    return info;
  }

  /** Tải driver AEHD (tệp nhỏ); cài đặt cần quyền quản trị, giao cho luồng hướng dẫn */
  async installAehd(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('aehd', p.aehdDir);
    const zip = path.join(p.tmp, 'aehd.zip');
    onProgress({ stage: 'download', message: 'Đang tải driver AEHD…', percent: 10 });
    await downloadAnyParallel(this._downloadUrls(SOURCES.aehdFallback), zip, { connections: 2 });
    fs.mkdirSync(p.aehdDir, { recursive: true });
    await this.extractZip(zip, p.aehdDir);
    fs.rmSync(zip, { force: true });
    const has = fs.existsSync(path.join(p.aehdDir, 'aehd.Sys')) || fs.existsSync(path.join(p.aehdDir, 'aehd.sys'));
    if (!has) throw new Error('Giải nén gói driver AEHD bất thường');
    this._cache.accel = null;
    this._cache.accelAt = 0;
    onProgress({ stage: 'done', message: 'Driver AEHD đã sẵn sàng, cần quyền quản trị để cài', percent: 100 });
    return { ok: true, dir: p.aehdDir, installer: path.join(p.aehdDir, 'silent_install.bat') };
  }

  // ---------------- QEMU ----------------

  /** Lấy tên tệp gói cài mới nhất trong thư mục chính thức (không ghi cứng phiên bản) */
  async resolveQemuUrl() {
    const configured = store.getSettings().runtime.qemuUrl;
    if (configured && configured.trim()) return configured.trim();
    try {
      const { openStream } = require('./download');
      const res = await openStream(SOURCES.qemuIndex);
      const html = await new Promise((resolve, reject) => {
        let d = '';
        res.on('data', (c) => { d += c; if (d.length > 512 * 1024) res.destroy(); });
        res.on('end', () => resolve(d));
        res.on('error', reject);
      });
      const files = [...html.matchAll(/href="([^"]*qemu-w64-setup-(\d+)\.exe)"/g)]
        .map((m) => ({ file: m[1], ver: Number(m[2]) }))
        .sort((a, b) => b.ver - a.ver);
      if (files.length) {
        const f = files[0].file.replace(/^.*\//, '');
        return new URL(f, SOURCES.qemuIndex).href;
      }
    } catch (_) { /* rơi về nguồn dự phòng */ }
    return SOURCES.qemuFallback[0];
  }

  async installQemu(onProgress = () => {}) {
    const p = this.ensureDirs();
    await this.guardDisk('qemu', p.root);
    const setup = path.join(p.tmp, 'qemu-setup.exe');

    onProgress({ stage: 'resolve', message: 'Đang tìm phiên bản QEMU mới nhất…', percent: 1 });
    const url = await this.resolveQemuUrl();
    onProgress({ stage: 'download', message: `Đang tải QEMU (khoảng 200MB)…`, percent: 2, url });

    await download(url, setup, {
      resume: true,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải QEMU… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });
    assertComplete(setup, MIN_SIZE.qemu, 'Gói cài đặt QEMU');

    onProgress({ stage: 'install', message: 'Đang cài QEMU (chế độ im lặng)…', percent: 96 });
    // qemu-w64-setup là trình cài NSIS: /S im lặng, /D chỉ định thư mục (phải đặt cuối và không có dấu ngoặc kép)
    const target = p.qemuDir;
    fs.mkdirSync(target, { recursive: true });
    await new Promise((resolve) => {
      const proc = spawn(setup, ['/S', `/D=${target}`], { windowsHide: true, stdio: 'ignore' });
      proc.on('exit', () => resolve());
      proc.on('error', () => resolve());
      setTimeout(() => { try { proc.kill(); } catch (_) {} resolve(); }, 600000);
    });

    const v = await this.qemuVersion();
    if (!v.ok) {
      throw new Error('Cài QEMU xong nhưng không tìm thấy qemu-system-x86_64.exe: có thể tự tải QEMU rồi giải nén vào engine/qemu/');
    }
    fs.rmSync(setup, { force: true });
    this._cache.qemuVersion = v.version;
    onProgress({ stage: 'done', message: `QEMU ${v.version} đã sẵn sàng`, percent: 100 });
    return v;
  }

  // ---------------- System image ----------------

  async downloadIso(onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.isoPath || p.iso;
    await this.guardDisk('iso', path.dirname(dest));
    const custom = s.runtime.isoUrl && s.runtime.isoUrl.trim();
    const urls = custom ? [custom, ...SOURCES.iso] : SOURCES.iso;

    onProgress({ stage: 'download', message: 'Đang tải Android-x86 9.0-r2 (khoảng 900MB, chia khối 8 luồng)…', percent: 1 });
    const r = await downloadAnyParallel(urls, dest, {
      connections: 8,
      onProgress: (pr) => onProgress({
        stage: 'download',
        message: `Đang tải system image… ${(pr.got / 1048576).toFixed(0)}MB / ${(pr.total / 1048576).toFixed(0)}MB`
          + (pr.speed ? ` (${(pr.speed / 1024).toFixed(0)} KB/s)` : ''),
        percent: pr.percent,
        canResume: true,
      }),
    });

    const info = this.inspectIso(dest);
    if (!info.ok) {
      throw new Error(`System image không dùng được: ${info.reason}${info.size && info.size < MIN_SIZE.iso ? ', có thể bấm lại để tải tiếp từ chỗ dừng' : ''}`);
    }

    store.saveSettings({ runtime: { isoPath: dest } });
    onProgress({ stage: 'done', message: `System image đã sẵn sàng (${(info.size / 1073741824).toFixed(2)} GB)`, percent: 100, path: dest });
    return { ...r, ...info };
  }

  /** Kiểm tra image/ISO do người dùng nhập */
  inspectImage(file) {
    const size = fileSize(file);
    if (!size) throw new Error('Tệp không tồn tại hoặc rỗng');
    const fd = fs.openSync(file, 'r');
    const head4 = Buffer.alloc(4);
    fs.readSync(fd, head4, 0, 4, 0);
    fs.closeSync(fd);
    const magic = head4.toString('hex');
    let kind = 'unknown';
    if (magic === '514649fb') kind = 'qcow2';
    else if (head4.toString('ascii', 0, 4) === 'KDMV') kind = 'vmdk';
    else if (size > 400 * 1024 * 1024 && magic !== '00000000') kind = 'raw-or-iso';
    return { kind, size, path: file };
  }

  importIso(file) {
    const info = this.inspectIso(file);
    if (!info.ok) {
      const e = new Error(info.reason || 'Tệp image không dùng được');
      e.invalidIso = true;
      throw e;
    }
    store.saveSettings({ runtime: { isoPath: file } });
    return { ok: true, ...info };
  }

  importDisk(file) {
    const info = this.inspectImage(file);
    store.saveSettings({ runtime: { diskPath: file } });
    return { ok: true, ...info };
  }

  // ---------------- Đĩa ảo ----------------

  async createDisk(sizeGB = 24, onProgress = () => {}) {
    const p = this.ensureDirs();
    const s = store.getSettings();
    const dest = s.runtime.diskPath || p.disk;
    if (fileSize(dest) > MIN_SIZE.disk) return { ok: true, path: dest, existed: true };

    onProgress({ stage: 'disk', message: `Đang tạo đĩa ảo ${sizeGB}GB…`, percent: 40 });
    const qemuImg = fs.existsSync(p.qemuImg)
      ? p.qemuImg
      : path.join(path.dirname(store.getSettings().runtime.qemuPath || ''), 'qemu-img.exe');

    const tool = fs.existsSync(qemuImg) ? qemuImg : null;
    if (tool) {
      const r = await run(tool, ['create', '-f', 'qcow2', dest, `${sizeGB}G`], { timeout: 120000 });
      if (!r.ok) throw new Error(`qemu-img tạo đĩa ảo thất bại: ${r.stderr || r.stdout}`);
    } else {
      throw new Error('Không tìm thấy qemu-img.exe, hãy cài QEMU trước');
    }
    store.saveSettings({ runtime: { diskPath: dest } });
    onProgress({ stage: 'done', message: 'Đã tạo đĩa ảo', percent: 100, path: dest });
    return { ok: true, path: dest, size: fileSize(dest) };
  }

  // ---------------- Kiểm tra trước khả năng truy cập nguồn system image ----------------

  async probeSources() {
    const [adb, qemu, iso] = await Promise.all([
      head(SOURCES.adb[0]),
      head(SOURCES.qemuFallback[0]),
      head(SOURCES.iso[0]),
    ]);
    return { adb, qemu, iso };
  }
}

module.exports = { Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf };
