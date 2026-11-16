'use strict';
/**
 * Tự thích ứng thiết bị / tự chẩn đoán (nền tảng không cần cấu hình)
 *
 * Mục tiêu: trên mọi máy, người dùng không phải chỉnh bất kỳ tham số nào.
 *  - chooseProfile()  suy ra tham số khởi động từ RAM vật lý, CPU, ổ đĩa, trạng thái tăng tốc, phiên bản emulator;
 *  - planVariants()   đưa ra phương án thử lại「hạ cấp dần khi khởi động lỗi」(GPU → tăng tốc → RAM → khởi động nguội);
 *  - diagnose()       dịch stderr tiếng Anh của emulator thành gợi ý sửa lỗi có thể làm theo;
 *  - shortPath()      xử lý đường dẫn cài đặt có ký tự Unicode/dấu cách (QEMU của emulator cực kỳ nhạy với đường dẫn không phải ASCII).
 *
 * Module này chỉ gồm hàm thuần + dò tìm chỉ đọc, không ghi cài đặt, không khởi chạy Android, tiện cho unit test.
 */
const os = require('os');
const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const ASCII = /^[\x20-\x7e]*$/;
const isAsciiPath = (p) => ASCII.test(String(p || ''));

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

/** Hồ sơ máy (cấp mili giây, chỉ đọc) */
function hostInfo() {
  const totalMB = Math.round(os.totalmem() / 1048576);
  const freeMB = Math.round(os.freemem() / 1048576);
  const cores = Math.max(1, (os.cpus() || []).length || 2);
  const home = os.homedir();
  return {
    platform: process.platform,
    arch: process.arch,
    totalMB,
    freeMB,
    cores,
    home,
    homeAscii: isAsciiPath(home),
    tmp: os.tmpdir(),
    rdp: /RDP/i.test(String(process.env.SESSIONNAME || '')) || !!process.env.CLIENTNAME,
  };
}

/** Dung lượng trống (MB) của ổ chứa thư mục; không lấy được thì trả về 0 */
function freeDiskMB(dir) {
  try {
    let d = path.resolve(dir || '.');
    for (let i = 0; i < 6 && !fs.existsSync(d); i += 1) d = path.dirname(d);
    const st = fs.statfsSync(d);
    return Math.floor((st.bavail * st.bsize) / 1048576);
  } catch (_) {
    return 0;
  }
}

function versionNumbers(v) {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(String(v || ''));
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : [0, 0, 0];
}

/**
 * Từ emulator 36.4.9, swiftshader_indirect bị đánh dấu lỗi thời, thêm -gpu software.
 * Trên 37.x, truyền swiftshader_indirect sẽ gây lỗi khởi tạo GL/thoát luôn (khác nhau nhiều theo máy).
 * Vì vậy bắt buộc chọn ứng viên theo phiên bản, và mỗi ứng viên đều phải có đường lui.
 */
function gpuCandidates(emulatorVersion) {
  const [major, minor, patch] = versionNumbers(emulatorVersion);
  const modern = major > 36 || (major === 36 && (minor > 4 || (minor === 4 && patch >= 9)));
  return modern
    // Thứ tự chính là「độ ưu tiên thử của chế độ tự động」:
    // 1) host        —— dùng card đồ họa thật để render, ít tốn CPU nhất, mượt nhất;
    // 2) swangle     —— render phần mềm bằng ANGLE chạy trên SwiftShader. So với software/swiftshader trần,
    //                  nó thân thiện hơn nhiều với lớp tổng hợp của Android WebView (kiểu Hồng Quả/Douyin
    //                  「bấm đồng ý xong vào màn hình chính thì đen」chính là do render phần mềm trần không qua được
    //                  bước tổng hợp WebView), nên xếp thứ hai;
    // 3) software    —— SwiftShader thuần làm phương án cuối, tương thích ổn nhưng WebView dễ màn hình đen, chỉ dùng sau cùng;
    // 4) swiftshader —— tên cũ, phương án dự phòng.
    // Lưu ý safeGpu (phương án TCG khi tắt tăng tốc) vẫn lấy software, đảm bảo「chậm nhưng tương thích nhất」.
    ? ['host', 'swangle', 'software', 'swiftshader']
    : ['host', 'swiftshader_indirect', 'swiftshader'];
}

