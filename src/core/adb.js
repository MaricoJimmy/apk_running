'use strict';
/**
 * Lớp bọc client adb
 * Chỉ làm phần apkstart cần: cài đặt / khởi chạy / dừng / gỡ cài đặt / đồng bộ tệp / chụp màn hình
 */
const { execFile, spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const COMMON_ADB_PATHS = [
  path.join(process.env.LOCALAPPDATA || '', 'Android', 'Sdk', 'platform-tools', 'adb.exe'),
  'C:\\Android\\platform-tools\\adb.exe',
  'C:\\adb\\adb.exe',
  'C:\\LDPlayer\\LDPlayer9\\adb.exe',
  'C:\\Program Files\\Netease\\MuMuPlayer-12.0\\shell\\adb.exe',
  'C:\\Program Files\\BlueStacks_nxt\\HD-Adb.exe',
];

/**
 * Dịch lý do lỗi gốc của pm install thành tiếng Việt dễ hiểu cho người dùng.
 * Giữ mã lỗi gốc ở cuối để tiện tìm kiếm, tra lỗi.
 */
function friendlyInstallError(raw) {
  const code = /INSTALL_[A-Z_]+/.exec(raw);
  const tag = code ? code[0] : '';
  const table = {
    INSTALL_FAILED_NO_MATCHING_ABIS:
      'Cài đặt thất bại: ứng dụng này chỉ có thư viện native ARM (đa số ứng dụng Trung Quốc như vậy), '
      + 'system image hiện tại không có lớp dịch ARM. ApkStart sẽ tự chuyển sang image tương thích có lớp dịch đời mới và thử lại.',
    INSTALL_FAILED_OLDER_SDK:
      'Cài đặt thất bại: ứng dụng yêu cầu phiên bản Android cao hơn runtime hiện tại (cần system image mới hơn).',
    INSTALL_PARSE_FAILED_NO_CERTIFICATES:
      'Cài đặt thất bại: APK không có chữ ký hợp lệ, không thể cài.',
    INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES:
      'Cài đặt thất bại: chữ ký không khớp với bản đã cài, hãy gỡ bản cũ trước rồi cài lại.',
    INSTALL_FAILED_VERSION_DOWNGRADE:
      'Cài đặt thất bại: thiết bị đã cài phiên bản cao hơn, không thể hạ cấp đè lên.',
    INSTALL_FAILED_INSUFFICIENT_STORAGE:
      'Cài đặt thất bại: ổ đĩa của runtime không đủ dung lượng, hãy dọn dẹp rồi thử lại.',
    INSTALL_FAILED_INVALID_APK:
      'Cài đặt thất bại: tệp APK bị hỏng hoặc không đầy đủ (có thể tải chưa xong), hãy lấy lại tệp.',
    INSTALL_FAILED_INVALID_URI: 'Cài đặt thất bại: đường dẫn APK chứa ký tự đặc biệt, hãy chuyển tệp sang đường dẫn chỉ có ký tự tiếng Anh rồi thử lại.',
    INSTALL_FAILED_ALREADY_EXISTS: 'Cài đặt thất bại: đã có ứng dụng cùng tên nhưng khác chữ ký, hãy gỡ cài đặt trước.',
    INSTALL_FAILED_UPDATE_INCOMPATIBLE: 'Cài đặt thất bại: chữ ký không khớp với bản đã cài, hãy gỡ bản cũ trước.',
    INSTALL_FAILED_DEPRECATED_SDK_VERSION:
      'Cài đặt thất bại: đây là ứng dụng dành cho phiên bản Android rất cũ (targetSdk quá thấp), Android 14 mặc định chặn cài đặt. '
      + 'ApkStart sẽ tự động thử lại với tham số vượt chặn chính thức.',
    INSTALL_FAILED_TEST_ONLY: 'Cài đặt thất bại: đây là gói ứng dụng chỉ dùng để thử nghiệm, đã tự động thêm tham số gói thử nghiệm và thử lại.',
    INSTALL_FAILED_MISSING_SHARED_LIBRARY: 'Cài đặt thất bại: tính năng thiết bị mà ứng dụng phụ thuộc (vd. thư viện riêng của hãng) không có trong runtime hiện tại.',
    INSTALL_FAILED_USER_RESTRICTION: 'Cài đặt thất bại: hệ thống hạn chế cài đặt, hãy khởi động lại runtime rồi thử lại.',
    INSTALL_FAILED_CONFLICTING_PROVIDER: 'Cài đặt thất bại: xung đột ContentProvider với ứng dụng đã có, hãy gỡ ứng dụng xung đột.',
    INSTALL_FAILED_INTERNAL_ERROR: 'Cài đặt thất bại: lỗi nội bộ hệ thống (thường do thiếu dung lượng hoặc chưa khởi động xong), hãy khởi động lại runtime rồi thử lại.',
  };
  const msg = table[tag];
  return msg ? `${msg} (${tag})` : `Cài đặt thất bại: ${raw}`;
}

/** Dịch log sập sau khi khởi chạy thành nguyên nhân dễ hiểu */
function friendlyLaunchError(raw, pkg) {
  const t = String(raw || '');
  if (/DoBadTrampoline|libndk_translation|houdini|SIGABRT.*arm/i.test(t)) {
    return `${pkg || 'Ứng dụng'} bị sập sau khi khởi chạy: lớp dịch ARM không tương thích với cách xử lý tín hiệu của ứng dụng này. `
      + 'ApkStart sẽ tự chuyển sang image tương thích Android 14 rồi thử lại.';
  }
  if (/UnsatisfiedLinkError|dlopen failed|couldn't find "lib|\.so.*not found/i.test(t)) {
    return `${pkg || 'Ứng dụng'} bị sập sau khi khởi chạy: thiếu thư viện native của thiết bị (ứng dụng có thể chỉ có bản ARM). `
      + 'Sẽ tự chuyển sang image tương thích có lớp dịch ARM rồi thử lại.';
  }
  if (/ClassNotFoundException|NoClassDefFoundError|AndroidRuntime/i.test(t)) {
    return `${pkg || 'Ứng dụng'} sập ngay khi khởi chạy (lỗi nội bộ của ứng dụng, có thể liên quan đến môi trường giả lập hoặc thiếu dịch vụ Google).`;
  }
  if (/java\.lang\.SecurityException|Permission Denial/i.test(t)) {
    return `${pkg || 'Ứng dụng'} khởi chạy thất bại: hệ thống từ chối yêu cầu khởi chạy (vấn đề quyền hoặc chữ ký).`;
  }
  return `${pkg || 'Ứng dụng'} không khởi chạy được${t ? `: ${t.slice(0, 240)}` : ' (tiến trình không còn sống)'}`;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Lối vào khởi chạy đã phân giải (adbPath|pkg → activity), hiệu lực 10 phút */
const LAUNCHER_CACHE = new Map();

/**
 * adb bản Windows xử lý đường dẫn không phải ASCII không ổn định (tên người dùng/thư mục tải xuống có Unicode rất phổ biến).
 * Trước khi cài, sao chép APK vào thư mục tạm toàn ASCII, cài xong thì xóa.
 */
function stageApk(apkPath) {
  const p = String(apkPath || '');
  if (/^[\x20-\x7e]*$/.test(p) && p.length < 200) return { path: p, staged: false };
  const dir = path.join(os.tmpdir(), 'apkstart-install');
  fs.mkdirSync(dir, { recursive: true });
  const name = `${crypto.createHash('sha1').update(p).digest('hex').slice(0, 12)}.apk`;
  const target = path.join(dir, name);
  fs.copyFileSync(p, target);
  return { path: target, staged: true };
}

function unstage(staged) {
  if (!staged) return;
  try { fs.rmSync(staged, { force: true }); } catch (_) { /* ignore */ }
}

/**
 * Ghép「Activity」thành component đầy đủ mà am start -n cần.
 * Phải hỗ trợ cả hai dạng:
 *   - Chỉ tên lớp (apps.json bản cũ lưu dạng này): `MainActivity` / `.MainActivity` → `<pkg>/<activity>`
 *   - Component đầy đủ (output của `cmd package resolve-activity`): `com.a.b/.Main` → dùng nguyên
 * Bản cũ luôn ghép `${pkg}/${activity}` vô điều kiện, gặp component đầy đủ thì thành `pkg/pkg/class`,
 * am start hủy luôn (result code=-92), biểu hiện là「bấm biểu tượng chỉ thấy màn hình chính Android」.
 */
function componentArg(pkg, activity) {
  const a = String(activity || '').trim();
  if (!a) return '';
  if (a.includes('/')) return a;
  return `${pkg}/${a}`;
}

/** Lấy component thuộc pkg từ output của `cmd package resolve-activity --brief` (chịu được dòng trống cuối/dòng priority) */
function parseResolvedActivity(pkg, out) {
  const lines = String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const m = /^([\w.]+)\/([.\w$]+)$/.exec(lines[i]);
    if (m && m[1] === pkg) return `${m[1]}/${m[2]}`;
  }
  return '';
}

/**
 * Giới hạn timeout của adb install vốn cố định 240s, nhưng gói cài đặt 2GB+ trên ổ chậm
 *「push + cài + dexopt」rất dễ vượt 4 phút: hết giờ là bị coi như cài thất bại,
 * người dùng thấy「gói lớn cài không phản hồi/thất bại」. Ở đây phóng theo kích thước gói, tối đa 20 phút.
 */
function installTimeoutMs(bytes) {
  const mb = Math.max(1, Number(bytes || 0) / 1048576);
  return Math.min(1200000, Math.max(240000, Math.round(60000 + mb * 120)));
}

class AdbError extends Error {
  constructor(message, stderr, code) {
    super(message);
    this.stderr = stderr;
    this.code = code;
  }
}

/**
 * Phân tích output của `find -exec stat -c '%Y|%s|%n'`.
 * Trả về null nghĩa là output không giống kết quả stat (thiết bị không hỗ trợ).
 */
function parseStatList(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return [];
  const rows = [];
  for (const l of lines) {
    const m = /^(\d{9,})\|(\d+)\|(.+)$/.exec(l);
    if (!m) continue;
    const rel = m[3].replace(/^\.\//, '');
    if (!rel || rel.endsWith('/')) continue;
    rows.push({ rel, size: Number(m[2]), mtime: Number(m[1]) * 1000 });
  }
  // Có output nhưng không phân tích được dòng nào → không phải định dạng stat
  if (!rows.length) return null;
  return rows;
}

class AdbClient {
  constructor({ adbPath, serial }) {
    this.adbPath = adbPath || 'adb';
    this.serial = serial || '';
    this._input = null;        // tiến trình `adb shell` thường trực
    this._inputSeq = 0;
    this._waiters = new Map(); // id -> { resolve, reject, timer, token }
  }

  static resolveAdb(explicit, appRoot) {
    const candidates = [
      explicit,
      appRoot && path.join(appRoot, 'tools', 'platform-tools', 'adb.exe'),
      ...COMMON_ADB_PATHS,
    ].filter(Boolean);
    for (const c of candidates) {
      try { if (fs.existsSync(c)) return c; } catch (_) { /* ignore */ }
    }
    return 'adb'; // để PATH lo
  }

  _args(args, withSerial = true) {
    const a = [];
    if (withSerial && this.serial) a.push('-s', this.serial);
    return a.concat(args);
  }

  _adbEnv() {
    return { ...process.env, ANDROID_ADB_SERVER_PORT: process.env.ANDROID_ADB_SERVER_PORT || '5044' };
  }

  exec(args, { timeout = 30000, withSerial = true, binary = false } = {}) {
    return new Promise((resolve, reject) => {
      const finalArgs = this._args(args, withSerial);
      execFile(this.adbPath, finalArgs, {
        timeout,
        maxBuffer: 64 * 1024 * 1024,
        encoding: binary ? 'buffer' : 'utf8',
        windowsHide: true,
        // Dùng chung cổng adb server riêng (mặc định 5044) với trình giả lập của runtime, tách biệt với
        // adb của WSA / trình giả lập bên thứ ba trên 5037, tránh việc đăng ký bị đá liên tục khiến thiết bị offline
        env: this._adbEnv(),
      }, (err, stdout, stderr) => {
        if (err) {
          // Lý do thất bại của adb install ghi ở stdout và mã thoát khác 0;
          // bản cũ chỉ xem stderr, khiến người dùng mãi chỉ thấy một câu「thất bại」chung chung.
          const text = [stdout, stderr, err.message].filter(Boolean).join('\n').trim();
          const e = new AdbError(`adb ${finalArgs.join(' ')} thất bại: ${text}`, stderr, err.code);
          e.stdout = stdout;
          e.raw = text;
          return reject(e);
        }
        resolve({ stdout, stderr });
      });
    });
  }

  async shell(cmd, opts = {}) {
    const { stdout } = await this.exec(['shell', cmd], opts);
    return typeof stdout === 'string' ? stdout.trim() : stdout;
  }

  /**
   * Kênh nhập liệu thường trực.
   * Cuộn chuột/quay lại là thao tác tần suất cao: mỗi nấc cuộn lại execFile một adb thì sinh cả đống tiến trình,
   * desktop sẽ khựng rõ rệt. Ở đây dùng lại một `adb shell`, mỗi dòng một lệnh, và ở cuối
   * echo một dấu kết thúc —— vừa biết lúc nào lệnh thực sự chạy xong, vừa tự nhiên tạo áp lực ngược,
   * không để lệnh vuốt xếp thành hàng dài trong shell.
   */
  _inputSession() {
    const old = this._input;
    if (old && old.exitCode === null && !old.killed && old.stdin && old.stdin.writable) return old;
    if (old) this.disposeInput();

    const p = spawn(this.adbPath, this._args(['shell'], true), {
      stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env: this._adbEnv(),
    });
    this._input = p;
    let buf = '';
    p.stdout.setEncoding('utf8');
    p.stdout.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        for (const [id, w] of this._waiters) {
          // Cả dòng phải bằng đúng dấu kết thúc: một số shell sẽ echo lại nguyên dòng lệnh,
          // dùng contains sẽ nhận nhầm「vừa ghi vào」thành「đã chạy xong」, lệnh vuốt sẽ dồn ứ.
          if (line === w.token) {
            this._waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(true);
            break;
          }
        }
      }
    });
    p.stderr.on('data', () => { /* bỏ qua: thông tin như thiết bị offline do caller lo */ });
    p.stdin.on('error', () => { /* khi ngắt kết nối thì để exit dọn dẹp chung */ });
    p.on('error', () => { this._failWaiters(new Error('Khởi động adb shell thất bại')); });
    p.on('exit', () => {
      if (this._input === p) this._input = null;
      this._failWaiters(new Error('adb shell đã thoát'));
    });
    return p;
  }

  _failWaiters(err) {
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    this._waiters.clear();
  }

  /** Chạy một lệnh input nằm trong danh sách trắng; lỗi thì thu hồi phiên, caller có thể quay về adb dùng một lần */
  async input(cmd, { timeout = 4000 } = {}) {
    const { isInputCommand } = require('./pointer');
    if (!isInputCommand(cmd)) throw new Error('Lệnh nhập liệu không hợp lệ');
    const p = this._inputSession();
    const id = ++this._inputSeq;
    const token = `__APKSTART_${id}__`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._waiters.delete(id);
        this.disposeInput();
        reject(new Error('Lệnh input quá thời gian chờ'));
      }, timeout);
      this._waiters.set(id, { resolve, reject, timer, token });
      try {
        p.stdin.write(`${cmd}; echo ${token}\n`);
      } catch (e) {
        this._waiters.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  disposeInput() {
    const p = this._input;
    this._input = null;
    for (const [, w] of this._waiters) {
      clearTimeout(w.timer);
      w.reject(new Error('Kênh nhập liệu đã đóng'));
    }
    this._waiters.clear();
    if (p) {
      try { p.stdin.end(); } catch (_) { /* ignore */ }
      try { p.kill(); } catch (_) { /* ignore */ }
    }
  }

  async version() {
    const { stdout } = await this.exec(['version'], { withSerial: false });
    const m = /version\s+([\d.]+)/i.exec(stdout);
    return m ? m[1] : stdout.trim();
  }

  async connect() {
    if (!this.serial.includes(':')) return true;
    try {
      await this.exec(['connect', this.serial], { withSerial: false, timeout: 15000 });
    } catch (_) { /* có thể đã kết nối */ }
    return this.isOnline();
  }

  async isOnline() {
    try {
      const { stdout } = await this.exec(['get-state'], { timeout: 8000 });
      return stdout.trim() === 'device';
    } catch (_) {
      // get-state không dùng được khi chưa chỉ định serial, chuyển sang dùng danh sách devices
      try {
        const { stdout } = await this.exec(['devices'], { withSerial: false, timeout: 8000 });
        return stdout.split('\n').some((l) => l.startsWith(this.serial) && l.includes('device'));
      } catch (_) {
        return false;
      }
    }
  }

  async devices() {
    const { stdout } = await this.exec(['devices', '-l'], { withSerial: false });
    return stdout.split('\n').slice(1)
      .map((l) => l.trim())
      .filter((l) => l && l.includes('device') && !l.startsWith('*'))
      .map((l) => {
        const parts = l.split(/\s+/);
        return { serial: parts[0], state: parts[1], model: (l.match(/model:(\S+)/) || [])[1] || '' };
      })
      .filter((d) => d.state === 'device');
  }

  /**
   * Cài một APK, kèm hạ cấp tự động:
   *  - mặc định bỏ -g (tự cấp toàn bộ quyền trên một số image làm PermissionController sập);
   *  - kèm --bypass-low-target-sdk-block, giải quyết việc Android 14 từ chối cài ứng dụng targetSdk cũ;
   *  - adb không nhận tham số đó / đường dẫn Unicode / lỗi truyền tải thì tự đổi cách viết rồi thử lại;
   *  - NO_MATCHING_ABIS ném lỗi kèm code, để tầng trên tự chuyển image tương thích.
   */
  async install(apkPath) {
    if (!fs.existsSync(apkPath)) throw new Error(`APK không tồn tại: ${apkPath}`);
    const staged = stageApk(apkPath);
    const file = staged.path;
    const variants = [
      // -g tự cấp quyền runtime, bỏ được hộp thoại xin quyền trong ứng dụng; image nào không hỗ trợ thì tự hạ cấp bỏ đi
      ['install', '-r', '-t', '-g', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', '--bypass-low-target-sdk-block', file],
      ['install', '-r', '-t', file],
      ['install', '-r', file],
    ];
    let last = '';
    let timeout = 240000;
    try { timeout = installTimeoutMs(fs.statSync(file).size); } catch (_) { /* không lấy được kích thước thì dùng mặc định */ }
    try {
      for (const args of variants) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(args, { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) {
            throw new Error(String(stdout).trim());
          }
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          last = raw;
          const tag = (/INSTALL_[A-Z_]+/.exec(raw) || [])[0] || '';

          if (tag === 'INSTALL_FAILED_NO_MATCHING_ABIS') {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            err.raw = raw;
            throw err;
          }
          // adb cũ không nhận tham số mới / cờ gói thử nghiệm → đổi cách viết
          if (/Unknown option|unrecognized option|Unknown command/i.test(raw)) continue;
          if (tag === 'INSTALL_FAILED_TEST_ONLY' || tag === 'INSTALL_FAILED_DEPRECATED_SDK_VERSION') continue;
          // Lỗi truyền tải (thiết bị rớt kết nối, adb server khởi động lại) thì thử lại một lần
          if (/device (not found|offline)|closed|protocol fault|no devices/i.test(raw)) {
            // eslint-disable-next-line no-await-in-loop
            await sleep(1500);
            continue;
          }
          if (tag) {
            const err = new Error(friendlyInstallError(raw));
            err.code = tag;
            err.raw = raw;
            throw err;
          }
          // Không có mã lỗi rõ ràng: thử tiếp cách viết cuối
        }
      }
      const err = new Error(friendlyInstallError(last || 'Cài đặt thất bại, không rõ nguyên nhân'));
      err.code = (/INSTALL_[A-Z_]+/.exec(last) || [])[0] || 'INSTALL_UNKNOWN';
      err.raw = last;
      throw err;
    } finally {
      unstage(staged.staged ? file : null);
    }
  }

  /** APK tách (nhiều phân mảnh giải ra từ .apks / .xapk) đi qua install-multiple */
  async installMultiple(apkPaths) {
    if (!apkPaths || !apkPaths.length) throw new Error('Không có APK phân mảnh nào để cài');
    const staged = apkPaths.map((p) => stageApk(p));
    const files = staged.map((s) => s.path);
    const totalBytes = staged.reduce((n, s) => n + (fs.existsSync(s.path) ? fs.statSync(s.path).size : 0), 0);
    const timeout = installTimeoutMs(totalBytes);
    try {
      for (const extra of [['-r', '-t', '--bypass-low-target-sdk-block'], ['-r', '-t']]) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const { stdout } = await this.exec(['install-multiple', ...extra, ...files], { timeout });
          if (/Failure|Error/i.test(stdout) && !/Success/i.test(stdout)) throw new Error(stdout);
          return stdout.trim();
        } catch (e) {
          const raw = String(e.raw || e.stdout || e.message || '');
          if (/Unknown option|unrecognized option/i.test(raw)) continue;
          if (/INSTALL_FAILED_NO_MATCHING_ABIS/.test(raw)) {
            const err = new Error(friendlyInstallError(raw));
            err.code = 'NO_MATCHING_ABIS';
            throw err;
          }
          throw new Error(friendlyInstallError(raw));
        }
      }
      throw new Error('Cài APK tách thất bại');
    } finally {
      staged.forEach((s) => unstage(s.staged ? s.path : null));
    }
  }

  async uninstall(pkg) {
    try {
      await this.exec(['uninstall', pkg], { timeout: 60000 });
    } catch (e) {
      // Một số thiết bị cần chỉ định user
      await this.exec(['shell', 'pm', 'uninstall', '--user', '0', pkg], { timeout: 60000 });
    }
  }

  async isInstalled(pkg) {
    const out = await this.shell(`pm path ${pkg}`);
    return /package:/.test(out);
  }

  async listPackages() {
    const out = await this.shell('pm list packages -3');
    return out.split('\n').map((l) => l.replace('package:', '').trim()).filter(Boolean);
  }

  /** Phân giải Activity khởi chạy thật từ hệ thống (phương án dự phòng khi không phân giải được từ manifest) */
  /** Sau khi nâng cấp ứng dụng lối vào có thể đổi, trước khi phân giải hãy gỡ gói này khỏi cache */
  clearLauncherCache(pkg) {
    if (!pkg) { LAUNCHER_CACHE.clear(); return; }
    LAUNCHER_CACHE.delete(`${this.adbPath}|${pkg}`);
  }

  async resolveLauncher(pkg) {
    // Phân giải Activity lối vào cần một lượt khứ hồi adb (~200-400ms), mà trong một phiên khởi chạy nó không đổi.
    // Lưu cache lại, lần thứ hai bấm cùng ứng dụng thì bỏ qua; 10 phút sau tự hết hạn, cài lại ứng dụng cũng không dùng nhầm lối vào.
    const key = `${this.adbPath}|${pkg}`;
    const hit = LAUNCHER_CACHE.get(key);
    if (hit && Date.now() - hit.at < 10 * 60 * 1000) return hit.value;
    try {
      const out = await this.shell(
        `cmd package resolve-activity --brief ${pkg}`, { timeout: 10000 },
      );
      const comp = parseResolvedActivity(pkg, out);
      if (comp) {
        LAUNCHER_CACHE.set(key, { value: comp, at: Date.now() });
        return comp;
      }
    } catch (_) { /* chuyển sang monkey */ }
    return null;
  }

  /** Ứng dụng có thực sự còn sống không: am start báo thành công ≠ tiến trình không sập */
  async waitAppAlive(pkg, timeoutMs = 12000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      // eslint-disable-next-line no-await-in-loop
      const pid = await this.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
      if (String(pid).trim()) return { ok: true };
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    let crash = '';
    try {
      crash = await this.shell(
        `logcat -d -t 250 -v brief AndroidRuntime:E DEBUG:E libc:E 2>/dev/null | `
        + `grep -i -E '${pkg}|FATAL|ndk_translation|SIGABRT|SIGSEGV|UnsatisfiedLink' | tail -n 30`,
        { timeout: 12000 },
      );
    } catch (_) { /* ignore */ }
    const text = String(crash || '').trim();
    // Không có log sập thì không được khẳng định thất bại: một số ứng dụng lớn lần đầu khởi chạy mất 20-40 giây
    return { ok: false, crash: text, uncertain: !text };
  }

  /**
   * Khởi chạy ứng dụng, kèm hạ cấp ba mức:
   *   cửa sổ độc lập freeform → toàn màn hình thường → monkey dự phòng;
   * mỗi lần đều xác minh tiến trình còn sống, sập thì lấy logcat và ném lỗi kèm code để tầng trên tự đổi image.
   */
  async startApp(pkg, activity, { freeform = true, bounds = null, forceStop = false } = {}) {
    if (forceStop) await this.forceStop(pkg);
    // Phải dùng lối vào LAUNCHER do hệ thống phân giải, không được chỉ dùng Activity chính phân giải từ APK:
    // nhiều ứng dụng (như Hồng Quả đoản kịch) chỉ khởi tạo thật sự ở trang khởi động, vào thẳng Activity chính sẽ
    // ném "had you called RpcService.init", biểu hiện là bấm mở chớp một cái rồi mất.
    const resolved = (await this.resolveLauncher(pkg).catch(() => '')) || activity;
    // resolved có thể là component đầy đủ (pkg/class), cũng có thể chỉ là tên lớp (apps.json cũ);
    // ở đây thống nhất thành component đầy đủ mà am start -n cần, tránh pkg/pkg/class bị hệ thống hủy.
    const comp = componentArg(pkg, resolved);
    const intent = comp
      ? ['-n', comp]
      : ['-a', 'android.intent.action.MAIN', '-c', 'android.intent.category.LAUNCHER', '-p', pkg];
    const modes = freeform
      ? [['--windowingMode', '5'], []]
      : [[]];
    let lastError = '';

    for (const mode of modes) {
      const parts = ['am', 'start', ...mode, '--activity-clear-top', ...intent];
      let out = '';
      try {
        // eslint-disable-next-line no-await-in-loop
        out = await this.shell(parts.join(' '), { timeout: 20000 });
      } catch (e) {
        lastError = String(e.message || e);
        continue;
      }
      if (/Error|Exception/i.test(out)) { lastError = out; continue; }

      if (bounds) this.resizeTaskOfPackage(pkg, bounds).catch(() => {});
      // eslint-disable-next-line no-await-in-loop
      const alive = await this.waitAppAlive(pkg, 6000);
      if (alive.ok) return out;
      if (alive.uncertain) return `${out}\n(ứng dụng vẫn đang tải)`;
      lastError = alive.crash || lastError;
      // Log sập chỉ rõ về lớp dịch ARM thì không thử lại nữa, giao thẳng cho tầng trên đổi image tương thích
      if (/DoBadTrampoline|libndk_translation|UnsatisfiedLinkError|dlopen failed/i.test(alive.crash || '')) {
        const err = new Error(friendlyLaunchError(alive.crash, pkg));
        err.code = 'APP_CRASHED';
        err.crash = alive.crash;
        throw err;
      }
    }

    // monkey dự phòng: am start -a/-c/-p trên một số image không phân giải được launcher
    try {
      const out = await this.shell(
        `monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`, { timeout: 20000 },
      );
      const alive = await this.waitAppAlive(pkg, 12000);
      if (alive.ok || alive.uncertain) return out;
      lastError = alive.crash || lastError;
    } catch (e) {
      // Có thông tin sập rõ ràng thì ưu tiên dùng, không thì giữ lỗi khởi chạy gốc
      if (!lastError) lastError = String(e.message || e);
    }

    if (!lastError) return 'started';
    const err = new Error(friendlyLaunchError(lastError, pkg));
    err.code = 'APP_CRASHED';
    err.crash = lastError;
    throw err;
  }

  async forceStop(pkg) {
    try { await this.shell(`am force-stop ${pkg}`); } catch (_) { /* ignore */ }
  }

  async runningPackages() {
    try {
      const out = await this.shell('dumpsys activity activities | grep -E "mResumedActivity|ResumedActivity"');
      const pkgs = [...out.matchAll(/([a-zA-Z][\w.]+\/[.\w$]+)/g)].map((m) => m[1].split('/')[0]);
      return [...new Set(pkgs)];
    } catch (_) {
      return [];
    }
  }

  async taskIdOfPackage(pkg) {
    try {
      const out = await this.shell('dumpsys activity recents');
      const blocks = out.split('Recent #');
      for (const b of blocks) {
        if (!b.includes(pkg)) continue;
        const m = /taskId=(\d+)/.exec(b) || /^\d+/.exec(b);
        if (m) return Number(m[1] || m[0]);
      }
    } catch (_) { /* ignore */ }
    return null;
  }

  async resizeTaskOfPackage(pkg, bounds) {
    const id = await this.taskIdOfPackage(pkg);
    if (!id) return false;
    await this.shell(`am task resize ${id} ${bounds.left} ${bounds.top} ${bounds.right} ${bounds.bottom}`);
    return true;
  }

  /** Bật hỗ trợ freeform (cửa sổ độc lập), lỗi không ảnh hưởng luồng chính */
  async ensureFreeform() {
    // Gộp thành một lần adb shell: 4 lần execFile riêng trên Windows mất 600ms+,
    // mà đoạn này nằm đúng trong thời gian chờ「bấm mở ứng dụng」.
    const out = await this.shell(
      'settings put global enable_freeform_support 1 ; '
      + 'settings put global force_resizable_activities 1 ; '
      + 'settings put global development_settings_enabled 1 ; '
      + 'settings get global enable_freeform_support',
      { timeout: 12000 },
    ).catch(() => '0');
    return String(out).trim().split(/\r?\n/).pop().trim() === '1';
  }

  async wmSize() {
    const out = await this.shell('wm size');
    const m = /(\d+)x(\d+)/.exec(out.split('\n').pop() || out);
    return m ? { width: Number(m[1]), height: Number(m[2]) } : null;
  }

  async androidVersion() {
    return (await this.shell('getprop ro.build.version.release').catch(() => '')).trim();
  }

  async sdkInt() {
    const v = await this.shell('getprop ro.build.version.sdk').catch(() => '0');
    return Number(v.trim()) || 0;
  }

  async screenshot() {
    const { stdout } = await this.exec(['exec-out', 'screencap', '-p'], { binary: true, timeout: 20000 });
    return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
  }

  async push(local, remote) {
    await this.exec(['push', local, remote], { timeout: 180000 });
  }

  async pull(remote, local) {
    await this.exec(['pull', remote, local], { timeout: 180000 });
  }

  async shellMkdir(remote) {
    await this.shell(`mkdir -p "${remote}"`);
  }

  async listRemote(remote) {
    const out = await this.shell(`ls -l "${remote}" 2>/dev/null`);
    return String(out).split('\n').map((line) => {
      const l = line.trim();
      if (!l || l.startsWith('total ')) return null;
      // ls -l của Android có hai định dạng「có group」và「không có group」, ngày có thể là
      // "2026-11-12 18:52" hoặc "Nov 12 18:52", dùng regex cố định sẽ không phân tích được gì.
      // Số thứ 2 sau cột quyền chính là kích thước tệp, đoạn cuối cùng là tên tệp.
      const parts = l.split(/\s+/);
      if (parts.length < 6 || !/^[\-dl]/.test(parts[0])) return null;
      const sizeIdx = parts.findIndex((p, i) => i >= 2 && /^\d+$/.test(p)
        && /(\d{4}-\d{2}-\d{2}|^[A-Za-z]{3}$)/.test(parts[i + 1] || ''));
      if (sizeIdx < 0) return null;
      const size = Number(parts[sizeIdx]);
      // Tên tệp nằm sau token「giờ:phút」(đoạn ngày gồm 2-3 token, không cố định)
      const timeIdx = parts.findIndex((p, i) => i > sizeIdx && /^\d{1,2}:\d{2}(:\d{2})?$/.test(p));
      const name = parts.slice((timeIdx >= 0 ? timeIdx : sizeIdx + 2) + 1).join(' ');
      return name ? { isDir: parts[0][0] === 'd', size, name } : null;
    }).filter(Boolean);
  }

  /**
   * Danh sách phía thiết bị kèm mtime thật (toybox stat).
   * Ngày của ls -l là「tháng ngày giờ:phút」, không quy đổi tin cậy được, khiến đồng bộ nhận nhầm là「lần nào cũng thay đổi」.
   * Trả về null nghĩa là thiết bị không hỗ trợ stat, caller nên quay về listRemote.
   */
  async listRemoteStat(remote) {
    let out = '';
    try {
      out = await this.shell(`cd "${remote}" 2>/dev/null && find . -type f -exec stat -c '%Y|%s|%n' {} + 2>/dev/null`);
    } catch (_) {
      return null;
    }
    const rows = parseStatList(out);
    if (!rows) return null;
    return rows;
  }

  /** Xóa dữ liệu ứng dụng */
  async clearData(pkg) {
    await this.shell(`pm clear ${pkg}`);
  }

  /** Xuất dữ liệu ứng dụng (bản Windows/debug dùng được run-as; nếu không thì dự phòng bằng adb backup) */
  async exportAppData(pkg, localTarPath) {
    const remote = `/sdcard/apkstart-tmp-${pkg}.tar`;
    const cmd = `run-as ${pkg} tar -cf ${remote} . 2>/dev/null || (cd /data/data/${pkg} && tar -cf ${remote} .)`;
    await this.shell(cmd);
    await this.pull(remote, localTarPath);
    await this.shell(`rm -f ${remote}`).catch(() => {});
    return localTarPath;
  }

  async batteryOptimizeOff(pkg) {
    try { await this.shell(`dumpsys deviceidle whitelist +${pkg}`); } catch (_) { /* ignore */ }
  }

  /**
   * Cấp một lần toàn bộ quyền runtime mà ứng dụng xin.
   * Không cấp sẽ có hai hậu quả: ① lần đầu khởi chạy hiện hộp thoại cấp quyền của hệ thống, người dùng thấy「ứng dụng không mở」;
   * ② sau khi xóa dữ liệu (pm clear) quyền bị mất, ứng dụng mở lên kẹt ở trang cấp quyền.
   */
  async grantRuntimePermissions(pkg) {
    let dump = '';
    try {
      dump = await this.shell(`dumpsys package ${pkg}`, { timeout: 20000 });
    } catch (_) {
      return [];
    }
    const lines = String(dump).split(/\r?\n/);
    let inRuntime = false;
    const denied = [];
    for (const line of lines) {
      if (/^\s*runtime permissions:/.test(line)) { inRuntime = true; continue; }
      if (!inRuntime) continue;
      if (/^\s{0,6}\S/.test(line)) break; // rời khỏi đoạn runtime permissions
      const m = /^\s+([A-Za-z0-9_.]+):\s*granted=(\w+)/.exec(line);
      if (m && m[2] === 'false') denied.push(m[1]);
    }
    const granted = [];
    // Cấp quyền gửi một lần: mỗi lệnh pm grant một tiến trình trên Windows mất 150ms+,
    // bốn năm quyền là 1 giây, mà các lệnh này hoàn toàn không phụ thuộc nhau.
    const cmds = [];
    for (const p of denied) cmds.push(`pm grant ${pkg} ${p}`);
    // Quyền đặc biệt đi qua appops, nếu không vẫn sẽ hiện hộp thoại
    const ops = ['MANAGE_EXTERNAL_STORAGE', 'SYSTEM_ALERT_WINDOW', 'REQUEST_INSTALL_PACKAGES', 'WRITE_SETTINGS'];
    for (const op of ops) cmds.push(`cmd appops set ${pkg} ${op} allow`);
    if (cmds.length) {
      await this.shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
      granted.push(...denied);
    }
    return granted;
  }

  /**
   * Vào trạng thái「chính là ứng dụng này」:
   *  - tắt màn hình khóa, tránh khởi động xong dừng ở màn hình khóa che mất ứng dụng;
   *  - ẩn thanh trạng thái (giữ phím điều hướng dưới cùng, không có chuột bên cạnh vẫn bấm được quay lại/màn hình chính);
   *  - tắt hiệu ứng động hệ thống, trên máy cấu hình thấp cảm nhận khác biệt rất lớn.
   * Toàn bộ là lệnh cấp settings, mỗi lần vài trăm mili giây, gọi lặp lại vô hại.
   */
  async prepareForeground() {
    // Trước đây gửi tuần tự 7 lệnh, mỗi lệnh lại khởi một tiến trình adb mới (trên Windows 150~250ms),
    // tổng cộng 1~1.7 giây, dồn hết vào thời gian chờ「bấm mở ứng dụng」. Gộp thành một shell thì chỉ còn một lượt khứ hồi.
    const cmds = [
      'wm dismiss-keyguard',
      'settings put global policy_control immersive.status=*',
      'settings put secure immersive_mode_confirmations confirmed',
      'settings put global window_animation_scale 0',
      'settings put global transition_animation_scale 0',
      'settings put global animator_duration_scale 0',
      'settings put system screen_off_timeout 2147483647',
      // Lưu ý: ở đây đừng ghi thêm wm user-rotation / accelerometer_rotation.
      // Hướng màn hình do setOrientation / resetDisplayOverrides định thống nhất theo trạng thái ngang/dọc hiện tại,
      // ghi cứng lock 0 ở đây sẽ ghi đè hướng ngang về dọc (hình bị nằm nghiêng).
    ];
    await this.shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => {});
    return true;
  }

  /** Ánh xạ chuột phải / phím bên / phím tắt: đi qua kênh nhập liệu thường trực, chuột phải quay lại không còn trễ cỡ 100ms */
  async _key(code) {
    try {
      await this.input(`input keyevent ${code}`);
    } catch (_) {
      // Runtime vừa khởi động lại, shell thường trực chưa kết nối thì quay về adb dùng một lần, không được làm mất lần bấm này
      await this.shell(`input keyevent ${code}`, { timeout: 6000 }).catch(() => {});
    }
  }

  async keyBack() { return this._key(4); }
  async keyForward() { return this._key(125); }

  /**
   * Chuyển「bố cục điện thoại / bố cục máy tính bảng」.
   *
   * Mấu chốt: **tuyệt đối không đổi wm size**. Đổi wm size sẽ đổi kích thước vật lý của guest framebuffer
   * (720x1280 -> 1280x720), mà cửa sổ Qt nhúng vẫn giữ kích thước/hướng cũ, nên hình bị
   * ép dẹt hoặc nằm nghiêng 90°, ánh xạ tọa độ chuột cũng loạn theo. Tệ hơn, ghi đè wm size được lưu bền
   * trong /data, khởi động lại vẫn còn hiệu lực —— đây chính là gốc rễ của việc người dùng cứ thấy「viền đen / không phủ kín / bấm không ăn」.
   *
   * Giờ chỉ đổi mật độ logic (wm density), framebuffer luôn là 720x1280 đứng thẳng:
   *   - 320dpi -> smallestWidth 360dp -> bố cục điện thoại
   *   - 190dpi -> smallestWidth 606dp (>=600dp) -> bố cục máy tính bảng / chia cột
   * Kích thước, hướng, ánh xạ chạm đều không đổi, nên không bị nằm nghiêng, không có viền đen, chạm luôn đúng chỗ.
   */
  async setOrientation(landscape) {
    try {
      // Xoay tự động bắt buộc phải tắt (nếu không cảm biến sẽ xoay lung tung), nhưng user_rotation phải khóa theo hướng mục tiêu:
      // sau khi tấm nền vật lý đổi thành 1280x720, chỉ khi khóa user-rotation thành 1 (90°)
      // Android mới bố cục theo hướng ngang —— nếu không nó vẫn render nội dung dọc theo rotation 0,
      // Qt dán vào cửa sổ ngang thành ra「nằm nghiêng 90°」.
      await this.shell('settings put system accelerometer_rotation 0; wm size reset', { timeout: 15000 });
      await this.shell(`wm user-rotation lock ${landscape ? 1 : 0}`, { timeout: 15000 });
      await this.shell(landscape ? 'wm density 190' : 'wm density reset', { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Khi khởi động, xóa ghi đè wm size / density còn sót từ bản cũ (lưu bền trong /data, sẽ nằm nghiêng mãi) */
  async resetDisplayOverrides(landscape = false) {
    try {
      await this.shell('wm size reset; wm density reset', { timeout: 15000 });
      await this.shell('settings put system accelerometer_rotation 0', { timeout: 15000 });
      await this.shell(`wm user-rotation lock ${landscape ? 1 : 0}`, { timeout: 15000 });
      return true;
    } catch (_) {
      return false;
    }
  }

  /** Độ phân giải logic hiện tại (sau khi chuyển ngang, cửa sổ phải tính tỉ lệ khung hình theo nó) */
  async displaySize() {
    try {
      const out = await this.shell('wm size', { timeout: 8000 });
      const o = /Override size:\s*(\d+)x(\d+)/.exec(out);
      if (o) return { w: Number(o[1]), h: Number(o[2]) };
      const p = /Physical size:\s*(\d+)x(\d+)/.exec(out);
      if (p) return { w: Number(p[1]), h: Number(p[2]) };
    } catch (_) { /* ignore */ }
    return null;
  }

  /** Khi hộp thoại cấp quyền vẫn treo trên cùng (người dùng không ngồi máy cũng tự hồi phục), bấm phím quay lại để đóng */
  async dismissPermissionDialog() {    try {
      const top = await this.shell('dumpsys activity activities', { timeout: 12000 });
      if (/GrantPermissionsActivity|permissioncontroller/i.test(String(top))) {
        await this.shell('input keyevent 4', { timeout: 6000 }).catch(() => {});
        return true;
      }
    } catch (_) { /* ignore */ }
    return false;
  }

  /**
   * Thích ứng hiển thị: khi toàn màn hình đổi độ phân giải Android thành kích thước màn hình (nội dung tự phủ kín),
   * ở chế độ cửa sổ thì khôi phục thiết lập dọc. Lệnh wm có hiệu lực lúc chạy, không cần khởi động lại Android.
   */
  async setDisplaySize(width, height, density) {
    const w = Math.max(320, Math.round(Number(width) || 0));
    const h = Math.max(480, Math.round(Number(height) || 0));
    await this.shell(`wm size ${w}x${h}`);
    if (density) await this.shell(`wm density ${Math.max(120, Math.min(640, Math.round(density)))}`);
    return { w, h };
  }

  async resetDisplaySize() {
    await this.shell('wm size reset').catch(() => {});
    await this.shell('wm density reset').catch(() => {});
  }
}

module.exports = {
  AdbClient, AdbError, parseStatList, friendlyInstallError, friendlyLaunchError,
  componentArg, parseResolvedActivity,
};
