'use strict';
/**
 * Engine Emulator: điều khiển Android Emulator chính thức của Google làm runtime cho ApkStart.
 *
 * Khác biệt lớn nhất so với bản cũ: không còn giả định「một bộ tham số chạy được trên mọi máy」.
 *  1. Dùng doctor.chooseProfile() tự suy ra tham số theo RAM/CPU/ổ đĩa/trạng thái tăng tốc/phiên bản engine;
 *  2. Khởi động thất bại thì tự hạ cấp và thử lại theo planVariants() (backend GPU → giả lập phần mềm → khởi động nguội với RAM tối thiểu);
 *  3. Tự chọn cổng trống, dọn khóa AVD, đổi đường dẫn tiếng Trung sang đường dẫn ngắn, tự hủy snapshot khi image thay đổi;
 *  4. Snapshot quickboot + phân vùng dữ liệu nhỏ, để「như container」dùng chung lớp nền chỉ đọc và khôi phục trong vài giây.
 *
 * Callback probe do tầng trên (Runtime) cung cấp, dùng để xác định Android đã thực sự sẵn sàng hay chưa.
 */
const { spawn, spawnSync, execFile } = require('child_process');
const fs = require('fs');
const path = require('path');
const store = require('./store');
const { Provisioner } = require('./provision');
const doctor = require('./doctor');
const userdata = require('./userdata');

const AVD_NAME = 'apkstart';
const SNAPSHOT_NAME = 'apkstart';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Dịch mã thoát của emulator/qemu trên Windows sang ngôn ngữ dễ hiểu.
 * 0xC0000005 (3221225477) là mã crash phổ biến nhất: vi phạm truy cập, thực tế đa phần do
 * driver card đồ họa / backend Vulkan crash ngay lúc guest khởi động; chuyển sang render phần mềm là tránh được.
 */
function describeExitCode(code) {
  // Khi bị kết thúc bằng tín hiệu thì code là null (trên Windows qua taskkill / adb emu kill đều vậy),
  // không thể coi là 0 để báo「thoát bình thường」, nhưng cũng chẳng phải bất thường; trả chuỗi rỗng để bên gọi hiển thị nguyên trạng.
  if (code == null) return '';
  switch (Number(code)) {
    case 0: return 'thoát bình thường';
    case 1: return 'lỗi tham số khởi động hoặc môi trường';
    case 3221225477: return '0xC0000005 vi phạm truy cập, backend render bị crash';
    case 3221225725: return '0xC00000FD tràn ngăn xếp';
    case 3221225781: return '0xC0000135 thiếu DLL (thư viện VC++ / thành phần runtime bị phần mềm diệt virus xóa)';
    case 3221225506: return '0xC0000022 truy cập bị từ chối (lỗi driver hoặc quyền)';
    case 3221225595: return '0xC000007B image sai kiến trúc bit hoặc DLL bị hỏng';
    default: return '';
  }
}