/** Đường dẫn ngắn 8.3 của Windows: tên người dùng / thư mục cài đặt có ký tự Unicode thì emulator sẽ không tìm thấy tệp */
/**
 * Thông số màn hình. Khi landscape=true trả về tấm nền ngang thực sự (1280x720).
 *
 * Vì sao phải đổi kích thước tấm nền chứ không dùng wm size lúc chạy: LCD của trình giả lập là「tấm nền vật lý」,
 * Qt mở cửa sổ theo kích thước tấm nền và dán hình vào góc trên bên trái. Đổi wm size lúc chạy chỉ đổi
 * độ phân giải logic của Android, tấm nền vật lý vẫn dọc —— kết quả là hình bị nằm nghiêng 90°, chỉ chiếm
 * một dải ở góc trên trái, xung quanh viền đen lớn, tọa độ chạm lệch. Chỉ khi thực sự đổi hw.lcd.width/height
 * sang ngang và khởi động lại mới có màn hình ngang「đứng thẳng + phủ kín」.
 */
function lcdFor({ accelOk = true, crisp = true, landscape = false } = {}) {
  const base = accelOk && crisp ? { w: 720, h: 1280, dpi: 320 } : { w: 540, h: 960, dpi: 240 };
  return landscape ? { w: base.h, h: base.w, dpi: base.dpi } : base;
}

function shortPath(p) {
  if (process.platform !== 'win32' || !p || isAsciiPath(p)) return p;
  try {
    const out = execFileSync('cmd.exe', ['/d', '/s', '/c', `for %I in ("${p}") do @echo %~sI`], {
      encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'],
    });
    const line = String(out).split(/\r?\n/).map((s) => s.trim()).filter(Boolean).pop();
    if (line && isAsciiPath(line) && fs.existsSync(line)) return line;
  } catch (_) { /* 8.3 bị tắt thì giữ nguyên đường dẫn gốc */ }
  return p;
}

/**
 * Suy ra tham số khởi động không cần cấu hình.
 * Nếu cài đặt người dùng ghi rõ engine.memoryMB / cores / gpuMode thì dùng làm giới hạn trên/ghi đè,
 * nhưng sẽ không còn vì「chưa cài」mà hard-code 4G/4 nhân làm sập máy ít RAM.
 */
/**
 *「Container nhẹ」: chỉ giới hạn đúng một thứ ảnh hưởng nhiều nhất tới độ mượt của máy chủ —— số vCPU.
 *
 * Logic cũ cấp 4 nhân cho máy 16 nhân, 4 luồng vCPU của qemu chiếm trọn nhân vật lý trong thời gian dài,
 * desktop Windows, chuột, trình duyệt chỉ giành được phần thời gian còn lại, biểu hiện là「vừa mở là giật」.
 * Thực tế chạy một ứng dụng Android thì 2 vCPU là dư dả, cấp thêm chỉ làm chậm máy chủ.
 *
 * Cố ý không đụng RAM, độ phân giải: giới hạn RAM vốn chỉ 2~3G, hạ độ phân giải còn làm vân tay
 * snapshot quickboot thay đổi, mỗi lần đổi chế độ lại phải khởi động nguội, được không bù mất.
 *
 * Hàm thuần, settings là null thì trả về null (giữ nguyên hành vi của caller cũ/unit test).
 */
function liteProfile({ host = hostInfo(), engine = {} } = {}) {
  if (engine && engine.liteMode === false) return null;
  const cores = engine && engine.resourceMode === 'save'
    ? 2
    // Logic cũ là floor(số nhân/4) rồi kẹp vào 2~3 —— máy 8 nhân chỉ được 2 vCPU, giải mã video bằng phần mềm
    // (kiểu Hồng Quả/Douyin) giật như trình chiếu. Đổi thành「một nửa số nhân vật lý, tối đa 4」:
    // 8 nhân cấp 4, 4 nhân cấp 2, desktop vẫn còn nhân dư, video cũng đủ dùng.
    : clamp(Math.floor((host.cores || 2) / 2), 2, 4);
  return { cores, priority: 'below' };
}

