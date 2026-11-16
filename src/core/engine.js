'use strict';
/**
 * Engine runtime: máy ảo QEMU + Android-x86 đi kèm ApkStart
 *
 * Nguyên tắc thiết kế:
 *  - Mặc định tự chủ hoàn toàn (builtin): adb / QEMU / system image đều do ApkStart tự quản lý, không phụ thuộc emulator bên thứ ba nào
 *  - Mọi thao tác với Android đều đi qua adb, nhờ vậy engine có thể thay thế
 *  - Máy ảo khởi động khi cần, rảnh thì tự thu hồi; khởi động xong thì thường trú tái sử dụng, cài/mở ứng dụng gần như không phải chờ
 */
const { spawn, execFile } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');
const { AdbClient } = require('./adb');
const store = require('./store');
const { Provisioner } = require('./provision');
const { EmulatorEngine } = require('./emulator');
const doctor = require('./doctor');
const container = require('./container');

const LOG_DIR = path.join(store.DATA_DIR, 'logs');
const MONITOR_PORT = 5556;
const EMU_PORT = 5554;
const EMU_SERIAL = `emulator-${EMU_PORT}`;

/** Cổng TCP có ai đang lắng nghe không (dùng để xác định emulator để lại lần trước còn chạy không) */
function portAlive(port, timeout = 150) {
  return new Promise((resolve) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => {
      if (done) return;
      done = true;
      try { sock.destroy(); } catch (_) { /* ignore */ }
      resolve(v);
    };
    sock.setTimeout(timeout, () => fin(false));
    sock.once('connect', () => fin(true));
    sock.once('error', () => fin(false));
  });
}

const ATTACH_ENDPOINTS = [
  { name: 'Windows Subsystem for Android', serial: '127.0.0.1:58526' },
  { name: 'LDPlayer', serial: '127.0.0.1:5555' },
  { name: 'MuMu Player', serial: '127.0.0.1:7555' },
  { name: 'Nox Player', serial: '127.0.0.1:62001' },
  { name: 'MEmu Player', serial: '127.0.0.1:21503' },
];

class Runtime {
  constructor(appRoot) {
    this.appRoot = appRoot;
    this.provisioner = new Provisioner(appRoot);
    this.emulator = new EmulatorEngine(appRoot);
    this.vmProc = null;
    this.vmStarting = false;
    this.installing = false;
    this.lastActivity = Date.now();
    this._watchdog = null;
    this._freeformReady = false;
    this._client = null;
    this._bootLog = [];
    this._activeApps = new Set();  // Phiên container: các cửa sổ ứng dụng đang mở
    this.emuSerial = EMU_SERIAL;   // Cổng được chọn động, serial thay đổi theo
    store.ensureDirs();
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  }

  get settings() { return store.getSettings(); }

  /** Engine emulator có đang chạy không */
  get emuRunning() { return this.emulator.running(); }

  // ---------------- Cơ bản ----------------

  adbPath() {
    const s = this.settings;
    const p = this.provisioner.paths();
    if (s.adbPath && fs.existsSync(s.adbPath)) return s.adbPath;
    if (fs.existsSync(p.adbExe)) return p.adbExe;
    const local = path.join(this.appRoot, 'tools', 'platform-tools', 'adb.exe');
    if (fs.existsSync(local)) return local;
    return AdbClient.resolveAdb('', this.appRoot);
  }

  client(serial) {
    const useSerial = serial
      || (this.settings.engine.mode === 'attach' ? this.settings.device : this.emuSerial);
    const adbPath = this.adbPath();
    if (!this._client || this._client.serial !== useSerial || this._client.adbPath !== adbPath) {
      // Khi đổi cổng/đổi adb đừng để adb shell thường trú cũ chạy nền giữ kết nối
      if (this._client && this._client.disposeInput) this._client.disposeInput();
      this._client = new AdbClient({ adbPath, serial: useSerial });
    }
    return this._client;
  }

  touch() { this.lastActivity = Date.now(); }

  log(line) {
    this._bootLog.push({ t: Date.now(), line });
    if (this._bootLog.length > 300) this._bootLog.shift();
  }

  // ---------------- Trạng thái ----------------

  async status() {
    const env = await this.provisioner.checkEnv();
    const s = this.settings;
    const client = this.client();
    const result = {
      mode: s.engine.mode,
      installed: !!s.runtime.installed,
      env,
      engineKind: env.engine,
      emulatorOk: env.emulator.ok,
      emulatorVersion: env.emulator.version,
      sysimgOk: env.sysimg.ok,
      sysimgNote: env.sysimg.note,
      accel: env.accel,
      vmRunning: this.emulator.running() || !!(this.vmProc && !this.vmProc.killed),
      vmStarting: this.vmStarting,
      installing: this.installing,
      adbOk: env.adb.ok,
      adbVersion: env.adb.version,
      qemuOk: env.qemu.ok,
      qemuVersion: env.qemu.version,
      deviceOnline: false,
      android: '',
      sdk: 0,
      freeform: false,
      ready: false,
      needsSetup: null,
      error: '',
      serial: this.emuSerial,
      autoProfile: this.emulator.profile ? doctor.describeProfile(this.emulator.profile) : '',
      diagnosis: this.emulator.lastDiagnosis || null,
      attempts: this.emulator.attempts || [],
      // 「Lần trước vì sao không lên」: trong bộ nhớ không có thì lùi về bản ghi đã lưu đĩa, trang cài đặt/chẩn đoán đều hiện được nguyên nhân thật
      lastFailure: (this.emulator.lastFailure ? this.emulator.lastFailure() : null),
    };

    if (!env.adb.ok) {
      result.needsSetup = 'adb';
      result.error = 'Thiếu adb: bấm「Triển khai một chạm」để tự động tải về';
      return result;
    }

    try {
      result.deviceOnline = await client.isOnline();
      if (result.deviceOnline) {
        const [android, sdk, ff] = await Promise.all([
          client.androidVersion().catch(() => ''),
          client.sdkInt().catch(() => 0),
          client.shell('settings get global enable_freeform_support').catch(() => '0'),
        ]);
        result.android = android;
        result.sdk = sdk;
        result.freeform = String(ff).trim() === '1' || this._freeformReady;
      }
    } catch (e) {
      result.error = e.message;
    }

    if (result.deviceOnline) result.ready = true;
    else if (!env.emulator.ok) result.needsSetup = 'emulator';
    else if (!env.sysimg.ok) result.needsSetup = 'sysimg';
    // Không còn coi「không có tăng tốc phần cứng」là bước chặn: doctor sẽ tự lùi về giả lập phần mềm,
    // và khi khởi động thất bại sẽ thử lại lần lượt theo tổ hợp GPU/tăng tốc/bộ nhớ.
    else result.needsSetup = 'boot';

    result.phase = result.deviceOnline
      ? 'ready'
      : this.installing
        ? 'installing'
        : result.vmRunning
          ? 'booting'
          : 'idle';

    return result;
  }

  /** Chế độ nâng cao: dò runtime có sẵn trên máy (đường dẫn không mặc định) */
  async probe() {
    const adbPath = this.adbPath();
    const one = (ep) => new Promise((resolve) => {
      const c = new AdbClient({ adbPath, serial: ep.serial });
      const timer = setTimeout(() => resolve(null), 4000);
      c.isOnline().then((online) => {
        clearTimeout(timer);
        if (!online && ep.serial.includes(':')) return c.connect().then((ok) => (ok ? ep : null));
        return online ? ep : null;
      }).then(resolve).catch(() => { clearTimeout(timer); resolve(null); });
    });
    const found = await Promise.all(ATTACH_ENDPOINTS.map(one));
    return found.filter(Boolean);
  }