class EmulatorEngine {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.proc = null;
    this._log = [];
    this.port = 5554;
    this.adbPort = Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044;
    this.profile = null;
    this.attempts = [];
    this.lastDiagnosis = null;
    this.lastExitCode = null;
    // ram.bin của snapshot ≈ bộ nhớ cấp cho máy ảo (2-4GB).
    // Máy khởi động nguội vốn đã nhanh thì không nên tốn vài GB ổ đĩa cho nó; chỉ lưu khi「thật sự chậm」.
    this.snapshotWorthSaving = null;
  }

  log(line) {
    this._log.push({ t: Date.now(), line });
    if (this._log.length > 600) this._log.shift();
  }

  get settings() { return store.getSettings(); }

  /**
   * Ghi「lần khởi động thất bại gần nhất」xuống đĩa.
   * Bản cũ chỉ giữ trong bộ nhớ (this.attempts); người dùng khởi động lại ApkStart rồi mới xuất báo cáo chẩn đoán,
   * thì báo cáo chỉ có attempts: [], bootLog: [] trống trơn, phải lục trong log — đây cũng là
   * nguyên nhân trực tiếp của「đính kèm báo cáo mà không thấy nguyên nhân」trong issue #20/#25.
   */
  _persistFailure(extra = {}) {
    try {
      const dir = path.join(store.DATA_DIR, 'logs');
      fs.mkdirSync(dir, { recursive: true });
      const data = {
        at: new Date().toISOString(),
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
        diagnosis: this.lastDiagnosis,
        attempts: this.attempts,
        ...extra,
      };
      fs.writeFileSync(path.join(dir, 'last-failure.json'), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* Ghi đĩa thất bại không ảnh hưởng luồng chính */ }
  }

  /** Đọc lại bản ghi thất bại lần trước (dùng cho báo cáo chẩn đoán / cảnh báo trước khi khởi động) */
  lastFailure() {
    try {
      return JSON.parse(fs.readFileSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), 'utf8'));
    } catch (_) { return null; }
  }

  _clearFailure() {
    try { fs.rmSync(path.join(store.DATA_DIR, 'logs', 'last-failure.json'), { force: true }); } catch (_) { /* ignore */ }
  }

  get serial() { return `emulator-${this.port}`; }

  /** Thư mục emulator.exe và system image (ưu tiên thư mục runtime của người dùng, dự phòng engine/ trong repo) */
  locate() {
    const p = this.provisioner.paths();
    const emuCandidates = [p.emulatorExe, path.join(this.appRoot, 'engine', 'emulator', 'emulator.exe')];
    const emulatorExe = emuCandidates.find((c) => fs.existsSync(c)) || '';
    const img = this.provisioner.systemImageInfo();
    return { emulatorExe, sysImgDir: img.dir, sysImgOk: img.ok, root: emulatorExe ? path.dirname(path.dirname(emulatorExe)) : p.root };
  }

  /** Chọn image: có image chung (API 34 Play) thì dùng, không bắt người dùng chuyển「chế độ tương thích」nữa */
  imageChoice() {
    const play = this.provisioner.playImageInfo();
    const base = this.provisioner.systemImageInfo();
    if (play.ok) {
      return { compat: true, api: play.api, tag: play.tag, dir: play.dir, abi: 'x86_64' };
    }
    return { compat: false, api: base.api, tag: base.tag, dir: base.dir, abi: base.abi || this.provisioner.paths().sysAbi };
  }

  /**
   * Hủy snapshot quickboot.
   * Snapshot lưu cả bộ nhớ lẫn image đĩa; sau khi cài ứng dụng mới / xóa dữ liệu mà vẫn nạp snapshot cũ,
   * người dùng sẽ thấy「ứng dụng vừa cài xong khởi động lại thì biến mất」.
   */
  invalidateSnapshot() {
    this.cancelSnapshotSave();
    this._snapSaved = false;
    try {
      const snapDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots');
      fs.rmSync(snapDir, { recursive: true, force: true });
      return true;
    } catch (_) {
      return false;
    }
  }

  /**
   * Dọn khóa còn sót lại sau lần thoát bất thường trước.
   * Lưu ý hardware-qemu.ini.lock là **thư mục** chứ không phải file, rmSync(force) kiểu bsdtar không xóa được nó,
   * khiến emulator cứ báo "Running multiple emulators with the same AVD" và không khởi động được
   * (chỉ cần bị kill cưỡng bức một lần là bị vậy), phải xóa đệ quy.
   */
  clearLocks(avdDir) {
    try {
      for (const f of fs.readdirSync(avdDir)) {
        if (!/\.lock$/i.test(f)) continue;
        try {
          fs.rmSync(path.join(avdDir, f), { recursive: true, force: true });
        } catch (_) { /* Đang bị chiếm thì bỏ qua, lần sau dọn */ }
      }
    } catch (_) { /* ignore */ }
  }

  /**
   * Thư mục AVD có thực sự chứa một snapshot quickboot **hoàn chỉnh** hay không.
   * Chỉ kiểm tra「thư mục không rỗng」là chưa đủ: lưu bị ngắt giữa chừng sẽ để lại vỏ rỗng chỉ có snapshot.pb 12 byte,
   * emulator sẽ thử nạp, thất bại (log "does not have the requested snapshot") rồi quay về khởi động nguội,
   * phí mất vài giây. Ở đây kiểm theo kích thước file, tiện tay dọn luôn vỏ rỗng và default_boot sót từ bản cũ (mỗi cái 3GB).
   */
  hasSnapshot() {
    const base = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME);
    const size = (p) => { try { return fs.statSync(p).size; } catch (_) { return 0; } };
    const pb = size(path.join(base, 'snapshot.pb'));
    // Emulator bản mới (37.x) ghi ram.bin, bản cũ ghi ram.img.
    // Chỉ nhận ram.img thì hậu quả rất nghiêm trọng: snapshot 3GB vừa lưu xong sẽ bị coi là vỏ rỗng và bị xóa,
    // thế là lần nào cũng kèm -no-snapshot-load, luôn khởi động nguội — đây là một nửa nguyên nhân「mở rất chậm」.
    const ram = Math.max(size(path.join(base, 'ram.bin')), size(path.join(base, 'ram.img')));
    if (pb > 1024 && ram > 1024 * 1024) return true;
    if (pb === 0 && ram === 0) return false;   // Thư mục vốn không có gì, khỏi xóa
    try { fs.rmSync(base, { recursive: true, force: true }); } catch (_) { /* ignore */ }
    this._cleanLegacySnapshots();
    return false;
  }

  /** Dọn thư mục snapshot sót từ bản cũ / đổi tên thất bại (ram.img trong default_boot có thể tới 3GB) */
  _cleanLegacySnapshots() {
    const dir = path.dirname(path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`, 'snapshots', SNAPSHOT_NAME));
    let names = [];
    try { names = fs.readdirSync(dir); } catch (_) { return; }
    for (const name of names) {
      if (name === SNAPSHOT_NAME) continue;
      if (/^default_boot$|\.stale-\d+$/i.test(name)) {
        try { fs.rmSync(path.join(dir, name), { recursive: true, force: true }); } catch (_) { /* ignore */ }
      }
    }
  }

  /**
   * Dọn các emulator mồ côi đang giữ khóa AVD.
   * emulator.exe chỉ là trình khởi chạy, qemu thật được spawn thành tiến trình độc lập (detached),
   * nên chỉ kill handle proc của mình thì thường để lại một tiến trình mồ côi giữ multiinstance.lock,
   * lần khởi động sau sẽ FATAL "Running multiple emulators with the same AVD".
   * Dọn theo hai nguồn:「pid trong khóa AVD」+「qemu/emulator có tên AVD này trên dòng lệnh」.
   */
  async killOrphanProcesses({ onLog = () => {} } = {}) {
    if (process.platform !== 'win32') return 0;
    const avdDir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);

    // Đường nhanh (lần khởi động nguội nào cũng đi qua):
    //  - Không có .lock → không thể có emulator còn sống giữ AVD này, trả về luôn;
    //  - Có lock nhưng cổng không ai lắng nghe → chỉ là thư mục sót lại sau lần kill cưỡng bức, dọn là xong.
    // Trước đây trường hợp nào cũng chạy wmic (1~3 giây, lại rất tốn CPU), làm khởi động nguội chậm rõ rệt.
    let locks = [];
    try { locks = fs.readdirSync(avdDir).filter((f) => /\.lock$/i.test(f)); } catch (_) { locks = []; }
    if (!locks.length) return 0;
    if (!(await this._anyEmulatorPortAlive())) {
      this.clearLocks(avdDir);
      return 0;
    }

    const pids = new Set();
    // 1) pid do chính emulator ghi trong file khóa (đáng tin nhất)
    try {
      const f = path.join(avdDir, 'hardware-qemu.ini.lock', 'pid');
      if (fs.existsSync(f) && fs.statSync(f).isFile()) {
        const pid = parseInt(fs.readFileSync(f, 'utf8').trim(), 10);
        if (pid) pids.add(pid);
      }
    } catch (_) { /* ignore */ }
    // 2) Dự phòng: tìm qemu còn sống theo tên tiến trình + cổng (tasklist/netstat nhanh hơn wmic cả bậc)
    try {
      const [tl, ns] = await Promise.all([
        new Promise((res) => execFile('tasklist', ['/FO', 'CSV', '/NH'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
        new Promise((res) => execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (e, o) => res(e ? '' : String(o || '')))),
      ]);
      const qemuPids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) qemuPids.add(m[2]);
      }
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && qemuPids.has(m[2])) pids.add(Number(m[2]));
      }
    } catch (_) { /* Không lấy được danh sách tiến trình thì chỉ dựa vào pid trong file khóa */ }
    pids.delete(process.pid);
    if (!pids.size) {
      this.clearLocks(avdDir);
      return 0;
    }
    onLog(`Dọn ${pids.size} tiến trình emulator còn sót`);
    await Promise.all([...pids].map((pid) => new Promise((r) => {
      execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => r());
    })));
    await sleep(1200);
    this.clearLocks(avdDir);
    return pids.size;
  }

  /** Có cổng console emulator nào trong 5554~5620 đang lắng nghe không (kết nối bị từ chối trả về ngay, chi phí rất nhỏ) */
  async _anyEmulatorPortAlive() {
    const net = require('net');
    const probe = (port) => new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(120, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await probe(port)) return true;
    }
    return false;
  }

  /**
   * Chuẩn bị AVD: ghi config.ini. Mỗi lần khởi động ghi lại theo cấu hình tự động hiện tại, để hạ cấp/thử lại có hiệu lực ngay.
   */
  ensureAvd({
    memoryMB = 2048, cores = 2, gpu = 'software', dataMB = 4096,
    heapMB = 256, accel = 'auto', snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const p = this.provisioner.ensureDirs();
    const home = p.avdHome;
    const avdDir = path.join(home, `${AVD_NAME}.avd`);
    fs.mkdirSync(avdDir, { recursive: true });
    this.clearLocks(avdDir);

    // Độ phân giải màn hình: có tăng tốc phần cứng thì 720x1280@320 hình rõ, chữ không nhòe;
    // giả lập thuần phần mềm thì hạ xuống 540x960, ưu tiên khung hình (diện tích chỉ 56%, khác biệt mắt thường nhỏ hơn nhiều so với độ mượt).
    const screen = lcd || doctor.lcdFor({ accelOk: this.profile ? this.profile.accelOk : accel !== 'off' });

    const choice = this.imageChoice();
    const tag = choice.tag;
    const api = choice.api;
    const tagDisplay = choice.compat ? 'Google Play (ARM 兼容)' : 'AOSP'; // Giữ nguyên: giá trị ghi vào config.ini của emulator, đổi có thể làm lệch cấu hình AVD/snapshot hiện có

    fs.writeFileSync(
      path.join(home, `${AVD_NAME}.ini`),
      `avd.ini.encoding=UTF-8\npath=${avdDir.replace(/\\/g, '/')}\ntarget=android-${api}\n`,
    );

    const cfgPath = path.join(avdDir, 'config.ini');
    const wantImg = choice.dir
      ? `${choice.dir.replace(/\\/g, '/')}/`
      : `system-images/android-${api}/${tag}/${choice.abi}/`;
    this.wipePending = false;
    if (fs.existsSync(cfgPath)) {
      const prev = fs.readFileSync(cfgPath, 'utf8');
      const prevTag = /tag\.id=(.+)$/m.exec(prev);
      const prevImg = /image\.sysdir\.1=(.+)$/m.exec(prev);
      // So sánh「danh tính image」chứ không phải đường dẫn tuyệt đối: cùng bộ image đổi ổ/đổi thư mục không tính là đổi image,
      // nếu không người dùng vừa đổi thư mục runtime là mất hết ứng dụng đã cài (xem chú thích doctor.imageIdentity).
      const prevId = prevImg ? doctor.imageIdentity(prevImg[1].trim()) : '';
      const wantId = doctor.imageIdentity(wantImg);
      if ((prevTag && prevTag[1].trim() !== tag) || (prevId && prevId !== wantId)) {
        // userdata cũ không tương thích với image mới (vòng lặp khởi động APEX), bắt buộc tạo lại
        this.wipePending = true;
      }
    }

    // Dấu vân tay cấu hình thay đổi → snapshot quickboot cũ chắc chắn nạp thất bại hoặc ra màn hình đen, chủ động hủy.
    // Lưu ý: ở đây chỉ hủy **snapshot**, tuyệt đối không tiện tay -wipe-data — dữ liệu người dùng chứa ứng dụng đã cài và dữ liệu lưu.
    const key = `${doctor.snapshotKey({
      dataMB, emulatorVersion: this._emuVersion || '', api, tag,
    }, choice.dir)}|${screen.w}x${screen.h}@${screen.dpi}`;
    const keyFile = path.join(avdDir, 'snapshot.key');
    let prevKey = '';
    try { prevKey = fs.readFileSync(keyFile, 'utf8').trim(); } catch (_) { /* lần đầu */ }
    const snapshotStale = !!(prevKey && prevKey !== key);
    if (this.wipePending || snapshotStale || wipe) {
      // Xóa có thể bị hệ thống/phần mềm bảo mật chặn (thư mục snapshot thường vài GB).
      // Thất bại thì đổi tên để emulator không nạp nó nữa, tuyệt đối không dừng khởi động vì dọn dẹp thất bại.
      const snapDir = path.join(avdDir, 'snapshots');
      try {
        fs.rmSync(snapDir, { recursive: true, force: true });
      } catch (_) {
        try { fs.renameSync(snapDir, `${snapDir}.stale-${Date.now()}`); } catch (__) { /* ignore */ }
      }
    }
    // Chỉ khi「đổi image」(tag / sysdir thay đổi) mới cần -wipe-data: userdata cũ không tương thích APEX
    // với image mới, không tạo lại sẽ kẹt mãi trong vòng lặp khởi động. Đổi dung lượng / độ phân giải / backend render đều không tính.
    fs.writeFileSync(keyFile, key, 'utf8');

    // hw.cpu.arch phải chính là ABI (x86_64 không được cắt thành x86)
    const cpuArch = choice.abi === 'arm64-v8a' ? 'arm64'
      : choice.abi === 'armeabi-v7a' ? 'arm' : choice.abi;

    const cfg = [
      `AvdId=${AVD_NAME}`,
      'avd.ini.displayname=ApkStart',
      'avd.ini.encoding=UTF-8',
      `abi.type=${choice.abi}`,
      `hw.cpu.arch=${cpuArch}`,
      `hw.cpu.ncore=${cores}`,
      `hw.ramSize=${memoryMB}`,
      `vm.heapSize=${heapMB}`,
      `image.sysdir.1=${wantImg}`,
      `tag.id=${tag}`,
      `tag.display=${tagDisplay}`,
      // Bản cũ cố định 16G, trên ổ nhỏ/môi trường có hạn mức sẽ tạo file khổng lồ và làm chậm lần khởi động đầu
      `disk.dataPartition.size=${dataMB}M`,
      'hw.gpu.enabled=yes',
      `hw.gpu.mode=${gpu}`,
      'hw.keyboard=yes',
      'hw.lcd.width=' + screen.w,
      'hw.lcd.height=' + screen.h,
      'hw.lcd.density=' + screen.dpi,
      'hw.mainKeys=no',
      'ShowDeviceFrame=no',
      `PlayStore.enabled=${choice.compat}`,
      // Snapshot hoàn toàn do dòng lệnh -snapshot apkstart điều khiển: dùng tên riêng, tuyệt đối không nạp nhầm
      // default_boot sót từ bản cũ (đó là trạng thái bộ nhớ của image API30, nạp vào chắc chắn kẹt vòng lặp khởi động).
      'hw.sdCard=no',
      'hw.audioInput=none',
      'hw.camera.back=none',
      'hw.camera.front=none',
      'hw.gps=no',
      // Cảm biến hướng/gia tốc phải tắt: một khi bật, Android sẽ tự xoay theo cảm biến, biến nội dung
      // dọc thành ngang (toàn bộ hình nằm nghiêng 90°, chữ dựng đứng, viền đen bốn phía). Việc đổi bố cục giờ chỉ dựa vào
      // wm density (đổi smallestWidth), không cần và không cho phép cảm biến tham gia.
      'hw.sensors.orientation=no',
    ].join('\n') + '\n';
    fs.writeFileSync(cfgPath, cfg);

    // Phân vùng /data phải「thực sự dùng được」trước, nếu không mọi thứ phía sau đều chờ vô ích (xem chú thích ensureDataPartition)
    const data = this.ensureDataPartition(avdDir, dataMB);

    return {
      home, avdDir, ini: path.join(home, `${AVD_NAME}.ini`), image: choice,
      wipePending: this.wipePending, screen, data,
    };
  }

  /**
   * Đảm bảo phân vùng userdata là một ext4 **thực sự dùng được** — đây là nền móng cho「mở ứng dụng 30 giây vào màn hình chính」.
   *
   * Vì sao phải tự làm (cả ba điều đều rút ra từ thực tế):
   *  1. userdata.img trong gói system image là placeholder 1MB toàn số 0, định dạng thật dựa vào avdmanager gọi
   *     mke2fs của SDK. ApkStart ghi thẳng config.ini rồi chạy emulator, bỏ qua bước đó → /data toàn 0 →
   *     kernel "Invalid ext4 superblock on /dev/block/vdc" → guest rơi vào vòng lặp khởi động lại recovery →
   *     adbd không bao giờ lên → probe tầng trên mãi pending, cuối cùng hết thời gian 240s. Biểu hiện cũ: mở ra phải đợi mấy phút.
   *  2. e2fsck/resize2fs đi kèm emulator là e2fsprogs 1.42.12 bản cygwin, **không nhận đặc tính encrypt**,
   *     có bit này là nó exit 8 từ chối chạy ngay, nên「mở rộng hệ thống tệp」phải làm trước khi bổ sung bit.
   *  3. Hệ thống tệp phải ≥ kích thước phân vùng: chỉ cho 64MB thì giải nén APEX + dexopt lập tức đầy,
   *     sau đó mọi setxattr trả về ENOSPC → không ghi được nhãn SELinux → netd/media/tombstoned
   *     cùng exit 1 → khởi động kẹt ở hoạt ảnh boot, adb mãi offline.
   */
  ensureDataPartition(avdDir, dataMB = 4096) {
    const emulatorExe = this.locate().emulatorExe;
    if (!emulatorExe || !fs.existsSync(emulatorExe)) return { ok: false, reason: 'no-emulator' };
    try { fs.mkdirSync(avdDir, { recursive: true }); } catch (_) { /* ignore */ }
    const emuDir = path.dirname(emulatorExe);
    const img = path.join(avdDir, 'userdata-qemu.img');
    const wantBytes = Math.max(1024, Math.round(dataMB || 4096)) * 1024 * 1024;
    let size = 0;
    try { size = fs.statSync(img).size; } catch (_) { /* không tồn tại */ }

    if (size > 0 && userdata.hasExt4Superblock(img)) {
      // File đủ lớn + hệ thống tệp cũng thực sự đã nới tới kích thước đó, mới coi là「không cần động vào」.
      // Chỉ xem kích thước file sẽ bỏ sót một lỗi thật: qemu-img đã nới file nhưng resize2fs thất bại,
      // thế là file 6GB mà Android chỉ có 64MB — người dùng thấy「cài game báo không đủ dung lượng」.
      const fsBytes = userdata.fsBytes(img);
      const fsOk = fsBytes >= Math.min(size, wantBytes) * 0.95;
      if (size >= wantBytes && fsOk) return { ok: true, created: false, size, fsBytes };
      // Cấu hình dung lượng tăng lên (hoặc hệ thống tệp chưa nới đủ): mở rộng tại chỗ, không tạo lại, giữ ứng dụng đã cài
      try {
        userdata.clearEncryptFlag(img);
        if (size < wantBytes) this._qemuImg('resize', img, wantBytes);
        this._resize2fs(img);
        userdata.setEncryptFlag(img);
        const grown = userdata.fsBytes(img);
        this.log(`Mở rộng userdata: file ${size} → ${wantBytes}, hệ thống tệp ${fsBytes} → ${grown}`);
        return { ok: true, created: false, grown: true, size: wantBytes, fsBytes: grown };
      } catch (e) {
        this.log(`Mở rộng userdata thất bại (tiếp tục dùng phân vùng hiện có): ${e.message}`);
        // Phân vùng cũ vẫn dùng được, nhưng phải báo thật cho bên gọi「lần này chưa mở rộng được」, không để trang cài đặt hiện thành công
        return { ok: false, created: false, size, fsBytes, error: e.message };
      }
    }

    // Lần đầu / placeholder toàn 0 sót từ bản cũ / image hỏng: tạo mới hoàn toàn
    try {
      fs.rmSync(img, { force: true });
      fs.rmSync(`${img}.qcow2`, { force: true });
      // Trước tiên không kèm bit encrypt (e2fsck/resize2fs cũ mới chịu chạy)
      fs.writeFileSync(img, userdata.buildEmptyExt4({ sizeMB: 64, encrypt: false }));
      this._qemuImg('resize', img, wantBytes);
      this._resize2fs(img);
      userdata.setEncryptFlag(img);
      this.log(`Đã tạo lại userdata: ${(wantBytes / 1024 / 1024 / 1024).toFixed(1)}GB ext4 (block 4K, hỗ trợ FBE)`);
      return { ok: true, created: true, size: wantBytes };
    } catch (e) {
      // Cố gắng hết mức: dù mở rộng thất bại cũng phải bổ sung lại bit encrypt để FBE khởi tạo được (phân vùng sẽ nhỏ hơn)
      try { userdata.setEncryptFlag(img); } catch (_) { /* ignore */ }
      this.log(`Tạo lại userdata thất bại: ${e.message}`);
      return { ok: false, created: true, error: e.message };
    }
  }

  /** qemu-img.exe đi kèm emulator: nới file image thô tới kích thước đích (sparse, xong tức thì)
   *  Lưu ý thứ tự tham số: `qemu-img <lệnh> -f raw <file> <kích thước>`.
   *  Đặt -f trước lệnh sẽ bị coi là tham số toàn cục và báo unrecognized option ngay. */
  _qemuImg(op, ...rest) {
    const exe = path.join(path.dirname(this.locate().emulatorExe), 'qemu-img.exe');
    const r = spawnSync(exe, [op, '-f', 'raw', ...rest], {
      cwd: path.dirname(exe), windowsHide: true, encoding: 'utf8',
    });
    if (r.status !== 0) throw new Error(`qemu-img ${op} thất bại: ${(r.stderr || '').trim() || r.status}`);
  }

  /** resize2fs.exe đi kèm emulator (bản cygwin, phải chạy trong thư mục bin64 mới tìm được DLL) */
  _resize2fs(img) {
    const bin = path.join(path.dirname(this.locate().emulatorExe), 'bin64');
    const exe = path.join(bin, 'resize2fs.exe');
    if (!fs.existsSync(exe)) throw new Error('Thiếu resize2fs.exe');
    const r = spawnSync(exe, [img], {
      cwd: bin, windowsHide: true, encoding: 'utf8', timeout: 180000,
    });
    if (r.status !== 0) throw new Error(`resize2fs thất bại: ${(r.stderr || '').trim() || r.status}`);
  }

  /** emulator dựa vào các biến môi trường này để định vị SDK / AVD; đường dẫn tiếng Trung luôn đổi sang đường dẫn ngắn 8.3 */
  env(root, plan = {}) {
    const safeRoot = doctor.shortPath(root);
    // Thư mục AVD phải khớp với provisioner.paths().avdHome: khi runtime đóng gói chỉ đọc (resources/runtime
    // cạnh EXE) thì root/avd không tồn tại và cũng không ghi được, AVD phải nằm trong thư mục dữ liệu người dùng.
    const avdHome = doctor.shortPath(this.provisioner.paths().avdHome);
    const adbPort = String(plan.adbPort || process.env.ANDROID_ADB_SERVER_PORT || '5044');
    return {
      ...process.env,
      ANDROID_SDK_ROOT: safeRoot,
      ANDROID_HOME: safeRoot,
      ANDROID_AVD_HOME: avdHome,
      ANDROID_EMULATOR_HOME: avdHome,
      ANDROID_ADB_SERVER_PORT: adbPort,
      ANDROID_EMULATOR_USE_SYSTEM_LIBS: '',
      ...(plan.accel === 'off' ? { ANDROID_I_WANT_MY_TCG: 'yes' } : {}),
    };
  }

  buildArgs({
    headless = true, accel = 'auto', port = 5554,
    gpu = 'software', memoryMB = 2048, cores = 2,
    snapshot = true, wipe = false, lcd = null,
  } = {}) {
    const args = [
      '-avd', AVD_NAME,
      '-port', String(port),
      // Âm thanh: mặc định bật (để âm báo/âm thanh video của ứng dụng Android phát ra được).
      // Chỉ khi người dùng tắt rõ ràng trong cài đặt mới truyền -no-audio để tiết kiệm chút CPU.
      ...(this.settings?.engine?.audio === false ? ['-no-audio'] : []),
      '-no-boot-anim',
      '-no-metrics',
      // Tắt báo cáo crash: một khi có báo cáo crash cũ, emulator sẽ bật hộp thoại modal「đồng ý tải lên」,
      // luồng chính bị chặn, không bao giờ khởi động (log hiện Showing crashdialog to get consent).
      '-crash-report-mode', 'disabled',
      '-gpu', gpu,
      '-memory', String(memoryMB),
      '-cores', String(cores),
      // gRPC của emulator: kênh gửi chạm đa điểm độ trễ thấp cho map phím (touch.js). Cổng = console + 3000 (5554 -> 8554).
      '-grpc', String(port + 3000),
    ];
    // Mạng: emulator AOSP mặc định dùng NAT chế độ người dùng của QEMU (-netdev user), phía Android nhận
    // địa chỉ ảo 10.0.2.x, lối ra dùng lại card mạng vật lý của máy chủ qua NAT.
    // Chế độ này【không】tạo bất kỳ card mạng ảo / switch ảo nào trên Windows
    // (chỉ xảy ra với -netdev tap hoặc bridge, chúng ta không bao giờ bật).
    // Nên ứng dụng Android dùng như "một thiết bị nằm sau NAT của máy chủ", ngăn xếp mạng của máy chủ không bị động tới,
    // không cần cài driver, cũng không thêm bộ điều hợp mạng nào.
    // Khai báo rõ không giới hạn tốc độ: mặc định tuy là full, nhưng với một số tổ hợp -gpu / -net sẽ bị kèm
    // cấu hình bảo thủ của emulator, ứng dụng video (Hongguo, Douyin) sẽ chậm thấy rõ ở màn hình đầu.
    args.push('-netdelay', 'none', '-netspeed', 'full');
    // DNS: Android mặc định dùng 10.0.2.3 (chuyển tiếp tới DNS máy chủ). Khi máy chủ dùng VPN / mạng công ty / một số nhà mạng,
    // một lần phân giải có thể mất vài trăm ms, biểu hiện là「trang quay vòng mãi mới bắt đầu tải」. Đặt một DNS công cộng
    // trong nước làm ưu tiên, thất bại thì hệ thống vẫn quay về mặc định. Người dùng có thể tắt trong cài đặt (trường hợp tên miền nội bộ).
    if (this.settings?.engine?.fastDns !== false) {
      args.push('-dns-server', '223.5.5.5,119.29.29.29');
    }
    if (lcd) args.push('-skin', `${lcd.w}x${lcd.h}`);
    if (headless) {
      args.push('-no-window');
    } else {
      // Lưu ý: **không được truyền -no-skin nữa**. Nó ghi đè -skin ở trên, khiến kích thước panel quay về
      // giá trị cũ trong config.ini — biểu hiện là「cài đặt đã đổi sang ngang mà thực tế vẫn dọc」,
      // và「hình chỉ chiếm một dải góc trên trái」. Kích thước panel phải do -skin quyết định.
      // Vỏ thiết bị vốn không được vẽ (ShowDeviceFrame=no + nhóm tham số style bên dưới).
      // Lưu ý: không được dùng -qt-hide-window. Nó khiến emulator **hoàn toàn không tạo** cửa sổ Qt đó,
      // mà window agent lại dựa vào SetParent nhúng cửa sổ này vào cửa sổ ứng dụng để hiển thị hình —
      // dùng nó rồi thì probe không bao giờ tìm thấy cửa sổ, người dùng thấy một cửa sổ ứng dụng đen kịt.
      // Việc ẩn cửa sổ chuyển sang để window agent thường trú áp chế (xem QuietSweep trong win/agent.ps1).
    }
    // Chỉ khi snapshot thực sự tồn tại mới truyền -snapshot: AVD mới tinh (hoặc snapshot vừa bị hủy) mà truyền nó,
    // qemu sẽ chờ mãi một trạng thái bộ nhớ không tồn tại, tiến trình sống nhưng không bao giờ khởi động —
    // tầng trên chỉ thấy「hết thời gian khởi động」, rồi đổi tham số thử lại, lại bị khóa AVD chặn thành
    // "Running multiple emulators with the same AVD"。
    // Tham số snapshot quyết định「lần khởi động sau mất 8 giây hay 90 giây」, đây là điểm chí mạng thứ hai:
    // Cách cũ「không có snapshot thì truyền -no-snapshot」, mà -no-snapshot đồng thời tắt luôn **lưu khi thoát**,
    // nên sau lần khởi động nguội đầu tiên không bao giờ tạo được snapshot, lần nào người dùng mở cũng khởi động toàn phần.
    // Cách đúng là -no-snapshot-load: lần này không nạp (tránh chờ một snapshot không tồn tại),
    // nhưng khi thoát vẫn ghi trạng thái bộ nhớ thành apkstart như thường, lần sau khôi phục trực tiếp.
    // Snapshot chiếm một file ram.bin khoảng 2~3GB (người dùng thiếu ổ đĩa có thể tắt, chỉ ảnh hưởng tốc độ khởi động)
    const wantSnapshot = this.settings?.engine?.keepSnapshot !== false;
    if (wipe) {
      // Khi đặt lại dữ liệu không được nạp snapshot cũ (dữ liệu đã không khớp), nhưng **phải cho phép lưu snapshot mới**:
      // sửa mạng dựa vào chuỗi「lần khởi động đầu sau đặt lại có mạng → lưu snapshot ngay → lần sau khôi phục」,
      // cách viết cũ ở đây đẩy -no-snapshot, tắt luôn việc lưu, snapshot không bao giờ lưu được.
      args.push('-no-snapshot-load');
    } else if (!wantSnapshot) {
      args.push('-no-snapshot');
    } else if (snapshot !== false) {
      args.push('-snapshot', SNAPSHOT_NAME);
      // Tự phục hồi mạng yêu cầu lần này khởi động nguội: snapshot có thể được lưu lúc「không có mạng」, khôi phục ra vẫn không có mạng.
      if (!this.hasSnapshot() || this._coldBoot) args.push('-no-snapshot-load');
    } else {
      args.push('-no-snapshot');
    }
    if (wipe) args.push('-wipe-data');
    if (accel === 'off') args.push('-accel', 'off');
    return args;
  }

  /** Chạy một tiến trình (không chờ khởi động, việc chờ nằm trong vòng lặp probe của start()) */
  spawnOnce(plan, { headless, onLog, logFile }) {
    const loc = this.locate();
    const env = this.env(loc.root, plan);
    const args = this.buildArgs({
      headless, accel: plan.accel, port: plan.port, gpu: plan.gpu,
      memoryMB: plan.memoryMB, cores: plan.cores,
      snapshot: plan.snapshot, wipe: plan.wipe, lcd: plan.lcd,
    });
    this._logWrite(logFile, `\n--- ${new Date().toISOString()} ${plan.label} ---\n${loc.emulatorExe} ${args.join(' ')}\n`);

    const proc = spawn(loc.emulatorExe, args, {
      cwd: path.dirname(loc.emulatorExe),
      env,
      windowsHide: true,
      // detached: để emulator độc lập với nhóm tiến trình ApkStart.
      // Khi Electron thoát sẽ đóng job object do nó tạo, kéo theo giết luôn tiến trình con —
      // biểu hiện là "đóng ApkStart rồi mở lại lại phải khởi động nguội hơn 20 giây". Tách độc lập thì emulator vẫn còn,
      // lần sau khởi động tiếp quản trực tiếp (xem Runtime.adoptExisting), mở ra là vào ngay.
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.proc = proc;
    try { proc.unref(); } catch (_) { /* ignore */ }

    const pipe = (stream) => {
      stream.setEncoding('utf8');
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk;
        const lines = buf.split('\n');
        buf = lines.pop() || '';
        for (const l of lines) {
          if (!l.trim()) continue;
          this.log(l.trim());
          this._logWrite(logFile, `${l.trim()}\n`);
        }
      });
    };
    pipe(proc.stdout);
    pipe(proc.stderr);
    proc.on('exit', (code) => {
      this.lastExitCode = code;
      const meaning = describeExitCode(code);
      this.log(`emulator exit ${code}${meaning ? `（${meaning}）` : ''}`);
      this._logWrite(logFile, `emulator exit ${code}${meaning ? `（${meaning}）` : ''}\n`);
      this.proc = null;
      onLog(`Runtime đã thoát (code=${code}${meaning ? `, ${meaning}` : ''})`);
    });
    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      this._logWrite(logFile, `spawn error: ${e.message}\n`);
      this.proc = null;
    });

    // qemu là tiến trình độc lập detached, đợi nó thực sự chạy rồi mới hạ độ ưu tiên.
    // Không hạ thì 2~4 luồng vCPU sẽ tranh CPU với desktop Windows ở mức ưu tiên Normal,
    // cảm nhận trực quan nhất của người dùng là「vừa mở ApkStart, chuột đã chập chờn, cả máy giật」.
    const perf = this.settings?.engine?.priorityMode === 'performance';
    setTimeout(() => {
      this.setPriority(perf ? 'normal' : 'below').catch(() => {});
    }, 3500).unref?.();
    return { proc, args };
  }

  /** Ghi log emulator: có xoay vòng theo kích thước, tránh dùng lâu làm đầy ổ đĩa */
  _logWrite(file, text) {
    const limit = Math.max(2048, Number(this.settings?.engine?.logLimitKB || 2048) * 4);
    require('./logfile').append(file, text, limit);
  }

  /** Tình trạng thực tế của image /data hiện tại (để trang cài đặt hiển thị, không cần khởi động Android cũng lấy được) */
  dataInfo() {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    const img = path.join(dir, 'userdata-qemu.img');
    let bytes = 0;
    try { bytes = fs.statSync(img).size; } catch (_) { /* chưa tạo */ }
    return {
      avdDir: dir,
      imageBytes: bytes,
      imageGB: bytes ? Number((bytes / 1073741824).toFixed(1)) : 0,
      configuredGB: Number(this.settings?.engine?.dataPartitionGB || 0),
    };
  }

  /**
   * Mở rộng ngay phân vùng /data tới kích thước chỉ định (phải đảm bảo emulator đã dừng, nếu không image bị chiếm).
   * Dùng đường mở rộng tại chỗ của ensureDataPartition: qemu-img resize + resize2fs,
   * không tạo lại, không mất ứng dụng đã cài và dữ liệu lưu.
   */
  resizeDataPartition(dataMB) {
    const dir = path.join(this.provisioner.paths().avdHome, `${AVD_NAME}.avd`);
    return this.ensureDataPartition(dir, dataMB);
  }

  /**
   * Điều chỉnh độ ưu tiên của tiến trình qemu/emulator trên máy (chỉ khớp tiến trình có tên AVD này trên dòng lệnh).
   * level: idle (container đỗ chờ) | below (có ứng dụng ở tiền cảnh) | normal (ưu tiên hiệu năng).
   */
  setPriority(level = 'below') {
    if (process.platform !== 'win32') return Promise.resolve(0);
    const script = path.join(__dirname, 'win', 'priority.ps1');
    if (!fs.existsSync(script)) return Promise.resolve(0);
    return new Promise((resolve) => {
      execFile('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
        '-File', script, '-Avd', AVD_NAME, '-Level', level,
      ], { windowsHide: true, timeout: 15000 }, (_err, out) => {
        const m = /CHANGED=(\d+)/.exec(String(out || ''));
        resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /** Kill cưỡng bức lần thử hiện tại (gồm cây tiến trình con qemu) */
  async killAttempt() {
    const proc = this.proc;
    this.proc = null;
    if (proc) {
      try { proc.kill(); } catch (_) { /* ignore */ }
      if (process.platform === 'win32' && proc.pid) {
        try { spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) { /* ignore */ }
      }
    }
    await sleep(800);
    // Handle proc thường đã mất (emulator.exe khởi động xong là thoát, qemu là tiến trình độc lập detached),
    // không dọn dự phòng theo tên tiến trình thì vòng sau sẽ bị khóa AVD chặn thành FATAL.
    await this.killOrphanProcesses().catch(() => {});
  }

  /**
   * Dựng lại adb server trên cổng chuyên dụng này.
   *
   * Đây là thủ phạm chính của「mở ứng dụng phải đợi hai phút」, cách cũ chỉ kill-server rồi trả về:
   * emulator lúc khởi động sẽ kết nối adb daemon trên ANDROID_ADB_SERVER_PORT,
   * không kết nối được thì **không bao giờ đăng ký thiết bị này nữa** — adb devices hoặc không có emulator-5554,
   * hoặc mãi offline (log chính là câu "Unable to connect to adb daemon on port: 5044").
   * Thế là probe tầng trên mãi không lấy được sys.boot_completed, chờ không 3 phút hết thời gian rồi thử lại,
   * lần thử lại nào cũng khởi động nguội toàn phần, snapshot cũng không lưu được vì「thiết bị không trực tuyến」, thành vòng lặp chết.
   *
   * Nên phải kill trước (xóa bản ghi thiết bị cũ) rồi mới start, và đợi cổng thực sự lắng nghe mới trả về.
   */
  /** Cho tầng trên chủ động khởi động lại server một lần khi truyền tải adb bị kẹt (offline / unauthorized) */
  async resetAdbServer() {
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    return this._resetAdbServer(port);
  }

  async _resetAdbServer(adbPort) {
    let adb = 'adb';
    try { adb = this.provisioner.adbVersionPath() || 'adb'; } catch (_) { /* dùng adb trong PATH */ }
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(adbPort) };
    const run = (args, timeout) => new Promise((resolve) => {
      try {
        execFile(adb, args, { timeout, windowsHide: true, env }, () => resolve());
      } catch (_) { resolve(); }
    });
    await run(['kill-server'], 6000);
    await run(['start-server'], 12000);
    // adb start-server trên một số máy trả về đồng bộ rất nhanh, nhưng cổng chưa thực sự listen,
    // ở đây đợi tới khi kết nối được (tối đa ~3 giây, bình thường vài chục ms).
    const net = require('net');
    for (let i = 0; i < 25; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const alive = await new Promise((resolve) => {
        const sock = net.connect({ host: '127.0.0.1', port: Number(adbPort) });
        let done = false;
        const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
        sock.setTimeout(150, () => fin(false));
        sock.once('connect', () => fin(true));
        sock.once('error', () => fin(false));
      });
      if (alive) return true;
      // eslint-disable-next-line no-await-in-loop
      await sleep(120);
    }
    return false;
  }

  /**
   * Chờ trường hợp「spawn xong thoát ngay」.
   * Lỗi tham số/thiếu DLL thì emulator thường thoát trong 1 giây; tiến trình còn sống thì trả về ngay,
   * không cần chờ cứng 2.5 giây nữa — lúc khôi phục snapshot, khoảng thời gian đó đủ để khởi động xong một nửa.
   */
  _waitSpawnSettled(ms = 900) {
    const proc = this.proc;
    if (!proc) return Promise.resolve(true);
    return new Promise((resolve) => {
      let done = false;
      const onExit = () => fin(true);
      const fin = (exited) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { proc.removeListener('exit', onExit); } catch (_) { /* ignore */ }
        resolve(exited);
      };
      const timer = setTimeout(() => fin(false), ms);
      proc.once('exit', onExit);
    });
  }

  /**
   * Buộc「lần khởi động sau」khởi động nguội (không nạp snapshot khởi động nhanh).
   *
   * Snapshot lưu cả trạng thái card mạng: nếu snapshot được lưu lúc「không có mạng」, mỗi lần khôi phục sau đó sẽ
   * tiếp tục không có mạng. Khi tự phục hồi mạng, khởi động nguội một lần trước để né snapshot hỏng này.
   */
  forceColdBootOnNextStart() { this._coldBoot = true; }

  /**
   * Cho「lần khởi động sau」kèm -wipe-data (chỉ dùng khi「Sửa mạng」đã thử nhiều cách đều thất bại).
   * 「Xóa file image userdata」và `-wipe-data` của emulator không tương đương, phải dùng cái sau.
   */
  forceWipeOnNextStart() { this._forceWipe = true; }

  /**
   * Kiểm tra máy ảo có thực sự kết nối mạng được không.
   *
   * Vì sao cần bước này: cấu hình Wi-Fi của máy ảo Android nằm trong /data, một khi bị ghi hỏng (biểu hiện điển hình là
   * trong `cmd wifi list-networks` cùng một AndroidWifi xuất hiện hai lần, trùng network id),
   * wlan0 sẽ mãi NO-CARRIER, không lấy được IP. Lúc đó「trang cần mạng」trong ứng dụng chỉ là một mảng
   * màn hình đen — 「Hongguo bấm đồng ý xong màn hình đen」mà người dùng thấy là do vậy, hoàn toàn không liên quan GPU/render.
   *
   * @param {string} [adbPath] chỉ định rõ file thực thi adb (Runtime có cách phân giải đáng tin hơn)
   * @returns {Promise<{ok:boolean, reason:string, gateway?:string, ip?:string}>}
   */
  async checkNetwork(adbPath = '', { waitMs = 0, interval = 3000 } = {}) {
    const fs = require('fs');
    const path = require('path');
    let adb = adbPath || '';
    if (!adb) {
      try { adb = this.provisioner.adbVersionPath() || ''; } catch (_) { adb = ''; }
    }
    if (!adb) {
      // adbVersionPath() chỉ tra「file phiên bản」, nhiều kiểu cài đặt thì nó rỗng;
      // tìm platform-tools đóng gói theo thư mục gốc runtime mới chắc chắn.
      try { adb = path.join(this.locate().root, 'platform-tools', 'adb.exe'); } catch (_) { adb = ''; }
    }
    if (!adb || !fs.existsSync(adb)) adb = 'adb';
    const port = Number(process.env.ANDROID_ADB_SERVER_PORT) || this.adbPort || 5044;
    const env = { ...process.env, ANDROID_ADB_SERVER_PORT: String(port) };
    const sh = (cmd, timeout = 8000) => new Promise((resolve) => {
      try {
        execFile(adb, ['-s', this.serial, 'shell', cmd], { timeout, windowsHide: true, env }, (e, out) => {
          resolve(e ? '' : String(out || ''));
        });
      } catch (_) { resolve(''); }
    });
    // Bảng định tuyến đa bảng của Android khiến bảng chính của `ip route` trông như trống (route mặc định nằm trong bảng theo interface),
    // hơn nữa uid của shell không thuộc nhóm network của ứng dụng, `ping` hay báo nhầm "Network is unreachable",
    // dù Wi-Fi thực ra đã kết nối, ứng dụng vẫn lên mạng bình thường. Nên ở đây chỉ xét「có lấy được địa chỉ IPv4 không」,
    // rồi kết hợp trạng thái kết nối của `cmd wifi status` để đối chiếu, không dùng ping để phán đoán.
    const addr = await sh('ip -o addr');
    const ips = [];
    const re = /inet ((?:\d{1,3}\.){3}\d{1,3})\//g;
    let m = re.exec(addr);
    while (m) {
      const ip = m[1];
      if (!/^127\./.test(ip)) ips.push(ip);
      m = re.exec(addr);
    }
    const wifi = await sh('cmd wifi status');
    const connected = /Wifi is connected/i.test(wifi);
    if (!ips.length) {
      // Liên kết Wi-Fi + DHCP thường xong muộn hơn sys.boot_completed vài chục giây.
      // Bên gọi đã cho waitMs thì tiếp tục chờ, đừng kết luận「không có mạng」ngay lúc này.
      if (waitMs > 0) {
        const t0 = Date.now();
        while (Date.now() - t0 < waitMs) {
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, interval));
          // eslint-disable-next-line no-await-in-loop
          const again = await this.checkNetwork(adbPath, { waitMs: 0 });
          if (again.ok) return again;
        }
      }
      return { ok: false, reason: connected ? 'no-ip-address' : 'wifi-not-connected', addrs: ips };
    }
    const ip = ips[0];
    const gw = /^10\.0\.2\./.test(ip) ? '10.0.2.2' : ip.replace(/\.\d+$/, '.1');
    return { ok: true, reason: '', gateway: gw, ip, wifiConnected: connected };
  }

  /**
   * Khởi động + tự thử lại.
   * @param {Function} probe callback bất đồng bộ, trả về 'ok' | 'pending' | 'fatal'
   */
  async start({ headless = false, onLog = () => {}, probe = null, maxAttempts = 4 } = {}) {
    if (this.proc && !this.proc.killed) {
      return { ok: true, reused: true, serial: this.serial, port: this.port };
    }

    const loc = this.locate();
    if (!loc.emulatorExe) throw new Error('Chưa cài engine runtime, hãy hoàn tất triển khai ở trang「Runtime」trước');
    const choice = this.imageChoice();
    if (choice.compat ? !this.provisioner.playImageInfo().ok : !this.provisioner.systemImageInfo().ok) {
      throw new Error('System image chưa sẵn sàng, hãy tải system image Android ở trang「Runtime」trước');
    }

    const s = this.settings;
    // Trước khi khởi động xem qua ổ đĩa: emulator ghi vào AVD (phân vùng dữ liệu + snapshot, vài GB),
    // chỉ dung lượng trống của ổ chứa nó mới quyết định có khởi động được không; thư mục runtime chỉ ghi log, yêu cầu thấp hơn nhiều.
    // Trước đây lấy giá trị nhỏ nhất của cả hai, kết quả「thư mục dữ liệu đã chuyển sang ổ D, ổ C chỉ còn 400MB」
    // bị đánh giá nhầm là thiếu dung lượng — chuyển ổ coi như vô ích.
    const avdHome = this.provisioner.paths().avdHome;
    const avdFreeMB = doctor.freeDiskMB(avdHome);
    const diskMB = doctor.freeDiskMB(loc.root);
    const needMB = 2500;
    if (avdFreeMB && avdFreeMB < needMB) {
      const msg = `Không đủ dung lượng đĩa: ổ chứa thư mục dữ liệu Android (${avdHome}) chỉ còn ${(avdFreeMB / 1024).toFixed(1)} GB, `
        + `runtime cần ít nhất ${(needMB / 1024).toFixed(1)} GB trống. Hãy vào「Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu Android」`
        + 'để chuyển sang ổ còn nhiều dung lượng (ví dụ D:), hoặc dọn dẹp ổ đĩa trước. Ứng dụng và dữ liệu lưu của bạn sẽ không bị tự động xóa.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    if (diskMB && diskMB < 300) {
      const msg = `Ổ chứa thư mục runtime (${loc.root}) chỉ còn ${(diskMB / 1024).toFixed(1)} GB, `
        + 'không đủ chỗ ghi cả log lẫn file tạm. Hãy dọn dẹp ổ đĩa, hoặc chuyển cả「Thư mục dữ liệu runtime」sang ổ khác.';
      this.log(msg);
      onLog(msg);
      return { ok: false, error: msg, needsSpace: true, attempts: [] };
    }
    const adbPort = await doctor.freeAdbPort(Number(process.env.ANDROID_ADB_SERVER_PORT) || 5044);
    // Cho mọi lệnh gọi adb trong tiến trình này dùng chung một cổng server với emulator
    process.env.ANDROID_ADB_SERVER_PORT = String(adbPort);
    this.adbPort = adbPort;

    // Bốn việc này không phụ thuộc nhau, làm song song: trước đây「kiểm tra tăng tốc → phiên bản → dò cổng → dọn adb server」chạy tuần tự,
    // chờ không 3~5 giây trước khi khởi động nguội, đúng lúc người dùng mở ứng dụng và nhìn chằm chằm khung tải.
    // adb server sót từ lần chạy trước có thể còn giữ bản ghi thiết bị cũ (sẽ đẩy emulator mới thành offline),
    // nên vẫn phải dọn server, chỉ là không cần chờ riêng nó.
    const [accelInfo, verInfo, startPort] = await Promise.all([
      this.provisioner.emulatorAccel(),
      this.provisioner.emulatorVersion(),
      doctor.freePortPair(5554),
      this._resetAdbServer(adbPort),
    ]);
    const emuVersion = verInfo.version || '';
    this._emuVersion = emuVersion;

    // Dùng chung một lối vào với trang cài đặt / báo cáo chẩn đoán, đảm bảo「cái hiển thị」chính là「cái thực chạy」
    const profile = doctor.autoProfile({
      settings: s, accel: accelInfo, emulatorVersion: emuVersion, diskMB,
      port: startPort, adbPort,
    });
    this.profile = profile;
    const variants = doctor.planVariants(profile).slice(0, maxAttempts);

    // Ghi nhớ backend GPU「lần trước vừa chạy đã crash」, lần sau xếp nó xuống cuối.
    // Thực tế: trên AMD Radeon 780M, `-gpu host` qua được kiểm tra phần cứng của emulator,
    // nhưng VM chạy được mười mấy giây thì tiến trình exit 1 thẳng (log chỉ có "AEHD is operational"),
    // lần nào cũng phải chờ không hơn 20 giây rồi mới lùi về swangle. Key có kèm phiên bản emulator,
    // nâng cấp runtime xong sẽ tự cho nó thêm một cơ hội.
    const badGpuKey = this.settings.engine.badGpu || '';
    const [badVer, badGpu] = badGpuKey.includes('|') ? badGpuKey.split('|') : ['', ''];
    if (badGpu && badVer === emuVersion) {
      const rank = (v) => (v.gpu === badGpu ? 1 : 0);
      variants.sort((a, b) => rank(a) - rank(b));
      if (variants[0] && variants[0].gpu === badGpu && variants.length > 1) {
        onLog(`Lần trước backend render ${badGpu} crash ngay khi khởi động, lần này thử ${variants[1].gpu} trước`);
      }
    }

    const logFile = path.join(store.DATA_DIR, 'logs', 'emulator.log');
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    this._logWrite(logFile, `\n\n=== ${new Date().toISOString()} START ${doctor.describeProfile(profile)} ===\n`);

    // Thông số màn hình giữ nguyên suốt quá trình khởi động, nếu không mỗi lần thử lại đổi độ phân giải sẽ liên tục xóa snapshot.
    // Độ phân giải lấy từ profile của doctor (có thể đổi「Chất lượng hình」trong cài đặt), khi auto thì chọn theo trạng thái tăng tốc.
    const screen = (profile && profile.lcd) || doctor.lcdFor({ accelOk: accelInfo.ok });
    this.attempts = [];
    this.lastDiagnosis = null;
    let lastError = '';

    // Dọn tiến trình mồ côi trước khi khởi động nguội: khi qemu sót từ lần chạy trước vẫn giữ khóa AVD,
    // mọi lần thử sẽ FATAL ngay "Running multiple emulators with the same AVD".
    // eslint-disable-next-line no-await-in-loop
    await this.killOrphanProcesses({ onLog }).catch(() => {});

    for (let i = 0; i < variants.length; i += 1) {
      const base = variants[i];
      // Cổng bị chiếm cũng gây thất bại, mỗi lần thử lại dò lại một lần
      // eslint-disable-next-line no-await-in-loop
      const port = i === 0 ? startPort : await doctor.freePortPair(startPort + (i * 2));
      const plan = { ...base, port, adbPort, lcd: screen };
      this.port = port;
      this.grpcPort = port + 3000;
      // Mỗi vòng đặt lại mã thoát: 0xC0000005 của vòng trước không được mang vào chẩn đoán vòng sau
      this.lastExitCode = null;
      // Log cũng chia theo vòng: log trong bộ nhớ cộng dồn qua các vòng, nếu dòng crash của vòng 1 còn ở cuối,
      // vòng 2 (ví dụ xung đột cổng sau khi đổi backend) sẽ bị chẩn đoán nhầm thành cùng một crash.
      const logStart = this._log.length;
      onLog(`Khởi động runtime (lần ${i + 1}/${variants.length}: ${plan.label})…`);

      // eslint-disable-next-line no-await-in-loop
      const avd = this.ensureAvd({
        ...plan,
        // _forceWipe cũng phải tham gia「xóa snapshot cũ」: sau khi đặt lại dữ liệu, snapshot cũ chắc chắn nạp thất bại
        // (thực tế báo Failed to load snapshot rồi lùi về khởi động nguội), phải xóa trước rồi tạo lại.
        wipe: plan.wipe || !!this.wipePending || !!this._forceWipe,
      });
      // Điểm móc: tầng trên (main) dùng nó để bật chế độ áp chế cửa sổ đen **trước khi** khởi chạy emulator.
      // Cửa sổ console hiện ra chỉ vài chục ms sau spawn, quét bù sau đó chắc chắn sẽ lóe lên một cái,
      // nên ở đây phải bật nó trước, rồi mới khởi chạy tiến trình.
      if (this.onBeforeSpawn) {
        // eslint-disable-next-line no-await-in-loop
        try { await this.onBeforeSpawn(); } catch (_) { /* ignore */ }
      }
      // eslint-disable-next-line no-await-in-loop
      const forceWipe = !!this._forceWipe;
      this._forceWipe = false;
      // _coldBoot chỉ có hiệu lực cho lần spawn này, tránh về sau lần khởi động nào cũng thoái hóa thành khởi động nguội lâu
      this.spawnOnce({ ...plan, wipe: plan.wipe || avd.wipePending || forceWipe }, { headless, onLog, logFile });
      this._coldBoot = false;

      // Lỗi tham số / thiếu DLL sẽ thoát ngay
      // eslint-disable-next-line no-await-in-loop
      const dead = await this._waitSpawnSettled(2200);
      if (dead || !this.proc) {
        const d = doctor.diagnose(this._attemptLines(logStart, 60));
        this.attempts.push({ plan: plan.label, diagnosis: d.code, exitCode: this.lastExitCode });
        this.lastDiagnosis = d;
        lastError = `${d.title}：${d.hint}`;
        // Đầy ổ đĩa không phải chuyện「đổi bộ tham số là ổn」: tiếp tục thử lại chỉ thất bại lặp lại,
        // hơn nữa trước đây bộ tham số cuối cùng có kèm wipe, sẽ xóa luôn dữ liệu người dùng. Dừng luôn, báo lỗi đúng sự thật.
        if (d.code === 'DISK_FULL') {
          onLog('Không đủ dung lượng đĩa, đã dừng thử lại (sẽ không động tới ứng dụng và dữ liệu lưu của bạn).');
          this._persistFailure({ profile, why: 'disk-full' });
          return { ok: false, error: lastError, needsSpace: true, attempts: this.attempts, exitCode: this.lastExitCode };
        }
        // Kết luận loại tăng tốc/image có thể là dữ liệu cũ trong cache, hủy đi, lần khởi động sau dò lại
        if (['ACCEL', 'GPU_INIT', 'GPU_MODE', 'IMAGE', 'DLL', 'ACCESS_VIOLATION'].includes(d.code)) {
          try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
        }
        onLog(`${d.title}, tự đổi bộ tham số khác và thử lại…`);
        this._noteGpuFailure(plan);
        continue;
      }

      if (!probe) {
        return { ok: true, serial: this.serial, port, accel: accelInfo, logFile, profile, attempts: this.attempts };
      }

      const started = Date.now();
      const timeout = plan.bootTimeoutMs || 240000;
      let ok = false;
      let fatal = false;
      let sawBooting = false;
      // Khôi phục snapshot thường lên trong vài giây, cố định 3 giây một lần nghĩa là trung bình phải chờ thêm 1.5 giây mới「phát hiện」
      // nó đã xong. Ở đây bắt đầu từ 200ms rồi nới dần tới 1.2 giây: giai đoạn đầu khởi động bắt được ngay,
      // quá trình khởi động dài cũng không tốn CPU vào việc thăm dò.
      let interval = 200;
      let lastNotice = 0;
      // eslint-disable-next-line no-await-in-loop
      while (Date.now() - started < timeout) {
        if (!this.proc) { fatal = true; break; }
        let state = 'pending';
        try {
          // eslint-disable-next-line no-await-in-loop
          state = await probe({ serial: this.serial, port, adbPort });
        } catch (_) { state = 'pending'; }
        if (state === 'ok') { ok = true; break; }
        if (state === 'fatal') { fatal = true; break; }
        // Chỉ cần adb chạy được shell là kernel đã đang khởi động, thông tin Vulkan/EGL thông thường trong log không tính là thất bại
        if (state === 'booting') sawBooting = true;
        // 45 giây vẫn hoàn toàn chưa kết nối được, và log có lỗi nghiêm trọng rõ ràng → đổi phương án sớm, không chờ không 4 phút
        if (!sawBooting && Date.now() - started > 45000) {
          const d = doctor.diagnose(this._attemptLines(logStart, 80));
          if (['GPU_INIT', 'ACCEL', 'GPU_MODE', 'IMAGE', 'DLL', 'MEMORY', 'ACCESS_VIOLATION'].includes(d.code)) {
            this.lastDiagnosis = d;
            try { this.provisioner.invalidateEnvCache(); } catch (_) { /* ignore */ }
            fatal = true;
            break;
          }
        }
        // Mỗi 15 giây một dòng tiến độ: trước đây dùng「chia lấy dư」để kiểm tra, với khoảng cách tự thích ứng sẽ in liền hai ba dòng trùng
        if (Date.now() - lastNotice > 15000) {
          lastNotice = Date.now();
          onLog(`Đang khởi động… ${Math.round((Date.now() - started) / 1000)}s`);
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(interval);
        interval = Math.min(1200, Math.round(interval * 1.6));
      }

      if (ok) {
        const bootMs = Date.now() - started;
        // Lần này thực sự lên rồi: xóa bản ghi thất bại lần trước, tránh sau này「chẩn đoán」lôi chuyện cũ ra
        this._clearFailure();
        // Nhất định phải lưu snapshot quickboot: tiến trình emulator sẽ kết thúc theo ApkStart (job object của
        // Electron sẽ giết kèm tiến trình con), lần mở sau có snapshot hay không quyết định là 25 giây hay 7 giây.
        // Khi cài ứng dụng mới, installer sẽ hủy snapshot, tránh "khởi động lại thì ứng dụng biến mất".
        this.snapshotWorthSaving = true;
        onLog(`Runtime đã sẵn sàng (${Math.round(bootMs / 1000)}s, ${plan.label})`);
        // Khởi động thành công không có nghĩa là dùng được: tiện kiểm tra mạng. Khi máy ảo không có mạng, trang cần mạng sẽ đen mãi,
        // người dùng chỉ nói「ứng dụng này màn hình đen」, khó nghĩ tới mạng. Ở đây chủ động kiểm tra một lần và nói rõ.
        let network = null;
        try { network = await this.checkNetwork(); } catch (_) { /* kiểm tra thất bại không tính là khởi động thất bại */ }
        if (network && !network.ok) {
          onLog('⚠ Máy ảo Android hiện không có mạng: ứng dụng cần mạng (như Hongguo, ứng dụng phim ngắn) mở ra sẽ màn hình đen mãi. '
            + 'Có thể vào「Cài đặt → Sửa mạng」để đặt lại dữ liệu Android (danh sách ứng dụng được giữ, khi mở sẽ tự cài lại).');
        }
        return {
          ok: true, serial: this.serial, port, accel: accelInfo, logFile,
          profile, attempts: this.attempts, bootMs, quickBoot: true, network,
        };
      }

      const attemptLines = this._attemptLines(logStart, 80);
      const d = fatal ? (this.lastDiagnosis || doctor.diagnose(attemptLines)) : doctor.diagnose(attemptLines);
      this.attempts.push({ plan: plan.label, diagnosis: d.code, timeout: !fatal, exitCode: this.lastExitCode });
      this.lastDiagnosis = d;
      lastError = fatal ? `${d.title}: ${d.hint}` : 'Hết thời gian khởi động (có thể lần khởi động đầu chậm hoặc tăng tốc phần cứng chưa có hiệu lực)';
      onLog(`${lastError}, tự đổi bộ tham số khác và thử lại…`);
      this._noteGpuFailure(plan);
      // eslint-disable-next-line no-await-in-loop
      await this.killAttempt();
    }

    const d = this.lastDiagnosis || doctor.diagnose(this.recentLog(120));
    const report = doctor.writeReport({
      dataDir: store.DATA_DIR, profile, logLines: this.recentLog(300),
      extra: {
        attempts: this.attempts,
        diagnosis: d,
        image: choice,
        exitCode: this.lastExitCode,
        exitMeaning: describeExitCode(this.lastExitCode),
      },
    });
    const err = new Error(
      `Runtime đã thử nhiều lần vẫn không khởi động được (${d.title}).\n${d.hint}\n\n`
      + `Đã thử: ${this.attempts.map((a) => `${a.plan} → ${a.diagnosis}`).join('; ')}\n`
      + `Báo cáo chẩn đoán: ${report.file}`,
    );
    err.diagnosis = d;
    err.report = report.file;
    err.attempts = this.attempts;
    this._persistFailure({ profile, why: 'boot-failed', report: report.file });
    throw err;
  }

  running() { return !!(this.proc && !this.proc.killed); }

  /**
   * Lưu snapshot quickboot (lần khởi động sau khôi phục thẳng trạng thái bộ nhớ, giống khởi động nhanh của WSA/Tencent App Store).
   *
   * Thời điểm rất quan trọng: cách cũ lưu ngay 6 giây sau khi khởi động, đúng lúc tranh I/O ổ đĩa với ứng dụng người dùng vừa mở
   * (snapshot phải ghi 1~3GB), cảm giác còn chậm hơn. Đổi thành「lưu khi rảnh」, và do Runtime kích hoạt
   * khi cửa sổ ứng dụng cuối cùng đóng; nếu trước khi tắt máy chưa kịp lưu thì cũng lưu bù một lần.
   */
  async saveSnapshotNow(adbPath, { timeout = 45000 } = {}) {
    if (!adbPath) return false;
    const ok = await this._saveViaAdb(adbPath, { timeout });
    // Lệnh save của emulator có thể trả OK khi đang ghi đĩa giữa chừng, ở đây xác nhận lại theo độ toàn vẹn file,
    // chỉ khi snapshot.pb thực sự được ghi xuống đĩa mới tính (nếu không lần nạp sau sẽ thất bại và phí vài giây).
    if (!ok) return false;
    return this.hasSnapshot();
  }

  /**
   * Lên lịch một lần「lưu snapshot khi rảnh」.
   * Chỉ lên lịch một lần; nếu đến giờ mà container vẫn còn ứng dụng ở tiền cảnh thì hoãn tới khi thực sự rảnh.
   */
  scheduleSnapshotSave(adbPath, { delay = 20000, isIdle = () => true } = {}) {
    if (!adbPath) return;
    if (this._snapTimer) clearTimeout(this._snapTimer);
    const arm = (ms) => {
      this._snapTimer = setTimeout(async () => {
        this._snapTimer = null;
        if (!this.running()) return;
        if (!isIdle()) { arm(15000); return; }
        // Dung lượng trống không đủ ghi snapshot (kích thước bộ nhớ + dư 1GB) thì bỏ qua: cố ghi chỉ làm đầy ổ đĩa,
        // dẫn tới lần khởi động sau thất bại luôn. Snapshot chỉ ảnh hưởng tốc độ khởi động, không ghi cũng không ảnh hưởng dữ liệu.
        const freeMB = require('./doctor').freeDiskMB(store.DATA_DIR);
        const needMB = Math.round(Number(this.profile?.memoryMB || 3072) * 1.15) + 1024;
        if (freeMB && freeMB < needMB) {
          this.log(`Bỏ qua lưu snapshot: ổ đĩa còn ${(freeMB / 1024).toFixed(1)}GB < cần ${(needMB / 1024).toFixed(1)}GB`);
          return;
        }
        await this.saveSnapshotNow(adbPath).catch(() => false);
        this._snapSaved = true;
      }, ms);
      if (this._snapTimer.unref) this._snapTimer.unref();
    };
    arm(delay);
  }

  cancelSnapshotSave() {
    if (this._snapTimer) clearTimeout(this._snapTimer);
    this._snapTimer = null;
  }

  /** Dừng êm: máy chậm thì lưu snapshot quickboot trước, rồi tắt qua console, cuối cùng kill cưỡng bức cây tiến trình */
  async stop({ adbPath } = {}) {
    if (!this.proc) {
      // Instance tiếp quản không có handle proc, nhưng trên cổng đúng là có máy đang chạy, không được trả về true rồi bỏ đi
      if (!(await this._anyEmulatorPortAlive())) return true;
    }
    this.cancelSnapshotSave();
    const serial = this.serial;
    if (adbPath && this.snapshotWorthSaving !== false) {
      // Trước khi tắt lưu bù một lần: khi đường「lưu lúc rảnh」chưa kịp lưu (ví dụ người dùng cài xong ứng dụng thoát ngay),
      // lần khởi động sau vẫn khôi phục được từ snapshot, thay vì khởi động nguội lại.
      // Ghi 3GB bộ nhớ xuống đĩa mất từ vài giây tới hơn hai mươi giây, cho thời gian chờ đủ, đừng để snapshot ghi được một nửa đã bị kill.
      await this._saveViaAdb(adbPath, { timeout: 60000 });
    }
    if (adbPath) {
      await new Promise((resolve) => {
        execFile(adbPath, ['-s', serial, 'emu', 'kill'],
          { timeout: 10000, windowsHide: true }, () => resolve());
      });
    }
    // Đợi nó tự đi hết quy trình「ghi đĩa → thoát」. Trước đây cố định chờ 6 giây rồi kill cưỡng bức,
    // đúng lúc cắt ngang việc ghi snapshot, để lại vỏ rỗng chỉ có ram.img mà không có snapshot.pb.
    //
    // Lưu ý không được chờ this.proc: emulator.exe chỉ là trình khởi chạy, spawn xong qemu là tự thoát,
    // lấy exit của nó làm「tắt máy xong」sẽ vào ngay nhánh kill cưỡng bức. Ở đây lấy cổng console làm chuẩn.
    for (let i = 0; i < 100 && (await this._consoleAlive()); i += 1) {
      // eslint-disable-next-line no-await-in-loop
      await sleep(300);
    }
    await this.killAttempt();
    return true;
  }

  /**
   * Ghi lại backend GPU「vừa chạy đã crash」, lần khởi động sau xếp nó xuống cuối.
   * Chỉ có hiệu lực ở chế độ auto: người dùng chỉ định rõ backend thì tôn trọng lựa chọn, không lén đổi.
   */
  _noteGpuFailure(plan) {
    try {
      const gpu = plan && plan.gpu;
      if (!gpu) return;
      // Render phần mềm là phương án cuối, nó đã là lựa chọn chậm nhất/ổn định nhất, không còn lựa chọn tệ hơn để lùi
      if (/software|swiftshader|swangle/.test(gpu)) return;
      if ((this.settings.engine.gpuMode || 'auto') !== 'auto') return;
      store.saveSettings({ engine: { badGpu: `${this._emuVersion || ''}|${gpu}` } });
    } catch (_) { /* ignore */ }
  }

  /** Trên cổng console (5554) của instance này còn máy đang chạy không — để xác định「đã tắt sạch hay chưa」 */
  _consoleAlive() {
    const net = require('net');
    const port = this.port || 5554;
    return new Promise((resolve) => {
      const sock = net.connect({ host: '127.0.0.1', port });
      let done = false;
      const fin = (v) => { if (done) return; done = true; try { sock.destroy(); } catch (_) { /* ignore */ } resolve(v); };
      sock.setTimeout(200, () => fin(false));
      sock.once('connect', () => fin(true));
      sock.once('error', () => fin(false));
    });
  }

  /** Dùng adb kích hoạt một lần lưu snapshot (thất bại trả về false, bên gọi quyết định có thử lại không) */
  _saveViaAdb(adbPath, { timeout = 45000 } = {}) {
    return new Promise((resolve) => {
      execFile(adbPath, ['-s', this.serial, 'emu', 'avd', 'snapshot', 'save', SNAPSHOT_NAME],
        { timeout, windowsHide: true }, (err) => resolve(!err));
    });
  }

  recentLog(n = 40) { return this._log.slice(-n).map((x) => x.line); }

  /**
   * Chỉ lấy các dòng log do「lần thử khởi động hiện tại」sinh ra.
   * Log trong bộ nhớ cộng dồn qua các vòng (báo cáo chẩn đoán cần thấy mọi lần thử), nhưng kết luận chẩn đoán chỉ được xét vòng này:
   * nếu không `emulator exit 3221225477` của vòng 1 sẽ khiến mọi thất bại ở vòng 2 bị đánh giá thành cùng một crash.
   * Khi vòng này không có dòng log nào (tiến trình chưa hề chạy) thì lùi về phần cuối tổng thể, ít nhất cũng cho ra một kết luận.
   */
  _attemptLines(from, max = 80) {
    const lines = this._log.slice(Math.max(0, from || 0)).map((x) => x.line);
    return lines.length ? lines.slice(-max) : this.recentLog(max);
  }

  /**
   * Đọc n dòng gần nhất từ cuối file emulator.log (dùng khi bộ đệm trong bộ nhớ trống).
   * Khi người dùng khởi động lại ApkStart rồi xuất báo cáo chẩn đoán, this._log trong bộ nhớ đã trống,
   * vì vậy báo cáo bản cũ chỉ còn một câu UNKNOWN — nguyên nhân crash thật đều nằm trong file log.
   */
  tailLogFile(n = 300) {
    try {
      const file = path.join(store.DATA_DIR, 'logs', 'emulator.log');
      const size = fs.statSync(file).size;
      const take = Math.min(size, 2 * 1024 * 1024);
      const fd = fs.openSync(file, 'r');
      try {
        const buf = Buffer.alloc(take);
        fs.readSync(fd, buf, 0, take, size - take);
        const lines = buf.toString('utf8').split(/\r?\n/);
        // Đọc từ đầu thì dòng đầu tiên có thể bị cắt cụt, bỏ nó đi
        if (take < size) lines.shift();
        return lines.slice(-n);
      } finally { fs.closeSync(fd); }
    } catch (_) { return []; }
  }
}

module.exports = { EmulatorEngine, AVD_NAME, SNAPSHOT_NAME };