function chooseProfile({
  host = hostInfo(), accel, emulatorVersion = '', diskMB = 0,
  port = 5554, adbPort = 5044, overrides = {}, settings = null,
} = {}) {
  const accelOk = !!(accel && accel.ok);
  // 3GB đủ cho Android 14 và các ứng dụng phổ biến; cao hơn chỉ làm phình RAM sử dụng và kích thước snapshot quickboot
  let memoryMB = clamp(Math.floor((host.totalMB * 0.22) / 256) * 256, 2048, 3072);
  // Chế độ「tiết kiệm tài nguyên」: tải nhẹ như lướt video/đọc truyện không cần tới 3G, hạ giới hạn xuống 2G.
  // Hiệu quả trực tiếp là qemu chiếm thường trực ít hơn khoảng 1GB RAM, snapshot quickboot cũng nhỏ đi 1GB (lợi cả đồng bộ đĩa).
  // Chỉ thu hẹp khi người dùng không tự chỉ định RAM, giá trị thủ công luôn được ưu tiên.
  const rmode = settings && settings.engine && settings.engine.resourceMode;
  if (rmode === 'save' && !overrides.memoryMB) {
    memoryMB = clamp(memoryMB, 2048, 2048);
  }
  // RAM vật lý trống không đủ thì hạ xuống; Android 14 tối thiểu 2G, thấp hơn chỉ còn cách chạy TCG chậm
  if (host.freeMB && host.freeMB < memoryMB + 1024) {
    memoryMB = Math.max(2048, Math.floor((host.freeMB * 0.5) / 256) * 256);
  }
  if (overrides.memoryMB) memoryMB = clamp(Number(overrides.memoryMB) || memoryMB, 1536, 8192);

  let cores = clamp(Math.floor(host.cores / 2), 2, 4);
  if (overrides.cores) cores = clamp(Number(overrides.cores) || cores, 1, 8);
  // Chỉ khi người dùng không tự chỉ định số nhân thì chế độ nhẹ mới thu hẹp, giá trị thủ công luôn được ưu tiên
  const lite = settings ? liteProfile({ host, engine: settings.engine || {} }) : null;
  if (lite && !overrides.cores) cores = Math.min(cores, lite.cores);

  const disk = diskMB || freeDiskMB(host.tmp);
  // Dung lượng /data: bản thân ứng dụng, gói tài nguyên game và「gói cập nhật」của chúng đều nằm ở đây, 4GB quá dễ đầy
  // (biểu hiện là khi cập nhật trong ứng dụng báo「không đủ dung lượng ổ đĩa」). Mặc định cấp 6/8GB theo dung lượng trống,
  // người dùng cũng có thể chỉ định trực tiếp trong cài đặt (tăng lên thì lần khởi động sau mở rộng tại chỗ, không mất dữ liệu).
  const wantGB = Number((settings && settings.engine && settings.engine.dataPartitionGB) || 0);
  const autoDataMB = disk && disk < 12288 ? 4096 : 6144;
  const dataMB = wantGB > 0 ? clamp(Math.round(wantGB * 1024), 2048, 65536) : autoDataMB;

  const gpus = gpuCandidates(emulatorVersion);
  const gpu = overrides.gpuMode && gpus.includes(overrides.gpuMode) ? overrides.gpuMode : gpus[0];

  // Độ phân giải render: khi auto thì chọn theo trạng thái tăng tốc (giả lập phần mềm hạ xuống 540x960 cho mượt)
  // Ưu tiên ngang: màn hình ngang do「kích thước tấm nền vật lý」quyết định, phải ghi vào AVD và khởi động lại mới có hiệu lực,
  // nên ở đây xác định hướng theo settings.display.landscape trước, rồi mới áp renderSize.
  const wantLandscape = !!(settings && settings.display && settings.display.landscape);
  const wantLcd = String((settings && settings.engine && settings.engine.renderSize) || 'auto');
  const lcd = /^\d{3,4}x\d{3,4}$/.test(wantLcd)
    ? (() => {
      const [w0, h0] = wantLcd.split('x').map(Number);
      // Độ phân giải người dùng chỉ định nếu không khớp hướng hiện tại thì chỉnh theo hướng (ngang lấy cạnh dài làm rộng)
      const long = Math.max(w0, h0);
      const short = Math.min(w0, h0);
      const w = wantLandscape ? long : short;
      const h = wantLandscape ? short : long;
      return { w, h, dpi: short <= 540 ? 240 : (short <= 720 ? 320 : 420) };
    })()
    : lcdFor({ accelOk, landscape: wantLandscape });

  return {
    memoryMB,
    cores,
    heapMB: memoryMB >= 3072 ? 384 : 256,
    dataMB,
    lcd,
    gpu,
    gpuCandidates: gpus,
    accel: accelOk ? 'auto' : 'off',
    accelOk,
    port,
    adbPort,
    snapshot: true,
    lite: !!lite,
    // Giả lập phần mềm thuần không tăng tốc trên Windows đúng là chạy được, nhưng Android 14 khởi động nguội có thể mất 5-10 phút
    bootTimeoutMs: accelOk ? 240000 : 600000,
    emulatorVersion,
    host,
  };
}