  // ---------------- Khởi động / dừng máy ảo ----------------

  buildArgs({ install = false, headless = false } = {}) {
    const s = this.settings;
    const p = this.provisioner.paths();
    const hv = this._hv || { whpx: false };
    const disk = s.runtime.diskPath || p.disk;
    const iso = s.runtime.isoPath || p.iso;
    const accel = hv.whpx ? 'whpx' : 'tcg';

    const args = [
      '-name', 'ApkStart Runtime',
      '-machine', `q35,accel=${accel}`,
      '-cpu', hv.whpx ? 'host' : 'max',
      '-smp', String(Math.max(2, s.engine.cores || 4)),
      '-m', String(s.engine.memoryMB || 4096),
      '-rtc', 'base=localtime',
      '-netdev', 'user,id=net0,hostfwd=tcp:127.0.0.1:5555-:5555',
      '-device', 'virtio-net-pci,netdev=net0',
      '-vga', 'std',
      '-usb', '-device', 'usb-tablet',
      '-monitor', `tcp:127.0.0.1:${MONITOR_PORT},server,nowait`,
    ];

    if (headless || s.runtime.headless) args.push('-display', 'none');

    if (install) {
      args.push('-boot', 'order=d');
      args.push('-cdrom', iso);
    } else {
      args.push('-boot', 'order=c');
    }
    args.push('-drive', `file=${disk},if=virtio,format=qcow2,cache=writeback`);
    return args;
  }

  async boot({ install = false, onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    this._hv = env.hypervisor;

    // Ưu tiên: emulator chính thức (có sẵn mô hình thiết bị và chuyển dịch GPU, trải nghiệm tốt nhất)
    if (env.emulator.ok && env.sysimg.ok) {
      return this.bootEmulator({ env, onLog });
    }

    return this.bootQemu({ install, env, onLog });
  }

  /**
   * Khởi động Android bằng emulator chính thức.
   * Khác với QEMU+ISO, ở đây không có bước "cài hệ thống": bản thân image là hệ thống, lần đầu chạy là khởi động luôn.
   */
  async bootEmulator({ env, onLog = () => {} } = {}) {
    if (this.vmStarting) {
      const started = Date.now();
      while (this.vmStarting && Date.now() - started < 300000) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
      }
      const c = this.client();
      if (await c.isOnline()) {
        await this.prepare(c);
        return { ok: true, client: c, reused: true };
      }
    }

    const accel = env && env.accel ? env.accel : await this.provisioner.emulatorAccel();
    if (!accel.ok) {
      onLog('Không phát hiện tăng tốc phần cứng: sẽ tự lùi về giả lập phần mềm (lần khởi động đầu sẽ chậm hơn rõ rệt, không cần cài đặt thủ công)');
    }

    this.vmStarting = true;
    try {
      // probe giao cho vòng lặp khởi động của EmulatorEngine: khi tiến trình thoát/có log nghiêm trọng nó sẽ đổi bộ tham số khác thử lại
      // Mỗi vòng chỉ gửi một lệnh adb: trước đây là get-state + getprop + pm path, ba lần khởi chạy tiến trình,
      // khi khôi phục snapshot mỗi vòng chênh 300~500ms, đúng lúc ảnh hưởng tới cảm nhận「mở ứng dụng」.
      let probeStart = Date.now();
      let errStreak = 0;
      let lastHeal = 0;
      const probe = async ({ serial }) => {
        if (!this.emulator.running()) return 'fatal';
        if (!this._probeClient || this._probeClient.serial !== serial) {
          this._probeClient = new AdbClient({ adbPath: this.adbPath(), serial });
        }
        const c = this._probeClient;
        try {
          const out = String(await c.shell('getprop sys.boot_completed; pm path android', { timeout: 8000 }));
          const lines = out.split(/\r?\n/).map((l) => l.trim());
          const booted = lines[0] === '1' || /^1$/.test(lines[0] || '');
          const pmReady = lines.some((l) => /^package:/.test(l));
          errStreak = 0;
          if (booted && pmReady) return 'ok';
          return booted ? 'pending' : 'booting';
        } catch (_) {
          errStreak += 1;
          // Truyền tải adb thỉnh thoảng kẹt ở offline / unauthorized (adb server khác chiếm cổng,
          // hoặc bắt tay bị ngắt), lúc đó vòng shell nào cũng lỗi, probe mãi pending —
          // tầng trên chỉ thấy「hết thời gian khởi động」, chờ không tới 240 giây. Lỗi liên tiếp 6 vòng thì khởi động lại server một lần để tự phục hồi.
          const now = Date.now();
          if (errStreak >= 6 && now - probeStart > 25000 && now - lastHeal > 30000) {
            lastHeal = now;
            onLog('Kết nối adb bất thường, khởi động lại adb server rồi tiếp tục chờ…');
            await this.emulator.resetAdbServer().catch(() => {});
            this._probeClient = null;
          }
          return 'pending';
        }
      };

      const st = await this.emulator.start({
        headless: this.settings.engine.headless !== false,
        onLog,
        probe,
      });
      // start() thất bại thì「trả về {ok:false}」chứ không ném ngoại lệ (thiếu ổ đĩa, thử nhiều lần vẫn thất bại, v.v.).
      // Cách cũ không xem trường này, trả thẳng ok:true lên trên — tầng trên vì thế tưởng「đã sẵn sàng」,
      // tiếp theo adb báo device not found liên tục, người dùng thấy「bấm mở không phản hồi」chứ không phải nguyên nhân thật.
      if (!st || st.ok === false) {
        return {
          ok: false,
          error: (st && st.error) || 'Runtime Android không khởi động được',
          needsSpace: !!(st && st.needsSpace),
          attempts: (st && st.attempts) || [],
          diagnosis: this.emulator.lastDiagnosis,
          exitCode: st && st.exitCode,
        };
      }
      this.lastActivity = Date.now();
      this.emuSerial = st.serial || this.emulator.serial;
      const client = this.client(this.emuSerial);
      await this.prepare(client);
      // Snapshot đổi thành「lưu khi rảnh」: lưu ngay phải ghi 1~3GB, sẽ tranh I/O ổ đĩa với ứng dụng người dùng vừa mở
      this._armSnapshotSave(20000);
      return { ok: true, client, engine: 'emulator', serial: this.emuSerial, profile: st.profile, network: st.network || null };
    } catch (e) {
      // Ném nguyên kết luận thử lại tự động/chẩn đoán lên UI, tránh bọc thêm một lớp「khởi động thất bại」mơ hồ
      return { ok: false, error: e.message, diagnosis: e.diagnosis, report: e.report, attempts: e.attempts };
    } finally {
      this.vmStarting = false;
    }
  }

  // ---------------- Khởi động trước (để môi trường thường trú như WSA) ----------------

  /** Lưu snapshot quickboot khi rảnh: chỉ ghi đĩa khi không có cửa sổ ứng dụng, tránh tranh I/O với việc khởi động ứng dụng */
  _armSnapshotSave(delay = 20000) {
    if (!this.emulator.running()) return;
    this.emulator.scheduleSnapshotSave(this.adbPath(), {
      delay,
      isIdle: () => this._activeApps.size === 0,
    });
  }

  /** Cho bên ngoài như trình cài đặt gọi: cài ứng dụng xong lưu lại snapshot, lần khởi động sau vẫn vào ngay */
  scheduleSnapshotSave(delay = 12000) { this._armSnapshotSave(delay); }

