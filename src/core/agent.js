'use strict';
/**
 * Tác tử cửa sổ Windows: giao tiếp với tiến trình thường trực trong src/core/win/agent.ps1.
 *
 * Vì sao không spawn PowerShell mỗi lần: khi cửa sổ kéo theo chuột sẽ đổi kích thước liên tục,
 * mỗi lần khởi động powershell.exe mất 150~300ms, kéo sẽ bị giật cục.
 * Ở đây chỉ khởi động một lần, sau đó dùng TCP loopback cục bộ (mỗi dòng một JSON), mỗi vòng < 2ms.
 *
 * Tác tử có thể đảm nhận hook chuột WH_MOUSE_LL: chuột phải = quay lại / con lăn = vuốt / nút bên = tiến lùi.
 * Hook này là toàn cục, can thiệp vào mọi sự kiện chuột của hệ thống, nên chỉ cài khi "cửa sổ ứng dụng ở tiền cảnh"
 * và bật ít nhất một ánh xạ, mất focus thì gỡ ngay; callback chỉ xử lý 7 thông điệp ta quan tâm.
 * Xem setHook(on, opts).
 */
const { spawn } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');
const { EventEmitter } = require('events');

const SCRIPT = path.join(__dirname, 'win', 'agent.ps1');
const CALL_TIMEOUT = 6000;

class WinAgent extends EventEmitter {
  constructor() {
    super();
    this.proc = null;
    this.sock = null;
    this.port = 0;
    this.ready = null;
    this.buf = '';
    this.pending = [];
    this.dead = false;
    this.hooked = false;
    this.hookConf = null;
  }

  get available() { return process.platform === 'win32' && fs.existsSync(SCRIPT); }