/**
 * Chuyển cài đặt người dùng trong「tham số nâng cao」thành overrides.
 * 0 / auto / chưa đặt đều coi là「không ghi đè」, vẫn đi suy luận tự động;
 * chỉ khi người dùng chủ động tắt RAM tự động và điền giá trị cụ thể mới có hiệu lực.
 */
function overridesFromSettings(engine = {}) {
  const e = engine || {};
  const manual = e.autoMemory === false;
  return {
    memoryMB: manual ? Number(e.memoryMB) || 0 : 0,
    cores: manual ? Number(e.cores) || 0 : 0,
    gpuMode: e.gpuMode && e.gpuMode !== 'auto' ? e.gpuMode : '',
  };
}

/**
 * Lối vào chung cho hiển thị / chẩn đoán: không cần khởi động Android vẫn tính ra tham số giống hệt lúc khởi động thật.
 * Trước đây trang cài đặt gọi thẳng chooseProfile() (không kèm phiên bản và trạng thái tăng tốc), nên trên máy 37.x
 * hiển thị nhầm swiftshader_indirect đã lỗi thời / giả lập phần mềm, không khớp với tham số chạy thật.
 */
function autoProfile({ settings = {}, accel, emulatorVersion = '', diskMB = 0, port = 5554, adbPort = 5044 } = {}) {
  return chooseProfile({
    accel, emulatorVersion, diskMB, port, adbPort, settings,
    overrides: overridesFromSettings(settings && settings.engine),
  });
}

/**
 * Ma trận thử lại khi lỗi: từ「tốt nhất」đến「bảo thủ nhất」, tối đa 4 lần.
 * Lần lượt đổi backend GPU → tắt tăng tốc phần cứng chạy TCG → giảm RAM và ép khởi động nguội, xóa snapshot.
 */