  /**
   * Khởi động trước: trước khi người dùng mở ứng dụng, khởi động sẵn môi trường Android ở nền.
   * WSA / Tencent App Store bản PC đều theo hướng này — môi trường thường trú, bấm biểu tượng chỉ còn một lần am start.
   *  - Hoàn toàn im lặng: không bật cửa sổ, không báo lỗi, thất bại không ảnh hưởng việc mở ứng dụng bình thường;
   *  - Lũy đẳng: đang khởi động hoặc đã sẵn sàng thì dùng lại cùng một Promise, không khởi chạy máy thứ hai;
   *  - Tiết kiệm tài nguyên: khởi động xong thì hạ qemu xuống độ ưu tiên thấp nhất để đỗ chờ.
   */
  prewarm({ onLog = () => {} } = {}) {
    if (this._prewarmPromise) return this._prewarmPromise;
    if (this._activeApps.size > 0) return Promise.resolve({ ok: true, skipped: 'busy' });
    // Chế độ nâng cao là dùng lại runtime của bên khác đã chạy sẵn, không nên tự mở thêm một máy cho người dùng
    if (this.settings.engine.mode === 'attach') return Promise.resolve({ ok: false, skipped: 'attach' });
    const t0 = Date.now();
    const p = (async () => {
      try {
        const env = await this.provisioner.checkEnv();
        if (!(env.adb.ok && env.emulator.ok && env.sysimg.ok)) return { ok: false, skipped: 'not-ready' };
        const r = await this.ensure({ onLog: (m) => onLog(`Khởi động trước: ${m}`) });
        if (r && r.ok) {
          // Trong lúc khởi động trước người dùng có thể đã mở ứng dụng: lúc này không được ép nó xuống độ ưu tiên idle
          if (this._activeApps.size === 0) await this.emulator.setPriority('idle').catch(() => {});
          const ms = Date.now() - t0;
          this.log(`Khởi động trước hoàn tất (${Math.round(ms / 1000)}s)`);
          return { ok: true, bootMs: ms };
        }
        return { ok: false, error: r && r.error };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    })();
    this._prewarmPromise = p;
    const clear = () => { if (this._prewarmPromise === p) this._prewarmPromise = null; };
    p.then(clear, clear);
    return p;
  }

  async bootQemu({ install = false, env, onLog = () => {} } = {}) {
    if (!env.qemu.ok) throw new Error('Chưa cài QEMU, hãy hoàn tất triển khai runtime trước');
    if (install && !env.iso.ok) throw new Error('System image (ISO) chưa sẵn sàng');

    const p = this.provisioner.paths();
    const disk = this.settings.runtime.diskPath || p.disk;
    if (!install && !fs.existsSync(disk)) throw new Error('Chưa cài hệ thống Android vào đĩa ảo');

    this.vmStarting = true;
    const args = this.buildArgs({ install });
    const logFile = path.join(LOG_DIR, install ? 'qemu-install.log' : 'qemu.log');
    const out = fs.openSync(logFile, 'a');
    fs.writeSync(out, `\n\n=== ${new Date().toISOString()} ${install ? 'INSTALL' : 'BOOT'} ===\n${env.qemu.path} ${args.join(' ')}\n`);

    onLog(`Khởi động runtime (${env.hypervisor.whpx ? 'tăng tốc phần cứng WHPX' : 'giả lập thuần phần mềm'})…`);
    if (!env.hypervisor.whpx) onLog(env.hypervisor.note);

    const proc = spawn(env.qemu.path, args, {
      cwd: path.dirname(env.qemu.path),
      windowsHide: true,
      stdio: ['ignore', out, out],
    });
    this.vmProc = proc;
    this.installing = install;
    this.lastActivity = Date.now();

    proc.on('error', (e) => {
      this.log(`spawn error: ${e.message}`);
      onLog(`Khởi động thất bại: ${e.message}`);
      this.vmProc = null;
      this.vmStarting = false;
    });
    proc.on('exit', (code) => {
      this.log(`qemu exit ${code}`);
      onLog(`Runtime đã thoát (code=${code})`);
      this.vmProc = null;
      this.vmStarting = false;
      this.installing = false;
    });

    await new Promise((r) => setTimeout(r, 1500));
    this.vmStarting = false;
    if (!this.vmProc) throw new Error(`Khởi động QEMU thất bại, xem chi tiết trong log: ${logFile}`);

    // Chế độ cài máy: trong ISO là trình cài đặt Linux, không có adb, không thể xử lý theo kiểu「chờ adb」
    if (install) {
      onLog('Trình cài đặt đã khởi động, hãy làm theo hướng dẫn trong cửa sổ máy ảo để hoàn tất cài đặt');
      return { ok: true, install: true, needsManualInstall: true };
    }

    const client = this.client('127.0.0.1:5555');
    const timeout = env.hypervisor.whpx ? 180000 : 900000;
    const linked = await this.waitAdb(client, timeout, onLog);
    if (!linked) {
      return {
        ok: false,
        error: 'Máy ảo đã khởi động nhưng adb không kết nối được: hãy bật「Tùy chọn nhà phát triển → ADB over network」trong máy ảo rồi thử lại',
      };
    }
    const ready = await this.waitAndroidReady(client, Math.max(60000, timeout / 2), onLog);
    if (!ready.ok) {
      return {
        ok: false,
        error: ready.stage === 'kernel'
          ? 'Kernel Android chưa khởi động xong, hãy xem log runtime (có thể image bị hỏng hoặc tăng tốc chưa có hiệu lực)'
          : 'Android đã khởi động nhưng dịch vụ hệ thống chưa sẵn sàng (có thể dừng ở màn hình thiết lập lần đầu, hãy hoàn tất trình hướng dẫn trong cửa sổ máy ảo)',
      };
    }
    await this.prepare(client);
    return { ok: true, client };
  }

  /**
   * Chờ Android thực sự dùng được: adb trực tuyến ≠ hệ thống dùng được.
   * Phải chờ tới khi sys.boot_completed=1 và trình quản lý gói phản hồi được, nếu không am start sẽ thất bại ngay.
   */
  async waitAndroidReady(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let bootCompleted = false;
    let lastNotice = 0;
    while (Date.now() - start < timeoutMs) {
      /* eslint-disable no-await-in-loop */
      const online = await client.isOnline();
      if (!online) {
        await client.connect().catch(() => false);
      } else {
        if (!bootCompleted) {
          const v = await client.shell('getprop sys.boot_completed').catch(() => '');
          if (String(v).trim() === '1') {
            bootCompleted = true;
            onLog(`Kernel Android đã khởi động, đang chờ dịch vụ hệ thống sẵn sàng… (${Math.round((Date.now() - start) / 1000)}s)`);
          }
        }
        if (bootCompleted) {
          const pm = await client.shell('pm path android').catch(() => '');
          if (/package:/.test(pm)) {
            onLog(`Android đã sẵn sàng (${Math.round((Date.now() - start) / 1000)}s)`);
            return { ok: true, ms: Date.now() - start };
          }
        }
      }
      if (Date.now() - lastNotice > 15000) {
        lastNotice = Date.now();
        onLog(bootCompleted
          ? `Đang chờ dịch vụ hệ thống… ${Math.round((Date.now() - start) / 1000)}s`
          : `Đang khởi động Android… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      /* eslint-enable no-await-in-loop */
      await new Promise((r) => setTimeout(r, 2000));
    }
    return { ok: false, stage: bootCompleted ? 'services' : 'kernel', ms: Date.now() - start };
  }

  async waitAdb(client, timeoutMs, onLog = () => {}) {
    const start = Date.now();
    let lastNotice = 0;
    const needConnect = String(client.serial || '').includes(':')
      && !/^emulator-/.test(client.serial);
    while (Date.now() - start < timeoutMs) {
      // Loại emulator-5554 do emulator tự đăng ký, không cần adb connect
      if (needConnect) {
        // eslint-disable-next-line no-await-in-loop
        await client.connect().catch(() => false);
      }
      // eslint-disable-next-line no-await-in-loop
      if (await client.isOnline()) return true;
      if (Date.now() - lastNotice > 20000) {
        lastNotice = Date.now();
        onLog(`Đang chờ Android khởi động… ${Math.round((Date.now() - start) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 2000));
    }
    return false;
  }

  async prepare(client) {
    if (!this._freeformReady) {
      try { this._freeformReady = await client.ensureFreeform(); } catch (_) { /* ignore */ }
    }
    this.startWatchdog();
  }

  /** Dừng êm: emulator tắt qua console, QEMU tắt qua monitor */
  async stop({ graceful = true } = {}) {
    const adbPath = this.adbPath();
    if (this.emulator.running()) {
      await this.emulator.stop({ adbPath });
      return true;
    }
    // Emulator tiếp quản (adoptExisting) không có handle proc trong tiến trình này, logic cũ sẽ
    // return false thẳng — kết quả watchdog rảnh không bao giờ tắt được nó, container giữ CPU/bộ nhớ mãi.
    // Đường này đổi sang tắt qua console adb, cần thì kill cưỡng bức theo cổng làm dự phòng.
    //
    // Lưu ý: emulator.exe chỉ là trình khởi chạy, spawn xong qemu là tự thoát, nên máy「do mình khởi chạy」
    // cũng thường rơi vào nhánh này. Trước khi tắt phải gọi bù saveSnapshotNow, nếu không snapshot không bao giờ lưu được,
    // lần nào người dùng mở cũng khởi động nguội toàn phần (khác biệt 25 giây và 8 giây nằm ở bước này).
    let online = false;
    try { online = await this.client().isOnline(); } catch (_) { /* ignore */ }
    if (online && this.emuSerial) {
      if (adbPath && this.emulator.snapshotWorthSaving !== false) {
        await this.emulator.saveSnapshotNow(adbPath, { timeout: 60000 }).catch(() => false);
      }
      await this.client().exec(['emu', 'kill'], { timeout: 8000 }).catch(() => {});
      for (let i = 0; i < 10; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 400));
        // eslint-disable-next-line no-await-in-loop
        const still = await this.client().isOnline().catch(() => false);
        if (!still) break;
      }
      const still = await this.client().isOnline().catch(() => false);
      if (still) {
        const m = /:(\d+)$/.exec(this.emuSerial);
        const port = m ? Number(m[1]) - 1 : this.emulator.port;
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
      }
      this._activeApps.clear();
      return true;
    }
    if (!this.vmProc) return false;
    if (graceful) {
      try { await this.monitorCmd('system_powerdown'); } catch (_) { /* ignore */ }
      for (let i = 0; i < 16; i++) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => setTimeout(r, 500));
        if (!this.vmProc) return true;
      }
      try { await this.monitorCmd('quit'); } catch (_) { /* ignore */ }
      await new Promise((r) => setTimeout(r, 800));
    }
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
    return true;
  }

  // ---------------- QEMU monitor ----------------

  monitorCmd(cmd, { timeout = 4000 } = {}) {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: MONITOR_PORT });
      let buf = '';
      let sent = false;
      const done = (err, data) => {
        try { sock.destroy(); } catch (_) { /* ignore */ }
        if (err) reject(err); else resolve(data);
      };
      sock.setTimeout(timeout, () => done(new Error('monitor hết thời gian chờ')));
      sock.on('error', (e) => {
        // QEMU sau khi chạy các lệnh như quit sẽ chủ động ngắt kết nối (ECONNRESET/EPIPE), là hiện tượng bình thường
        if (sent && /ECONNRESET|EPIPE/i.test(e.code || String(e))) done(null, buf);
        else done(e);
      });
      sock.on('data', (c) => {
        buf += c.toString();
        if (!sent && buf.includes('(qemu)')) {
          sent = true;
          sock.write(`${cmd}\n`);
          setTimeout(() => done(null, buf), 300);
        }
      });
      sock.on('connect', () => {
        if (!cmd) setTimeout(() => done(null, buf), 250);
      });
    });
  }

  async sendKey(keys, delay = 140) {
    for (const k of keys) {
      // eslint-disable-next-line no-await-in-loop
      await this.monitorCmd(`sendkey ${k}`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, delay));
    }
  }

  // ---------------- Cài hệ thống vào đĩa ảo ----------------

  async startInstaller({ onLog = () => {} } = {}) {
    const env = await this.provisioner.checkEnv();
    if (!env.iso.ok) {
      throw new Error(env.iso.reason || 'Hãy tải/nhập system image Android (ISO) trước');
    }
    if (!env.disk.ok) await this.provisioner.createDisk(this.settings.runtime.diskSizeGB || 24, () => {});
    this.installing = true;
    const r = await this.boot({ install: true, onLog });
    if (!r.ok) throw new Error(r.error || 'Khởi động môi trường cài đặt thất bại');
    return r;
  }

  /** Sau khi cài xong: đóng trình cài đặt → ghi đánh dấu → sau đó khởi động thẳng từ đĩa */
  async markInstalled() {
    if (this.installing) {
      try { await this.stop({ graceful: true }); } catch (_) { /* ignore */ }
    }
    store.saveSettings({ runtime: { installed: true } });
    this.installing = false;
    return true;
  }

  // ---------------- ensure ----------------

  /**
   * Tiếp quản emulator để lại từ lần chạy trước.
   * Mỗi emulator có cổng console riêng (5554/5556/…), cổng adb là +1.
   * Cổng kết nối được và system đã boot_completed thì dùng luôn làm runtime của chúng ta,
   * nhờ vậy「đóng ApkStart rồi mở ứng dụng」là vào ngay, chứ không khởi động nguội thêm một máy.
   */
  /**
   * Tìm mọi cổng console emulator còn sống.
   * Không thể「thử tuần tự từ 5554」: cổng sẽ trôi lên sau nhiều lần khởi động (5554→5556→5558…),
   * thử một khoảng cố định kiểu gì cũng có lúc sót, sót là lại mở thêm máy mới. Ở đây tìm thẳng theo tên tiến trình
   * mọi cổng TCP mà qemu lắng nghe, không sót cái nào.
   */
  async emulatorPorts() {
    const run = (cmd, args) => new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile(cmd, args, { windowsHide: true, maxBuffer: 8 * 1024 * 1024 }, (err, out) => {
        resolve(err ? '' : String(out || ''));
      });
    });
    const ports = new Set();
    try {
      const tl = await run('tasklist', ['/FO', 'CSV', '/NH']);
      const pids = new Set();
      for (const line of tl.split('\n')) {
        const m = /^"([^"]+)","(\d+)"/.exec(line.trim());
        if (m && /qemu|emulator/i.test(m[1])) pids.add(m[2]);
      }
      if (!pids.size) return [];
      const ns = await run('netstat', ['-ano', '-p', 'TCP']);
      for (const line of ns.split('\n')) {
        const m = /:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i.exec(line);
        if (m && pids.has(m[2])) ports.add(Number(m[1]));
      }
    } catch (_) { /* lùi về dò cổng */ }

    if (ports.size) {
      // Cổng console (chẵn) và cổng adb (+1) đều được lắng nghe, chỉ giữ cổng console
      const all = [...ports].sort((a, b) => a - b);
      const consoles = all.filter((p) => ports.has(p + 1));
      return consoles.length ? consoles : all;
    }
    // Dự phòng: không có thông tin tiến trình qemu thì dò trực tiếp (kết nối bị từ chối trả về ngay, chi phí rất nhỏ)
    const found = [];
    for (let port = 5554; port <= 5620; port += 2) {
      // eslint-disable-next-line no-await-in-loop
      if (await portAlive(port, 120)) found.push(port);
    }
    return found;
  }

  async adoptExisting({ onLog = () => {} } = {}) {
    const alive = await this.emulatorPorts();
    if (!alive.length) {
      onLog('Không tìm thấy runtime lần trước, chuẩn bị khởi động nguội');
      return null;
    }
    onLog(`Phát hiện ${alive.length} runtime còn sót (cổng ${alive.join(', ')}), đang thử tiếp quản`);

    // adb server có thể còn giữ bản ghi offline của tiến trình trước (emulator từng khởi động lại adbd sẽ vậy),
    // dọn trước rồi mới kết nối, nếu không get-state mãi trả offline, sẽ đánh giá nhầm là "chưa sẵn sàng" mà giết máy đang chạy tốt.
    await this.client().exec(['kill-server'], { withSerial: false, timeout: 8000 }).catch(() => {});

    for (const port of alive) {
      const serial = `127.0.0.1:${port + 1}`;
      const c = this.client(serial);
      let booted = '';
      for (let i = 0; i < 6 && booted !== '1'; i += 1) {
        // eslint-disable-next-line no-await-in-loop
        await c.connect().catch(() => false);
        // eslint-disable-next-line no-await-in-loop
        const state = (await c.exec(['get-state'], { timeout: 5000 }).then((r) => r.stdout).catch(() => '')).trim();
        if (state === 'device') {
          // eslint-disable-next-line no-await-in-loop
          booted = (await c.shell('getprop sys.boot_completed', { timeout: 6000 }).catch(() => '')).trim();
        }
        if (booted !== '1') await new Promise((r) => setTimeout(r, 700));
      }
      if (booted !== '1') {
        onLog(`Phát hiện runtime lần trước (${serial}) nhưng chưa sẵn sàng, tắt nó trước rồi khởi động lại`);
        // Thư mục AVD có khóa: giữ máy này sẽ khiến instance mới thoát ngay, biểu hiện thành "kiểu gì cũng không khởi động được".
        // adb cũng không kết nối được nữa, chỉ có thể tìm tiến trình theo cổng console rồi kill cưỡng bức.
        const pid = await this.pidOnPort(port);
        if (pid) {
          await new Promise((resolve) => {
            const { execFile } = require('child_process');
            execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
          });
        }
        await new Promise((r) => setTimeout(r, 1200));
        continue;
      }
      this.emuSerial = serial;
      this.emulator.port = port;
      store.saveSettings({ device: serial });
      onLog(`Đã tiếp quản runtime đang chạy (${serial})`);
      // eslint-disable-next-line no-await-in-loop
      await this.prepare(c);
      return { ok: true, client: c, engine: 'emulator', reused: true };
    }
    return null;
  }

  /** Tiến trình nào đang lắng nghe một cổng TCP (dùng để kill cưỡng bức emulator bị treo) */
  async pidOnPort(port) {
    return new Promise((resolve) => {
      const { execFile } = require('child_process');
      execFile('netstat', ['-ano', '-p', 'TCP'], { windowsHide: true }, (err, stdout) => {
        if (err || !stdout) return resolve(0);
        const line = stdout.split('\n').find((l) => new RegExp(`:${port}\\s`).test(l) && /LISTENING/i.test(l));
        const m = line && /(\d+)\s*$/.exec(line.trim());
        return resolve(m ? Number(m[1]) : 0);
      });
    });
  }

  /**
   * Dọn emulator mồ côi sót lại từ lần chạy trước mà chưa được tiếp quản.
   * Khi đóng ApkStart, emulator là detached, qemu vẫn sống; lần khởi động sau nó vẫn giữ khóa AVD,
   * biểu hiện là khởi động nguội FATAL ngay "Running multiple emulators with the same AVD".
   * Phần cài đặt gom về EmulatorEngine, đường thử lại (killAttempt) cũng dùng cùng một logic.
   */
  async killOrphanEmulators({ onLog = () => {} } = {}) {
    return this.emulator.killOrphanProcesses({ onLog });
  }

  /**
   * Lối vào lũy đẳng: khởi động trước và việc người dùng bấm có thể xảy ra đồng thời, dùng chung một Promise,
   * tránh hai bên mỗi bên đánh giá một lần「không trực tuyến」rồi mỗi bên khởi chạy một emulator (xung đột khóa AVD + gấp đôi bộ nhớ).
   */
  async ensure({ onLog = () => {} } = {}) {
    if (this._ensurePromise) return this._ensurePromise;
    const p = this._ensureInner({ onLog });
    this._ensurePromise = p;
    const clear = () => { if (this._ensurePromise === p) this._ensurePromise = null; };
    p.then(clear, clear);
    return p;
  }

  async _ensureInner({ onLog = () => {} } = {}) {
    const client = this.client();
    if (await client.isOnline()) {
      await this.prepare(client);
      return { ok: true, client, engine: 'builtin', reused: true };
    }

    // Lần ApkStart trước thoát thì emulator vẫn còn (lần sau mở vào ngay), nhưng tiến trình mới không có
    // handle của nó, adb server cũng có thể đã bị khởi động lại — chỉ dựa vào isOnline() sẽ cho là "không có runtime",
    // thế là lại mở thêm một máy mới. Ở đây tiếp quản emulator còn sống trước, tránh mở trùng máy tốn bộ nhớ.
    const adopted = await this.adoptExisting({ onLog });
    if (adopted) return adopted;

    // emulator sót từ phiên trước / do tiến trình khác khởi chạy: đổi cổng cũng phải dùng lại, tuyệt đối không mở trùng
    try {
      const devices = await client.devices();
      const running = devices.find((d) => /^emulator-\d+$/.test(d.serial) && d.state === 'device');
      if (running) {
        this.emuSerial = running.serial;
        const m = /(\d+)$/.exec(running.serial);
        if (m) this.emulator.port = Number(m[1]);
        const c2 = this.client(running.serial);
        await this.prepare(c2);
        return { ok: true, client: c2, engine: 'emulator', reused: true };
      }
    } catch (_) { /* không tìm thấy thì khởi chạy bình thường */ }

    // Tiến trình còn nhưng thiết bị offline (phần lớn kẹt lúc khởi động): dừng trước rồi khởi chạy lại, tránh chờ không
    if (this.emulator.running()) {
      onLog('Phát hiện runtime bị kẹt, đang khởi động lại…');
      await this.emulator.stop({ adbPath: this.adbPath() });
    }

    const s = this.settings;

    // Chế độ nâng cao: kết nối runtime có sẵn
    if (s.engine.mode === 'attach') {
      onLog('Đang dò runtime có sẵn…');
      const found = await this.probe();
      if (found.length) {
        store.saveSettings({ device: found[0].serial });
        const c2 = this.client(found[0].serial);
        if (await c2.isOnline()) {
          await this.prepare(c2);
          return { ok: true, client: c2, engine: found[0].name };
        }
      }
      return { ok: false, needsSetup: 'attach', error: 'Không tìm thấy runtime có sẵn khả dụng' };
    }

    // Mặc định: runtime đi kèm
    // Image của bản phát hành một file được nén, giải nén trước (đã giải nén rồi thì qua ngay).
    // Giải nén thất bại đừng nuốt lỗi: nếu không checkEnv() phía sau chỉ nói「còn thiếu system image」,
    // người dùng sẽ tưởng là chưa tải, chứ không phải giải nén thất bại (đầy ổ đĩa / file hỏng).
    await this.provisioner.materializeImages(onLog).catch((e) => {
      onLog(`Giải nén system image thất bại: ${e.message}`);
      this.log(`materialize failed: ${e.message}`);
    });
    const env = await this.provisioner.checkEnv();

    // Đường emulator: image chính là hệ thống, không có bước "cài vào đĩa"
    if (env.emulator.ok && env.sysimg.ok) {
      // Sau khi đóng ApkStart có thể còn sót emulator chưa được tiếp quản (qemu detached vẫn sống),
      // nó giữ khóa AVD mãi, khiến khởi động nguội FATAL ngay "Running multiple emulators with the same AVD".
      // Tiếp quản thất bại thì dọn các tiến trình mồ côi này trước rồi mới khởi động nguội, đảm bảo「đóng rồi mở」chắc chắn lên được.
      await this.killOrphanEmulators({ onLog }).catch(() => {});
      try {
        const r = await this.boot({ onLog });
        if (r.ok) return { ok: true, client: r.client, engine: 'emulator', profile: r.profile, network: r.network || null };
        return {
          ok: false, error: r.error, env,
          diagnosis: r.diagnosis, report: r.report, attempts: r.attempts, exitCode: r.exitCode,
        };
      } catch (e) {
        return { ok: false, error: e.message, env };
      }
    }

    // Đường QEMU (người dùng tự chuẩn bị ISO và đã cài vào đĩa ảo)
    if (!s.runtime.installed) {
      return {
        ok: false,
        needsSetup: env.emulator.ok ? 'sysimg' : 'provision',
        error: env.emulator.ok
          ? 'Còn thiếu system image: bấm「Tải system image」là xong'
          : 'Thành phần runtime chưa triển khai xong',
        env,
      };
    }

    try {
      const r = await this.boot({ onLog });
      if (r.ok) return { ok: true, client: r.client, engine: 'builtin' };
      return { ok: false, error: r.error };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  // ---------------- Phiên container cấp ứng dụng ----------------

  /**
   * Cách hiện thực「mở như container」:
   * Môi trường Android chỉ khởi động một lần rồi thường trú (snapshot quickboot + tiếp quản adoptExisting),
   * sau đó mỗi lần mở App chỉ là am start + gắn cửa sổ có sẵn vào, không chạy lại toàn bộ hệ thống.
   * Ở đây làm thêm ba việc giảm tải hệ thống:
   *   - Dừng tiến trình của các App người dùng khác, để môi trường chỉ chạy những gì App hiện tại cần;
   *   - Khi có cửa sổ thì cho qemu độ ưu tiên「nhường tiền cảnh」;
   *   - Chỉ bật đồng bộ file / thăm dò thông báo khi có cửa sổ (giao cho tầng UI qua callback onActive).
   */
  async beginApp(pkg, { onActive = () => {} } = {}) {
    const first = this._activeApps.size === 0;
    this._activeApps.add(pkg);
    this.touch();
    const state = container.nextSessionState([...this._activeApps], 'open', pkg);
    const s = this.settings;
    const mode = (s.engine && s.engine.priorityMode) || 'balanced';
    // Mức lập lịch khi có ứng dụng ở tiền cảnh. balanced dùng normal (không phải below):
    // below khiến qemu bị bỏ đói khi hệ thống bận, biểu hiện là giải mã video rớt khung, bấm phải đợi một chút mới phản hồi —
    // đây chính là nguyên nhân chính của「bấm không theo tay」. normal chỉ ngang hàng với desktop, không ăn thêm CPU/bộ nhớ/GPU.
    const level = mode === 'game' ? 'game' : 'normal';

    if (first) {
      // Có ứng dụng sắp mở: hoãn「lưu snapshot khi rảnh」, đừng tranh ổ đĩa lúc ứng dụng khởi động
      this.emulator.cancelSnapshotSave();
    }
    // Mỗi lần mở/chuyển về ứng dụng đều đảm bảo độ ưu tiên đúng: endApp sẽ hạ qemu rảnh xuống idle,
    // khi chuyển về nếu không nâng lại sẽ kẹt ở độ ưu tiên thấp → bấm thấy ì. setPriority là lũy đẳng,
    // khi đã đúng giá trị đích thì script bên trong không đổi, chi phí rất nhỏ.
    await this.emulator.setPriority(level).catch(() => {});
    if (first) {
      try { onActive(true); } catch (_) { /* khởi động thăm dò thất bại không ảnh hưởng việc mở ứng dụng */ }
    }

    const installed = store.getApps().map((a) => a && a.package).filter(Boolean);
    const plan = container.buildSessionCommands({
      pkg,
      installed,
      deep: !!(s.engine && s.engine.deepTrim),
      // App vừa am start xong, lúc này dọn nền có thể làm hỏng tiến trình đang vào tiền cảnh; việc dọn để ở endApp
      killBackground: false,
    });
    if (plan.commands.length) {
      await this.client().shell(plan.commands.join(' ; '), { timeout: 20000 }).catch(() => '');
    }
    this.log(container.describeSession(state, plan));
    return { ...state, plan };
  }

  /**
   * Đóng một cửa sổ ứng dụng: dừng tiến trình của nó; nếu là cửa sổ cuối cùng thì cho container vào
   * trạng thái đỗ chờ「thường trú nhưng gần như không tốn tài nguyên」(dọn nền + Android idle + hạ ưu tiên qemu).
   * Không tắt máy, không xóa AVD — lần sau mở vẫn vào ngay.
   */
  async endApp(pkg, { onIdle = () => {} } = {}) {
    this._activeApps.delete(pkg);
    await this.client().forceStop(pkg).catch(() => {});
    const state = container.nextSessionState([...this._activeApps], 'close', pkg);
    if (state.idle) {
      const s = this.settings;
      const cmds = container.buildIdleCommands({ deep: !!(s.engine && s.engine.deepTrim) });
      await this.client().shell(cmds.join(' ; '), { timeout: 15000 }).catch(() => '');
      // Ở chế độ game dù tạm thời không có cửa sổ ứng dụng cũng giữ độ ưu tiên cao,
      // nếu không lần mở sau phải nâng quyền lại, thao tác nhập đầu tiên sẽ trễ rõ rệt.
      const keepHigh = (s.engine && s.engine.priorityMode) === 'game';
      await this.emulator.setPriority(keepHigh ? 'normal' : 'idle').catch(() => {});
      // Lúc này rảnh nhất: lưu trạng thái bộ nhớ thành snapshot, lần khởi động sau khôi phục chứ không khởi động nguội
      this._armSnapshotSave(8000);
      try { onIdle(true); } catch (_) { /* ignore */ }
      this.log('Container đã đỗ chờ (Android thường trú, 0 tiến trình ứng dụng, qemu ưu tiên thấp nhất)');
    }
    return state;
  }

  get activeApps() { return [...this._activeApps]; }
  get containerIdle() { return this._activeApps.size === 0; }

  /** Cho trang cài đặt khôi phục các gói hệ thống bị vô hiệu hóa khi chuyển「cắt giảm sâu」 */
  async restoreSystemApps() {
    const cmds = container.buildRestoreCommands();
    await this.client().shell(cmds.join(' ; '), { timeout: 20000 }).catch(() => '');
    return true;
  }

  setGuestPriority(level) { return this.emulator.setPriority(level); }

  // ---------------- Thu hồi khi rảnh ----------------

  startWatchdog() {
    if (this._watchdog) return;
    this._watchdog = setInterval(async () => {
      const s = this.settings;
      const limit = (s.engine.idleShutdownMinutes || 0) * 60000;
      if (!limit) return;
      // Emulator tiếp quản không có handle proc cục bộ, vmRunning sẽ là false:
      // trước đây chỗ này return thẳng, khiến container không bao giờ được thu hồi. Đổi sang xem đồng thời adb có trực tuyến không.
      if (!this.vmRunning) {
        const online = await this.client().isOnline().catch(() => false);
        if (!online) return;
      }
      if (this._activeApps.size > 0 || Date.now() - this.lastActivity < limit) return;
      try {
        const running = await this.client().runningPackages();
        const alive = running.filter((p) => !/launcher|systemui|settings|inputmethod|android\.systemui/i.test(p));
        if (alive.length === 0) await this.stop();
        else this.lastActivity = Date.now();
      } catch (_) { /* ignore */ }
    }, 60000);
    if (this._watchdog.unref) this._watchdog.unref();
  }

  get vmRunning() { return this.emulator.running() || !!(this.vmProc && !this.vmProc.killed); }

  // ---------------- Chẩn đoán / thu gọn (cho UI gọi) ----------------

  async diagnostics() {
    const env = this.provisioner.paths();
    const checked = await this.provisioner.checkEnv();
    const profile = this.emulator.profile || doctor.autoProfile({
      settings: this.settings,
      accel: checked.accel,
      emulatorVersion: checked.emulator.version || '',
      diskMB: doctor.freeDiskMB(store.DATA_DIR),
    });
    // attempts trong bộ nhớ chỉ có hiệu lực trong phiên này; người dùng khởi động lại rồi xuất báo cáo thì nó rỗng.
    // Lúc đó dùng bản ghi thất bại đã lưu đĩa lần trước, kèm phần cuối emulator.log — nếu không báo cáo
    // chỉ có một câu UNKNOWN, không thấy nguyên nhân thật (issue #20/#25 đều vấp ở đây).
    const persisted = this.emulator.lastFailure ? this.emulator.lastFailure() : null;
    const liveAttempts = this.emulator.attempts || [];
    const attempts = liveAttempts.length ? liveAttempts : ((persisted && persisted.attempts) || []);
    const diagnosis = this.emulator.lastDiagnosis || (persisted && persisted.diagnosis) || null;
    const exitCode = this.emulator.lastExitCode != null ? this.emulator.lastExitCode
      : (persisted ? persisted.exitCode : null);
    let logLines = this.emulator.recentLog(300);
    if (!logLines.length && this.emulator.tailLogFile) logLines = this.emulator.tailLogFile(300);
    return doctor.writeReport({
      dataDir: store.DATA_DIR,
      profile,
      logLines,
      extra: {
        attempts,
        diagnosis,
        exitCode,
        exitMeaning: persisted && persisted.exitMeaning ? persisted.exitMeaning : '',
        lastFailure: persisted,
        runtimeDir: env.root,
        serial: this.emuSerial,
        bootLog: this.bootLog,
      },
    });
  }

  usage() { return require('./layers').summary(this.provisioner.paths().root); }

  /**
   * Thu hồi image cũ / AVD cũ / file khóa / snapshot trong runtime.
   * Nguyên nhân gốc của「bấm dọn mà không dọn được」trước đây: khi runtime đang chạy, keepSnapshots loại trừ snapshot
   * khởi động nhanh (ram.img ≈ vài GB) của AVD hiện tại, môi trường một AVD gần như không có gì để dọn.
   * Giờ bên gọi có thể truyền rõ includeSnapshots: dừng runtime trước rồi cắt giảm, snapshot mới thực sự được thu hồi.
   */
  async cleanup({ apply = false, aggressive = false, includeSnapshots = false } = {}) {
    let stoppedVm = false;
    if (includeSnapshots && this.vmRunning) {
      await this.stop().catch(() => {});
      stoppedVm = true;
    }
    const report = require('./layers').prune(this.provisioner.paths().root, {
      apply, aggressive, keepSnapshots: !includeSnapshots && this.vmRunning,
    });
    // Nếu đã tắt máy ở giai đoạn xem trước, nhắc người dùng: dọn xong có thể tự khởi động lại runtime
    return { ...report, apply, stoppedVm };
  }

  /**
   * Đặt lại hoàn toàn dữ liệu Android (xóa phân vùng người dùng /data + ứng dụng đã cài + snapshot khởi động nhanh),
   * đưa AVD về trạng thái sạch「vừa cài hệ thống, không có app bên thứ ba nào」.
   * Mục này thực sự xóa image dữ liệu người dùng 8–16GB, phải xác nhận hai lần (UI phụ trách), và chỉ động tới
   * AVD đang hoạt động (apkstart.avd), không động tới image nền chỉ đọc, không động tới AVD khác.
   * Giữ config.ini / hardware-qemu.ini, AVD vẫn hợp lệ, lần sau mở ứng dụng sẽ khởi động nguội lại để tạo dữ liệu.
   * @returns {{ok:boolean, reclaimed:number, avdDir:string, error?:string}}
   */
  async resetAndroidData() {
    const fs = require('fs');
    const path = require('path');
    try {
      if (this.vmRunning) await this.stop().catch(() => {});
      const avdDir = path.join(this.provisioner.paths().avdHome, 'apkstart.avd');
      let reclaimed = 0;
      if (fs.existsSync(avdDir)) {
        for (const e of fs.readdirSync(avdDir, { withFileTypes: true })) {
          const p = path.join(avdDir, e.name);
          // Xóa: image dữ liệu người dùng (gồm qcow2 vi sai + nền), snapshot khởi động nhanh, file khóa/thư mục khóa còn sót.
          // Giữ: config.ini / hardware-qemu.ini / AVD.conf / cache.img / encryptionkey* / initrd /
          //       modem_simulator / các loại *.ini / *.txt / *.cache — chúng là danh tính và hạ tầng của AVD,
          //       xóa thì AVD mất hiệu lực ngay hoặc lần khởi động sau bất thường. Lần sau mở ứng dụng, emulator sẽ tạo lại /data theo ngữ nghĩa -wipe-data.
          const isUserdata = /^userdata(-qemu)?(-[0-9]+)?\.img(\.qcow2)?$/.test(e.name)
            || /^userdata\.img(\.qcow2)?\.\d+$/.test(e.name);
          const isSnapshot = /^snapshots(\.stale-\d+)?$/.test(e.name);
          const isLock = /\.lock$/.test(e.name);
          if (!e.isDirectory() && !isUserdata && !isLock) continue;
          if (e.isDirectory() && !isSnapshot && !isLock) continue;
          try {
            if (e.isDirectory()) {
              const s = require('./layers').dirSize(p);
              fs.rmSync(p, { recursive: true, force: true });
              reclaimed += s;
            } else {
              const s = fs.statSync(p).size;
              fs.rmSync(p, { force: true });
              reclaimed += s;
            }
          } catch (_) { /* đang bị chiếm thì tạm bỏ qua, lần sau dọn */ }
        }
      }
      // Sau khi image dữ liệu người dùng bị xóa, bản ghi「app đã cài」phía người dùng cũng phải xóa,
      // nếu không màn hình chính/launcher vẫn hiện những app thực ra đã không còn.
      try { store.saveApps([]); } catch (_) { /* ignore */ }
      return { ok: true, reclaimed, avdDir };
    } catch (e) {
      return { ok: false, reclaimed: 0, avdDir: '', error: e.message };
    }
  }

  /**
   * Chờ máy ảo kết nối mạng.
   *
   * Thực tế: `sys.boot_completed` chỉ cho biết hệ thống đã lên, liên kết Wi-Fi + DHCP còn phải chờ thêm
   * từ mười mấy giây tới hơn một phút mới lấy được 10.0.2.16. Ứng dụng như Hongguo vừa vào là tải dữ liệu trang chủ,
   * không có mạng thì trang render thành một mảng nền đen (hộp thoại quyền riêng tư là trang cục bộ nên hiển thị bình thường),
   * người dùng thấy là「bấm Đồng ý và tiếp tục rồi màn hình đen mãi」. Nên trước khi mở ứng dụng phải chờ mạng sẵn sàng.
   *
   * @returns {Promise<{ok:boolean,reason:string,ip?:string,gateway?:string}>}
   */
  async waitForNetwork({ timeoutMs = 90000, onLog = () => {}, adbPath = '' } = {}) {
    const t0 = Date.now();
    let last = null;
    let lastNotice = 0;
    let offlineSince = 0;
    while (Date.now() - t0 < timeoutMs) {
      const online = await this.client().isOnline().catch(() => false);
      if (!online) {
        // Máy ảo vừa khởi động lại sẽ có một khoảng adb còn chưa trực tuyến, không được thấy offline là bỏ cuộc
        // (trước đây đúng là vậy: đặt lại dữ liệu xong trả về device-offline ngay, kết luận「sửa thất bại」).
        if (!offlineSince) offlineSince = Date.now();
        if (Date.now() - offlineSince > 45000) return { ok: false, reason: 'device-offline' };
      } else {
        offlineSince = 0;
        // eslint-disable-next-line no-await-in-loop
        last = await this.emulator.checkNetwork(adbPath || this.adbPath()).catch(() => null);
        if (last && last.ok) return last;
      }
      if (Date.now() - lastNotice > 10000) {
        lastNotice = Date.now();
        onLog(`Đang chờ máy ảo Android kết nối mạng… ${Math.round((Date.now() - t0) / 1000)}s`);
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, 3000));
    }
    return last || { ok: false, reason: 'timeout' };
  }

  /**
   * Sửa「máy ảo Android không có mạng」.
   * Phần lớn trường hợp chỉ là liên kết Wi-Fi chậm hơn khởi động xong, khởi động lại và chờ một chút là được,
   * **không cần** xóa dữ liệu người dùng; chỉ khi chờ hết thời gian mới nhắc người dùng dùng「Đặt lại dữ liệu Android」.
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, error?:string}>}
   */
  /**
   * Đảm bảo máy ảo có mạng: chờ trước, chờ không được thì khởi động nguội một lần (né snapshot có thể「không có mạng」) rồi chờ tiếp.
   * Đây là cách trị tận gốc「Hongguo bấm đồng ý xong màn hình đen」: ứng dụng nhất định phải khởi động sau khi mạng sẵn sàng.
   *
   * @returns {Promise<{ok:boolean,reason?:string,ip?:string,gateway?:string}>}
   */
  async ensureNetwork({ onLog = () => {}, firstWaitMs = 25000, secondWaitMs = 90000 } = {}) {
    let net = await this.waitForNetwork({ onLog, timeoutMs: firstWaitMs });
    if (net && net.ok) return net;
    // Khởi động nguội rất tốn (vài chục giây), mỗi tiến trình chỉ làm một lần: nếu không mỗi lần mở ứng dụng lại phải làm lại,
    // người dùng cảm thấy「mở ra phải đợi mấy phút」.
    if (this._netColdBootTried) return net;
    this._netColdBootTried = true;
    onLog('Mạng vẫn chưa sẵn sàng, đang khởi động nguội máy ảo một lần (không nạp snapshot) rồi thử lại…');
    try {
      await this.stop({ graceful: false }).catch(() => {});
      this.emulator.forceColdBootOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) return { ok: false, reason: 'boot-failed' };
    } catch (e) {
      return { ok: false, reason: e.message };
    }
    net = await this.waitForNetwork({ onLog, timeoutMs: secondWaitMs });
    if (net && net.ok) {
      // Mạng bình thường thì lưu snapshot ngay, lần sau khôi phục thì trạng thái card mạng cũng được khôi phục
      try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
    }
    return net;
  }

  /**
   * Sửa「máy ảo Android không có mạng」.
   * Thứ tự: khởi động nguội (không động dữ liệu) → chờ mạng → vẫn không được mới đặt lại dữ liệu (sẽ mất dữ liệu trong ứng dụng).
   *
   * @returns {Promise<{ok:boolean, network?:object, boot?:boolean, wiped?:boolean, error?:string}>}
   */
  async repairNetwork({ onLog = () => {} } = {}) {
    try {
      // Đặt lại dữ liệu luôn: thực tế đây là cách duy nhất ổn định giúp image này có mạng.
      // (Khởi động nguội trước rồi chờ 3 phút chỉ là chờ không — khởi động nguội trên dữ liệu người dùng sẵn có căn bản không kết nối được Wi-Fi.)
      onLog('Đang sửa mạng máy ảo: đặt lại dữ liệu Android và khởi động lại (danh sách ứng dụng được giữ, khi mở sẽ tự cài lại)…');
      if (this.vmRunning) await this.stop({ graceful: false }).catch(() => {});
      // Cho qemu / netsimd lần trước chút thời gian thoát sạch, nếu không -wipe-data sẽ đụng khóa AVD
      await new Promise((r) => setTimeout(r, 2500));
      this.emulator.forceWipeOnNextStart();
      const boot = await this.ensure({ onLog });
      if (!boot || !boot.ok) {
        return { ok: false, error: (boot && boot.error) || 'Máy ảo không khởi động được', boot: false, wiped: true };
      }
      const network = await this.waitForNetwork({ onLog, timeoutMs: 240000 });
      if (network && network.ok) {
        // Lưu ngay trạng thái「mạng bình thường」thành snapshot: lần sau khôi phục thì trạng thái card mạng cũng được khôi phục,
        // nếu không đóng rồi mở lại sẽ quay về trạng thái không có mạng.
        try { await this.emulator.saveSnapshotNow(this.adbPath(), { timeout: 90000 }); } catch (_) { /* ignore */ }
        onLog(`Mạng đã khôi phục (${network.ip || ''} gateway ${network.gateway || 'truy cập được'}), đã lưu snapshot dùng được.`);
      } else {
        onLog('Đặt lại rồi vẫn chưa có mạng. Hãy kiểm tra mạng/tường lửa của máy có chặn emulator không (netsimd đi qua cổng loopback cục bộ).');
      }
      return { ok: !!(network && network.ok), network, boot: true, wiped: true };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  }

  dispose() {
    if (this._watchdog) clearInterval(this._watchdog);
    if (this._client && this._client.disposeInput) this._client.disposeInput();
    this.emulator.cancelSnapshotSave();
    // Ở đây【tuyệt đối không được】kill cưỡng bức qemu:
    //  1) Kill cưỡng bức sẽ cắt cụt snapshot quickboot đang ghi đĩa, chỉ để lại vỏ rỗng ram.img vài GB,
    //     lần khởi động sau nạp thất bại → khởi động nguội toàn phần, đây chính là nguyên nhân trực tiếp của「lần nào mở cũng phải đợi hai phút」;
    //  2) Giữ nó lại, lần sau mở ApkStart có thể tiếp quản trực tiếp, bấm ứng dụng mở ngay (giống hành vi của WSA / Tencent App Store bản PC).
    // Khi gỡ cài đặt thì đi đường khác (app:removeSelf sẽ dọn tiến trình một cách tường minh).
    if (this.vmProc) {
      try { this.vmProc.kill(); } catch (_) { /* ignore */ }
      this.vmProc = null;
    }
  }

  get bootLog() { return this._bootLog.slice(-60); }
}

module.exports = { Runtime, MONITOR_PORT };