  /** Khởi động tác tử và chờ TCP kết nối (idempotent) */
  ensure() {
    if (this.ready) return this.ready;
    this.ready = new Promise((resolve, reject) => {
      if (!this.available) { reject(new Error('Tác tử cửa sổ không khả dụng')); return; }
      let out = '';
      let settled = false;
      const proc = spawn('powershell.exe', [
        '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Port', '0',
      ], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });

      this.proc = proc;
      const fail = (e) => {
        if (settled) return;
        settled = true;
        this.ready = null;
        reject(e instanceof Error ? e : new Error(String(e)));
      };

      const onData = (chunk) => {
        out += chunk.toString('utf8');
        const m = /PORT=(\d+)/.exec(out);
        if (!m || settled) return;
        settled = true;
        this.port = Number(m[1]);
        this._connect().then(resolve).catch(fail);
      };
      proc.stdout.on('data', onData);
      proc.stderr.on('data', (d) => { out += d.toString('utf8'); });
      proc.on('error', fail);
      proc.on('exit', () => {
        const wasReady = !!this.sock;
        this.proc = null;
        this.sock = null;
        this.ready = null;
        this.hooked = false;
        this.hookConf = null;
        this._failAll('Tác tử cửa sổ đã thoát');
        if (wasReady) this.emit('exit');
        fail(new Error('Khởi động tác tử cửa sổ thất bại'));
      });
      setTimeout(() => { if (!settled) fail(new Error('Khởi động tác tử cửa sổ quá thời gian')); }, 15000);
    });
    return this.ready;
  }

  _connect() {
    return new Promise((resolve, reject) => {
      const sock = net.connect({ host: '127.0.0.1', port: this.port }, () => resolve(this));
      sock.setEncoding('utf8');
      sock.setNoDelay(true);
      sock.on('data', (d) => this._onData(d));
      sock.on('error', (e) => { reject(e); });
      sock.on('close', () => {
        this.sock = null;
        this.ready = null;
        this._failAll('Mất kết nối tới tác tử cửa sổ');
      });
      this.sock = sock;
      this.buf = '';
    });
  }

  _onData(chunk) {
    this.buf += chunk;
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i).trim();
      this.buf = this.buf.slice(i + 1);
      if (!line) continue;
      let msg = null;
      try { msg = JSON.parse(line); } catch (_) { continue; }
      // Sự kiện có kèm dữ liệu (dx/dy/nx/ny của con lăn), listener cũ chỉ cần bỏ qua tham số thừa
      if (msg.ev) { this.emit(msg.ev, msg); continue; }
      const p = this.pending.shift();
      if (p) { clearTimeout(p.timer); p.resolve(msg); }
    }
  }

  _failAll(reason) {
    const list = this.pending;
    this.pending = [];
    for (const p of list) {
      clearTimeout(p.timer);
      p.reject(new Error(reason));
    }
  }

  /** Gửi một lệnh và chờ phản hồi */
  async call(obj, timeout = CALL_TIMEOUT) {
    await this.ensure();
    if (!this.sock) throw new Error('Tác tử cửa sổ chưa kết nối');
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Tác tử cửa sổ quá thời gian: ${obj.cmd}`)), timeout);
      this.pending.push({ resolve, reject, timer });
      this.sock.write(`${JSON.stringify(obj)}\n`);
    });
  }

  // ---------------- Phương thức tiện ích ----------------

  /**
   * Khai báo "tiến trình trong những thư mục nào mới tính là của ta".
   * Phải gọi trước bootHide / embed: tác tử cửa sổ chỉ được đụng vào cửa sổ do các tiến trình này tạo.
   * Không truyền (hoặc truyền rỗng) thì tác tử không động vào cửa sổ nào — thà thỉnh thoảng sót một cửa sổ đen,
   * còn hơn giấu hoặc nhúng nhầm cửa sổ của ứng dụng Qt khác (WeChat 4.x là Qt6, MuMu, trình phát nhạc).
   * @param {string[]} dirs thư mục gốc môi trường chạy / thư mục engine đi kèm gói
   * @param {number} [appPid] pid tiến trình chính: tác tử chỉ được nhúng cửa sổ vào cửa sổ của tiến trình này,
   *        và dựa vào đó xác định "cửa sổ hiện tại của sự kiện chuột có phải của ta không" (tránh handle bị thu hồi rồi tái sử dụng)
   */
  async scope(dirs, appPid) {
    const list = (Array.isArray(dirs) ? dirs : [dirs]).filter(Boolean);
    const req = { cmd: 'scope', dirs: list.join(';') };
    if (Number(appPid) > 0) req.pid = Number(appPid);
    return this.call(req, 4000).catch(() => ({ ok: false, n: 0 }));
  }

  /** Nhúng cửa sổ trình giả lập vào cửa sổ chủ và đặt tại x,y,w,h (tọa độ vùng client của cửa sổ chủ) */
  async embed(hostHwnd, rect) {
    return this.call({
      cmd: 'embed', host: String(hostHwnd),
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
    });
  }

  async fit(rect) {
    return this.call({
      cmd: 'fit',
      x: Math.round(rect.x), y: Math.round(rect.y),
      w: Math.round(rect.w), h: Math.round(rect.h),
      // Cửa sổ Qt của trình giả lập có thêm khung EMU_PAD so với LCD, ta cho nó tràn lên trên/sang trái để đẩy khung này
      // ra khỏi vùng client; dải tràn lên thanh tiêu đề sẽ bị cắt (nếu không, bấm nút thanh tiêu đề sẽ lộ viền đen).
      clipTop: Math.round(rect.clipTop || 0),
    }, 3000);
  }

  async rotate(dir = 'left') { return this.call({ cmd: 'rotate', dir }, 8000); }
  async hide() { return this.call({ cmd: 'hide' }, 3000); }
  async show() { return this.call({ cmd: 'show' }, 3000); }
  /** Báo tác tử vào chế độ độ trễ thấp: giảm mạnh tần suất quét cửa sổ, nhường CPU cho Android kết xuất */
  async setPerformanceMode(on) { return this.call({ cmd: 'perf', on: on ? 1 : 0 }, 3000); }
  async detach() { return this.call({ cmd: 'detach' }, 5000); }
  async probe() { return this.call({ cmd: 'probe' }, 4000); }
  /** Liệt kê các cửa sổ cấp cao nhất đang hiển thị (để kiểm chứng "chỉ có giao diện phần mềm / chỉ có cửa sổ ứng dụng Android") */
  async windows() { return this.call({ cmd: 'windows' }, 4000); }

  /**
   * "Gỡ ra + giấu đi" cửa sổ đáng ngờ số một.
   * Bắt buộc gọi trước khi hủy cửa sổ chủ: khi cửa sổ cha bị hủy, Windows gắn lại cửa sổ con khác tiến trình lên desktop
   * và giữ nguyên trạng thái hiển thị — cửa sổ đen Android Emulator tự dưng xuất hiện trên desktop là từ đây.
   * Tác tử đang bận (có thể đang biên dịch C#) cũng không được kéo dài việc đóng cửa sổ, nên đặt giới hạn cứng 700ms.
   */
  async park(maxWaitMs = 700) {
    const call = this.call({ cmd: 'park' }, 2000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /**
   * Bật "ẩn thường trực": cửa sổ chính trình giả lập (QWindowIcon) + thanh công cụ + cửa sổ console đen của qemu / netsimd
   * đều không được hiện ra, trừ cửa sổ đã được embed vào cửa sổ của ta.
   * Đây là mấu chốt của "mở phần mềm chỉ thấy giao diện phần mềm": emulator khởi chạy tiến trình con console detached qemu / netsimd,
   * windowsHide của Node không áp dụng được cho chúng, chỉ có thể để tác tử cửa sổ ẩn định kỳ.
   * Nay trình giả lập còn có -qt-hide-window (ẩn ngay khi tạo cửa sổ), bảo hiểm kép, ngay khung hình đầu cũng không nháy.
   *
   * maxWaitMs: bản thân tác tử phải biên dịch rồi mới khởi động (vài trăm ms, bất thường có thể hơn chục giây). Điểm gọi nằm
   * "trước khi khởi chạy trình giả lập", tuyệt đối không để tác tử không lên được mà kéo chậm khởi động, nên đặt giới hạn cứng.
   * @param {number} maxWaitMs
   */
  async bootHide(maxWaitMs = 3000) {
    const call = this.call({ cmd: 'boothide', on: 1 }, 4000).catch(() => ({ ok: false }));
    if (!maxWaitMs) return call;
    return Promise.race([
      call,
      new Promise((resolve) => setTimeout(() => resolve({ ok: false, timeout: true }), maxWaitMs)),
    ]);
  }

  /** Tắt ẩn thường trực (bình thường không cần nữa: sau khi nhúng, chế độ ẩn tự bỏ qua cửa sổ được nhúng) */
  async bootShow() {
    return this.call({ cmd: 'boothide', on: 0 }, 4000).catch(() => ({ ok: false }));
  }

  /**
   * Bật/tắt hook chuột toàn cục (idempotent).
   * Chỉ cài khi cửa sổ ứng dụng ở tiền cảnh và bật ít nhất một ánh xạ; opts thay đổi thì không cài lại luồng,
   * chỉ gửi công tắc mới cho tác tử thường trực, tránh cài/gỡ hook liên tục khi cửa sổ focus lại / đổi cài đặt.
   * @param {boolean} on
   * @param {{rightBack?:boolean, wheel?:boolean, side?:boolean}} opts
   */
  async setHook(on, opts = {}) {
    const want = !!on;
    const conf = {
      right: !!(opts && opts.rightBack),
      wheel: !!(opts && opts.wheel),
      side: !!(opts && opts.side),
    };
    // Ở trạng thái tắt mặc định thì không khởi chạy PowerShell chỉ để "tắt" (khởi động nguội không tốn gì)
    if (!want && !this.hooked) return { ok: true, hooked: false };
    const sameConf = this.hookConf
      && this.hookConf.right === conf.right
      && this.hookConf.wheel === conf.wheel
      && this.hookConf.side === conf.side;
    if (want === this.hooked && sameConf) return { ok: true, hooked: this.hooked };
    const req = { cmd: 'hook', on: want ? 1 : 0, right: conf.right ? 1 : 0, wheel: conf.wheel ? 1 : 0, side: conf.side ? 1 : 0 };
    if (!want) {
      this.hooked = false;
      this.hookConf = null;
      return this.call(req, 3000).catch(() => ({ ok: false, hooked: false }));
    }
    const r = await this.call(req, 3000).catch(() => null);
    this.hooked = !!(r && r.hooked !== false);
    this.hookConf = this.hooked ? conf : null;
    return { ok: this.hooked, hooked: this.hooked };
  }

  /**
   * Bật/tắt map phím (hook bàn phím + chuột thô). Idempotent: cùng cấu hình thì không gửi lại.
   * @param {boolean} on
   * @param {{locked?:boolean, vks?:number[]}} opts locked = khóa chuột; vks = mã VK phải nuốt
   */
  async setKeymap(on, opts = {}) {
    const want = !!on;
    const vks = want ? (opts.vks || []).filter((v) => v > 0 && v < 256).join(',') : '';
    const locked = want && !!opts.locked;
    const key = `${want}|${locked}|${vks}`;
    if (!want && !this.keymapOn) return { ok: true, hooked: false };
    if (this.keymapKey === key) return { ok: true, hooked: want };
    this.keymapKey = key;
    this.keymapOn = want;
    const r = await this.call({ cmd: 'km', on: want ? 1 : 0, locked: locked ? 1 : 0, vks }, 3000).catch(() => null);
    if (!r) this.keymapKey = null;
    return { ok: !!r, hooked: !!(r && r.hooked), locked: !!(r && r.locked) };
  }

  dispose() {
    // Gỡ hook toàn cục trước rồi mới kết thúc tiến trình: dù tác tử bị kill cưỡng bức cũng không để lại hook trong hệ thống
    if (this.keymapOn && this.sock) {
      try { this.sock.write('{"cmd":"km","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.keymapOn = false;
    this.keymapKey = null;
    if (this.hooked && this.sock) {
      try { this.sock.write('{"cmd":"hook","on":0}\n'); } catch (_) { /* ignore */ }
    }
    this.hooked = false;
    this.hookConf = null;
    try { this.sock?.end(); } catch (_) { /* ignore */ }
    try { this.sock?.destroy(); } catch (_) { /* ignore */ }
    // Cố ý không kill tiến trình tác tử: sau khi ngắt kết nối nó tự vào trạng thái "canh gác" (xem _lingerUntil
    // trong agent.ps1). Trình giả lập có thể vẫn đang khởi động, vài chục giây sau mới hiện cửa sổ; lúc đó nếu
    // tác tử đã chết thì desktop sẽ còn lại một cửa sổ đen Android Emulator. Sau khi tiến trình trình giả lập biến mất
    // tác tử sẽ tự thoát, canh tối đa 3 phút.
    this.sock = null;
    this.proc = null;
    this.ready = null;
  }
}

module.exports = { WinAgent, AGENT_SCRIPT: SCRIPT };