function planVariants(profile) {
  const out = [];
  const gpus = profile.gpuCandidates || [];
  const firstGpu = profile.gpu || gpus[0] || 'software';
  const safeGpu = gpus.find((g) => /software|swiftshader/.test(g)) || firstGpu;
  const ordered = [firstGpu, ...gpus.filter((g) => g !== firstGpu && /swiftshader|swangle/.test(g))].slice(0, 2);
  for (const gpu of ordered) {
    out.push({ ...profile, gpu, label: `${gpu} / ${profile.accel === 'auto' ? 'tăng tốc phần cứng' : 'giả lập phần mềm'}`, wipe: false, snapshot: true });
  }
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    label: 'Giả lập phần mềm, tắt tăng tốc (chậm nhưng tương thích nhất)',
    wipe: false,
    snapshot: false,
  });
  out.push({
    ...profile,
    gpu: safeGpu,
    accel: 'off',
    memoryMB: 2048,
    cores: 2,
    dataMB: Math.min(profile.dataMB, 2048),
    label: 'Khởi động nguội bảo thủ (RAM tối thiểu + xóa snapshot)',
    // Ở đây **tuyệt đối không được** wipe: trước kia ghi wipe:true, mà khi ổ đĩa đầy thì lần thử nào cũng lỗi,
    // thế là thử lại liên tục đã「xóa snapshot + xóa dữ liệu」luôn cả ứng dụng và dữ liệu lưu của người dùng ——
    //「ổ đĩa đầy, mở ApkStart ra thì ứng dụng mất sạch」chính là xảy ra như vậy.
    // Khi cần dựng lại userdata thì để ensureDataPartition tự quyết (nó chỉ dựng lại khi image hỏng),
    // không dựa vào -wipe-data trong tham số khởi động.
    wipe: false,
    snapshot: false,
    lastResort: true,
  });
  // Khử trùng lặp (tổ hợp gpu/accel/wipe giống nhau thì không thử lại) —— nhưng「mức cuối cùng」bắt buộc giữ:
  // nó là phương án duy nhất「không nạp snapshot」, trên máy ít RAM có thể trùng tham số hoàn toàn với mức trước.
  const seen = new Set();
  return out.filter((v) => {
    const k = `${v.gpu}|${v.accel}|${!!v.wipe}|${v.memoryMB}|${v.snapshot !== false ? 'snap' : 'nosnap'}|${v.lastResort ? 'last' : ''}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Tìm một cặp cổng trống (cổng console của emulator + cổng đăng ký adb phải là cặp chẵn/lẻ liền nhau) */
function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '127.0.0.1');
  });
}

async function freePortPair(start = 5554) {
  for (let p = start; p <= start + 40; p += 2) {
    // eslint-disable-next-line no-await-in-loop
    if (await isPortFree(p) && await isPortFree(p + 1)) return p;
  }
  return start;
}

/**
 * Cổng adb server: cố định, không dò lại.
 * Trước đây là "tìm một cổng trống từ 5044 trở lên", nhưng bản thân adb server là tiến trình thường trực, chiếm cổng đó,
 * nên mỗi lần khởi động ApkStart lại thêm một adb server (đo thực tế một phiên chạy ra 6 cái),
 * mà cổng cứ đổi, lần sau muốn tiếp quản trình giả lập lần trước thì không khớp.
 * 5044 là cổng riêng của ApkStart (adb của người dùng ở 5037), dùng cố định luôn.
 */
async function freeAdbPort(start = 5044) {
  return Number(process.env.APKSTART_ADB_PORT) || start;
}

/**
 * Vân tay cấu hình: chỉ khi「image / phân vùng dữ liệu / phiên bản engine」thay đổi mới hủy snapshot.
 * Cố ý không bao gồm GPU, cách tăng tốc, RAM —— đó là các tham số mà thử lại tự động hay đổi,
 * nếu tính vào thì mỗi lần thử lại đều kích hoạt -wipe-data, xóa sạch ứng dụng người dùng đã cài.
 */
/**
 *「Vân tay cấu hình」của snapshot quickboot: chỉ những thay đổi này làm snapshot cũ mất hiệu lực (nạp xong màn hình đen/không lên).
 *
 * Cố ý **không bao gồm dataMB**: tăng phân vùng dữ liệu thì snapshot cũ vẫn dùng được (qemu sẽ mount lại
 * theo kích thước mới), tính nó vào vân tay thì hậu quả là「người dùng chỉ muốn mở rộng, kết quả snapshot bị hủy + khởi động nguội +
 * dữ liệu bị xóa」—— đã dính một lần thực tế, cái giá là mất toàn bộ ứng dụng.
 */
function snapshotKey(plan, imageDir) {
  return crypto.createHash('sha1').update([
    imageIdentity(imageDir), plan.emulatorVersion || '', plan.api || '', plan.tag || '',
  ].join('|')).digest('hex').slice(0, 16);
}

/**
 *「Danh tính」của system image: chỉ giữ phần sau `system-images/...`.
 *
 * Image để ở ổ nào cũng không quan trọng, cùng một bộ image đổi thư mục thì không nên coi là「đổi image」——
 * nếu không, sau khi người dùng chuyển runtime từ ổ C sang ổ D (chính chúng ta khuyên làm vậy trong cài đặt),
 * sysdir trong AVD không khớp đường dẫn mới → coi là image đã đổi → -wipe-data → mất sạch ứng dụng đã cài.
 * Cái hố này thực tế đã dính, nên cả hai chỗ (cấu hình AVD, vân tay snapshot) đều phải dùng danh tính chứ không dùng đường dẫn tuyệt đối.
 */
function imageIdentity(dir) {
  const p = String(dir || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const i = p.indexOf('system-images/');
  if (i >= 0) return p.slice(i);
  return p.split('/').slice(-3).join('/');
}

// Lưu ý: các đoạn tiếng Trung trong regex re bên dưới (加速.*不可用, 内存不足, 无法启动此程序, 磁盘空间不足,
// 路径.*(无效|找不到)) khớp với output của emulator / Windows bản tiếng Trung —— cố ý giữ nguyên, không dịch.
const RULES = [
  {
    code: 'ACCESS_VIOLATION',
    // Trên Windows emulator/qemu thoát với 0xC0000005 (thập phân 3221225477):
    // thực tế thường gặp khi「driver card đồ họa / backend Vulkan sập đúng lúc guest sắp khởi động」,
    // không liên quan CPU, RAM, image (cùng máy đổi sang -gpu software thường là qua).
    // Phải xếp trước GPU_INIT: log sập thường cũng kèm thông tin khởi tạo render, xét sập trước thì chính xác hơn.
    re: /emulator exit 3221225477|exit code 3221225477|0xC0000005|STATUS_ACCESS_VIOLATION/i,
    title: 'Backend render bị sập (0xC0000005 vi phạm truy cập)',
    hint: 'Đã tự động thử lại với backend render bảo thủ hơn, và ghi nhớ để lần sau không thử backend này trước.'
      + 'Nếu lặp lại, hãy cập nhật driver card đồ họa; hoặc vào Cài đặt → Hiệu năng & tài nguyên hạ chất lượng hình, tắt Remote Desktop/GPU passthrough của máy ảo rồi thử lại.',
  },
  {
    code: 'GPU_INIT',
    // Chỉ khớp ngữ cảnh「lỗi」: log bình thường cũng có chữ Vulkan/EGL/ANGLE, không được nhận nhầm là lỗi nghiêm trọng
    re: /Failed to initialize GL emulation|Could not initialize (OpenGL|emulated framebuffer)|Failed to create .*GLES|EGL_(BAD|NOT_INITIALIZED|CONTEXT_LOST)|Failed to (load|initialize) .*vulkan|vulkan.*(failed|error)|ANGLE.*(fail|error)/i,
    title: 'Khởi tạo backend render đồ họa thất bại',
    hint: 'Đã tự động chuyển sang render phần mềm để thử lại. Nếu vẫn lỗi, hãy cập nhật driver card đồ họa, hoặc tắt Remote Desktop/GPU passthrough của máy ảo rồi thử lại.',
  },
  {
    code: 'GPU_MODE',
    re: /Unknown option|invalid .*-gpu|Unrecognized .*gpu|Unsupported gpu/i,
    title: 'Runtime hiện tại không chấp nhận chế độ GPU này',
    hint: 'Đã tự động chọn chế độ GPU khả dụng theo phiên bản runtime để thử lại (bản cũ dùng swiftshader_indirect, bản mới dùng software).',
  },
  {
    code: 'ACCEL',
    re: /x86_64 emulation currently requires hardware acceleration|acceleration.*not (installed|available|supported)|WHPX.*(not|failed)|AEHD.*(not|failed)|ERROR_ACCESS_DENIED|加速.*不可用/i,
    title: 'Tăng tốc phần cứng không khả dụng',
    hint: 'Đã tự động chuyển về giả lập phần mềm (lần khởi động đầu sẽ chậm rõ rệt). Muốn mượt, hãy bật「Virtual Machine Platform」trong「Windows Features」, hoặc cài driver AEHD rồi khởi động lại máy.',
  },
  {
    code: 'MEMORY',
    re: /Cannot allocate memory|not enough memory|commit charge|Failed to allocate|out of memory|内存不足/i,
    title: 'Cấp phát bộ nhớ thất bại',
    hint: 'Đã tự động giảm RAM và số nhân cấp cho Android. Hãy đóng bớt chương trình tốn RAM rồi thử lại.',
  },
  {
    code: 'PORT_BUSY',
    re: /port.*(in use|busy)|Address already in use|bind.*failed|Failed to (setup|bind) .*console/i,
    title: 'Cổng của trình giả lập đang bị chiếm',
    hint: 'Đã tự động đổi sang cổng trống. Nếu lặp lại, hãy thoát các trình giả lập như Nox/MuMu/BlueStacks, hoặc khởi động lại máy.',
  },
  {
    code: 'AVD_LOCK',
    re: /already running|lock file|\.lock|AVD is in use|emulator is running/i,
    title: 'Lần chạy trước còn sót tệp khóa',
    hint: 'Đã tự động dọn tệp khóa AVD và khởi chạy lại.',
  },
  {
    code: 'IMAGE',
    re: /system\.img.*(missing|not found|corrupt)|kernel-ranchu.*(missing|not found)|invalid magic|Failed to open .*\.img|APEX.*(fail|error|loop)|boot loop|verity.*fail/i,
    title: 'System image bị thiếu hoặc hỏng / không tương thích với dữ liệu người dùng cũ',
    hint: 'Đã tự động khởi động lại với dữ liệu người dùng sạch. Nếu vẫn lỗi, hãy xóa image trong「Runtime」rồi tải lại.',
  },
  {
    code: 'DLL',
    re: /0xc0000135|STATUS_DLL_NOT_FOUND|missing DLL|Qt6.*not found|MSVCP140|VCRUNTIME|无法启动此程序|The code execution cannot proceed/i,
    title: 'Thành phần runtime bị phần mềm diệt virus xóa hoặc thiếu thư viện VC++',
    hint: 'Hãy thêm thư mục ApkStart vào danh sách trắng của phần mềm diệt virus rồi giải nén lại gói cài đặt, và cài Microsoft VC++ 2015-2022 Redistributable.',
  },
  {
    code: 'DISK_FULL',
    re: /No space left|disk full|not enough space|磁盘空间不足|Không đủ dung lượng đĩa/i,
    title: 'Ổ đĩa không đủ dung lượng, không thể khởi động Android',
    hint: 'Hãy chuyển thư mục runtime (Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu runtime) sang ổ còn nhiều chỗ trống, '
      + 'hoặc tắt「Giữ snapshot khởi động nhanh」/ giảm phân vùng dữ liệu trong cài đặt. Dữ liệu Android sẽ không bị tự động xóa.',
  },
  {
    code: 'NON_ASCII',
    re: /Unicode|non-ASCII|路径.*(无效|找不到)|cannot find the path/i,
    title: 'Đường dẫn cài đặt chứa ký tự Unicode hoặc ký tự đặc biệt',
    hint: 'Đã tự động chuyển sang đường dẫn ngắn của Windows. Nếu vẫn lỗi, hãy chuyển ApkStart vào thư mục chỉ có ký tự tiếng Anh (vd. C:\\ApkStart).',
  },
  {
    // Sau khi bị buộc dừng lần trước, thư mục AVD còn sót hardware-qemu.ini.lock / multiinstance.lock,
    // trình giả lập luôn từ chối khởi động, nhưng câu báo lỗi lại dễ bị hiểu nhầm là vấn đề CPU. Phải xếp trước quy tắc CPU.
    code: 'AVD_LOCK',
    re: /Running multiple emulators with the same AVD|AVD .*is already running|hardware-qemu\.ini\.lock/i,
    title: 'Lần chạy trước không thoát bình thường, còn sót tệp khóa',
    hint: 'ApkStart sẽ tự dọn khóa còn sót và thử lại; nếu lặp lại, hãy kiểm tra xem có trình giả lập khác đang dùng chung bộ runtime này không.',
  },
  {
    code: 'CPU_FEATURE',
    re: /host doesn't support requested feature|CPUID.*not supported|unsupported CPU|missing.*(AVX|SSE4|xsave)/i,
    title: 'CPU thiếu tập lệnh mà runtime yêu cầu',
    hint: 'Trên một số CPU cũ thông báo này chỉ là cảnh báo, vẫn khởi động được; nếu thật sự không lên, hãy đổi engine trong「Runtime」sang bản cũ tương thích hơn, hoặc dùng máy hỗ trợ VT-x/AVX.',
  },

  {
    code: 'SNAPSHOT',
    re: /snapshot|Quick Boot|ram\.img|Saving state/i,
    title: 'Snapshot khởi động nhanh bị hỏng',
    hint: 'Đã tự động bỏ snapshot cũ và khởi động nguội; lần thoát bình thường tiếp theo sẽ tạo lại snapshot.',
  },
];

/** Dịch log thành {code,title,hint}, dùng cho hiển thị UI và quyết định tự thử lại */
function diagnose(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines || '')).slice(-24000);
  for (const r of RULES) {
    if (r.re.test(text)) return { code: r.code, title: r.title, hint: r.hint };
  }
  return {
    code: 'UNKNOWN',
    title: 'Runtime không hoàn tất khởi động',
    hint: 'Đã tự động thử lại với nhiều tổ hợp tham số. Có thể bấm「Xuất báo cáo chẩn đoán」để gửi log cho tác giả xác định lỗi.',
  };
}

/** Tóm tắt một dòng dễ đọc, đặt ở trang cài đặt để người dùng nâng cao biết đã tự chọn gì */
function describeProfile(p) {
  return `Tự động: ${(p.memoryMB / 1024).toFixed(1)}GB RAM · ${p.cores} nhân · render ${p.gpu} · `
    + `${p.accelOk ? 'tăng tốc phần cứng' : 'giả lập phần mềm'} · ${p.snapshot ? 'snapshot theo nhu cầu' : 'khởi động nguội'}`
    + `${p.lite ? ' · container nhẹ' : ''} · cổng ${p.port}`;
}

/** Xuất báo cáo chẩn đoán (văn bản thuần, tiện gửi email/dán issue) */
function writeReport({ dataDir, profile, logLines = [], extra = {} }) {
  const dir = path.join(dataDir, 'logs');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `diagnostic-${new Date().toISOString().replace(/[:.]/g, '-')}.txt`);
  const d = diagnose(logLines);
  const body = [
    'Báo cáo chẩn đoán ApkStart',
    `Thời gian tạo: ${new Date().toLocaleString()}`,
    '',
    '== Máy này ==',
    JSON.stringify(hostInfo(), null, 2),
    '',
    '== Cấu hình tự động ==',
    JSON.stringify(profile || {}, null, 2),
    describeProfile(profile || chooseProfile()),
    '',
    '== Chẩn đoán ==',
    `${d.code}: ${d.title}`,
    d.hint,
    '',
    '== Thông tin bổ sung ==',
    JSON.stringify(extra, null, 2),
    '',
    '== Log runtime (300 dòng cuối) ==',
    ...(Array.isArray(logLines) ? logLines.slice(-300) : String(logLines || '').split('\n')),
  ].join('\n');
  fs.writeFileSync(file, body, 'utf8');
  return { file, diagnosis: d };
}

/**
 * Kiểm tra Microsoft VC++ 2015-2022 x64 runtime đã được cài chưa.
 * Trình giả lập Android (Qt6) và qemu đều phụ thuộc vào nó; thiếu thì trên「máy khác」sẽ không khởi động được
 * (báo 0xc0000135 / thiếu MSVCP140). Bản cài đặt đã kèm sẵn vc_redist.x64.exe,
 * ở đây chỉ kiểm tra, để trước khi khởi động đưa ra gợi ý rõ ràng và lối cài đặt một chạm.
 */
function vcRedistOk() {
  if (process.platform !== 'win32') return true;
  // Xem DLL trước: msvcp140 / vcruntime140 chính là hai tệp mà Qt6 và qemu thực sự phụ thuộc.
  // Kiểm tra bằng tệp vừa không phải gọi reg.exe (một số phần mềm bảo mật chặn, lại làm chậm lần tự kiểm tra mỗi 60s),
  // vừa không báo nhầm「chưa cài」khi khóa registry bị công cụ dọn dẹp xóa.
  const sys = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32');
  try {
    if (fs.existsSync(path.join(sys, 'msvcp140.dll'))
      && fs.existsSync(path.join(sys, 'vcruntime140.dll'))) return true;
  } catch (_) { /* dự phòng bằng registry */ }

  const key = 'HKLM\\SOFTWARE\\Microsoft\\VisualStudio\\14.0\\VC\\Runtimes\\x64';
  for (const k of [key, key.replace('SOFTWARE\\', 'SOFTWARE\\WOW6432Node\\')]) {
    try {
      const out = execFileSync('reg', ['query', k, '/v', 'Installed'],
        { encoding: 'utf8', windowsHide: true, timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
      if (/Installed\s+REG_DWORD\s+0x1/i.test(out)) return true;
    } catch (_) { /* khóa không tồn tại = chưa cài */ }
  }
  return false;
}

module.exports = {
  hostInfo, freeDiskMB, isAsciiPath, shortPath, lcdFor, liteProfile,
  versionNumbers, gpuCandidates, chooseProfile, planVariants,
  overridesFromSettings, autoProfile,
  freePortPair, freeAdbPort, snapshotKey, imageIdentity,
  diagnose, describeProfile, writeReport, vcRedistOk,
};
