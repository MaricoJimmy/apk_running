'use strict';
/**
 * Trình tải xuống: hỗ trợ chuyển hướng, tải tiếp, callback tiến độ, kiểm tra SHA-256
 * Chỉ phụ thuộc http/https, dùng được cả ở main process lẫn test Node thuần.
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { URL } = require('url');

const UA = 'ApkStart/0.2 (Windows; +https://github.com/apkstart)';

function openStream(url, { method = 'GET', headers = {}, redirects = 0 } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Chuyển hướng quá nhiều lần'));
    const u = new URL(url);
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method,
      timeout: 30000,
      headers: { 'User-Agent': UA, 'Accept-Encoding': 'identity', ...headers },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        return resolve(openStream(next, { method, headers, redirects: redirects + 1 }));
      }
      resolve(res);
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('Hết thời gian kết nối')); });
    req.end();
  });
}

async function head(url) {
  try {
    const res = await openStream(url, { method: 'HEAD' });
    res.resume();
    return {
      status: res.statusCode,
      size: Number(res.headers['content-length']) || 0,
      type: res.headers['content-type'] || '',
    };
  } catch (e) {
    return { status: 0, size: 0, error: e.message };
  }
}

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const h = crypto.createHash('sha256');
    const s = fs.createReadStream(file);
    s.on('data', (c) => h.update(c));
    s.on('end', () => resolve(h.digest('hex')));
    s.on('error', reject);
  });
}

/**
 * Bỏ toàn bộ phần sót lại của một lần tải thất bại (file dở dang + file phụ chia khối).
 *
 * Nguyên nhân gốc của「tải đi tải lại mãi」: trước đây mọi đường thất bại chỉ ném lỗi, không xóa file, nên trong tmp
 * luôn nằm một file zip dở dang + .chunks.json. Lần sau vào thấy đã có file thì tải tiếp bằng Range,
 * hễ tổng kích thước hoặc cách chia khối từ máy chủ/nguồn khác lần trước thì không ghép được đúng byte → lại thất bại →
 * lại để lại file dở…… mỗi lần mở đều tải lại cùng một gói. Tải tiếp bản thân không sai, nhưng phải giới hạn ở trường hợp「chắc chắn
 * tải tiếp được」; một khi lần này bị phán thất bại thì hủy cả gói, lần sau làm lại sạch sẽ.
 */
function discardPartial(dest) {
  for (const p of [dest, `${dest}.chunks.json`, `${dest}.part`]) {
    try { fs.rmSync(p, { force: true }); } catch (_) { /* đang bị chiếm thì thôi */ }
  }
}

/**
 * Tải về file cục bộ (tự động tải tiếp).
 * @param {string} url
 * @param {string} dest
 * @param {object} opt { onProgress({got,total,percent,speed}), signal, expectSha256, timeoutMs }
 */
async function download(url, dest, opt = {}) {
  const { onProgress = () => {}, signal, expectSha256, retries = 2 } = opt;
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  let attempt = 0;
  try {
  for (;;) {
    attempt++;
    const existing = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
    const headers = {};
    if (existing > 0) headers.Range = `bytes=${existing}-`;

    // eslint-disable-next-line no-await-in-loop
    const res = await openStream(url, { headers });

    if (res.statusCode === 416) {
      res.resume();
      // Đã tải đầy đủ
      break;
    }
    if (res.statusCode !== 200 && res.statusCode !== 206) {
      res.resume();
      if (attempt <= retries) { await new Promise((r) => setTimeout(r, 1500)); continue; }
      discardPartial(dest);   // hết lượt thử lại: đừng để file hỏng cho lần tải tiếp sau
      throw new Error(`Tải xuống thất bại HTTP ${res.statusCode}: ${url}`);
    }

    const total = res.statusCode === 206
      ? existing + (Number(res.headers['content-length']) || 0)
      : Number(res.headers['content-length']) || 0;

    if (res.statusCode === 200 && existing > 0) {
      // Máy chủ không hỗ trợ tải tiếp, ghi lại từ đầu
      fs.rmSync(dest, { force: true });
    }

    try {
      await new Promise((resolve, reject) => {
        const startSize = res.statusCode === 206 ? existing : 0;
        let got = startSize;
        let lastTick = Date.now();
        let lastBytes = got;
        const ws = fs.createWriteStream(dest, { flags: startSize > 0 ? 'a' : 'w' });

        // Giống tải chia khối: phải đảm bảo promise chắc chắn settle.
        // Khi kết nối im lặng (bị chặn/bị giới hạn tốc độ) res không end cũng không error, pipe không bao giờ finish,
        // cả quá trình tải kẹt ở đây, người dùng thấy thanh tiến độ đứng yên mà cũng không báo lỗi.
        const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 30000;
        let settled = false;
        let idle = null;
        const finish = (err) => {
          if (settled) return;
          settled = true;
          if (idle) clearTimeout(idle);
          try { ws.destroy(); } catch (_) { /* ignore */ }
          if (err) reject(err); else resolve();
        };
        const kick = () => {
          if (settled) return;
          if (idle) clearTimeout(idle);
          idle = setTimeout(() => {
            res.destroy();
            finish(new Error('Kết nối bị đình trệ (lâu không có dữ liệu)'));
          }, idleMs);
        };
        kick();

        const onAbort = () => { res.destroy(new Error('Đã hủy')); };
        if (signal) signal.addEventListener('abort', onAbort, { once: true });

        res.on('data', (c) => {
          got += c.length;
          kick();
          const now = Date.now();
          if (now - lastTick > 400) {
            const speed = (got - lastBytes) / ((now - lastTick) / 1000);
            lastTick = now;
            lastBytes = got;
            onProgress({
              got, total,
              percent: total ? Math.min(100, (got / total) * 100) : 0,
              speed,
              eta: total && speed > 0 ? Math.max(0, (total - got) / speed) : null,
            });
          }
        });
        res.pipe(ws);
        ws.on('finish', () => finish());
        ws.on('error', (e) => finish(e));
        res.on('error', (e) => finish(e));
        res.on('close', () => { if (!res.complete) finish(new Error('Kết nối bị gián đoạn')); });
      });
    } catch (e) {
      discardPartial(dest);   // gián đoạn / hết giờ / ghi đĩa thất bại: giữ file dở chỉ khiến lần tải tiếp sau tiếp tục thất bại
      throw e;
    }

    break;
  }

  // Kết thúc: đảm bảo thanh tiến độ chạy tới 100%
  const finalSize = fs.existsSync(dest) ? fs.statSync(dest).size : 0;
  onProgress({ got: finalSize, total: finalSize, percent: 100, speed: 0, eta: 0 });

  if (expectSha256) {
    const actual = await sha256File(dest);
    if (actual.toLowerCase() !== expectSha256.toLowerCase()) {
      discardPartial(dest);
      throw new Error(`Kiểm tra thất bại: mong đợi ${expectSha256.slice(0, 12)}… thực tế ${actual.slice(0, 12)}…`);
    }
  }
  return { file: dest, size: fs.statSync(dest).size };
  } catch (e) {
    // openStream reject thẳng (bị từ chối/DNS/hết giờ) không vào try/catch của luồng ghi
    // —— chặn chung ở ngoài cùng: lỗi nào cũng bỏ phần sót lại trước.
    discardPartial(dest);
    throw e;
  }
}

/**
 * Tải song song chia khối (dành cho file lớn).
 * Một kết nối TCP đơn lẻ trên một số mirror bị giới hạn còn vài chục KB/s, tải song song nhiều khối tăng đáng kể thông lượng thực.
 * Chỉ tải song song khi「file đích chưa tồn tại」; đã có file dở thì lùi về tải tiếp một luồng, tránh mất trạng thái chia khối.
 */
async function downloadParallel(url, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 1024 * 1024,
    retries = 3,
  } = opt;

  // Đã có file dở → giao cho tải tiếp một luồng
  if (fs.existsSync(dest) && fs.statSync(dest).size > 0) {
    return download(url, dest, opt);
  }

  // Dò xem có hỗ trợ Range không
  let total = 0;
  let supportsRange = false;
  try {
    const probe = await openStream(url, { headers: { Range: 'bytes=0-0' } });
    const cr = probe.headers['content-range'];
    if (probe.statusCode === 206 && cr) {
      supportsRange = true;
      total = Number(/\/(\d+)$/.exec(cr)[1]) || 0;
    } else {
      total = Number(probe.headers['content-length']) || 0;
    }
    probe.destroy();
  } catch (_) { /* dò thất bại thì đi một luồng */ }

  if (!supportsRange || !total || total < minChunk * 2) {
    return download(url, dest, opt);
  }

  const n = Math.max(1, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.rmSync(dest, { force: true });

  // Tạo file rỗng trước và định vị tới byte cuối, tránh write về sau bị vượt biên
  const fd = fs.openSync(dest, 'w');
  fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => {
    const start = i * per;
    const end = Math.min(total - 1, start + per - 1);
    return { start, end, pos: start, done: false, tries: 0 };
  });

  let got = 0;
  let lastTick = Date.now();
  let lastBytes = 0;
  const tick = () => {
    const now = Date.now();
    if (now - lastTick < 400) return;
    const speed = (got - lastBytes) / ((now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got, total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
    });
  };

  const fetchChunk = async (c) => {
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Yêu cầu khối bị từ chối HTTP ${res.statusCode}`);
    }
    await new Promise((resolve, reject) => {
      // Phải tự chặn trường hợp「promise không bao giờ settle」: res.destroy(err) trong một số trường hợp chỉ phát
      // close mà không phát error, không có guard này thì cả một khối bị treo, toàn bộ quá trình tải đứng im.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Kết nối bị đình trệ (lâu không có dữ liệu)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Kết nối bị đình trệ (lâu không có dữ liệu)')); }, idleMs);
      };
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick();
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Kết nối bị gián đoạn')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          const ok = await fetchChunk(c);
          if (ok) return;
          throw new Error('Khối trả về không đầy đủ');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) throw new Error(`Tải khối thất bại (${c.start}-${c.end}): ${e.message}`);
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 800 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);   // hủy cả gói, đừng để file dở cho lần tải tiếp sau
    throw e;
  }
  fs.closeSync(fd);

  const size = fs.statSync(dest).size;
  onProgress({ got: size, total: size, percent: 100, speed: 0, eta: 0 });
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Tải xuống không đầy đủ: ${size}/${total} byte`);
  }
  return { file: dest, size, parallel: n };
}

/** Lần lượt thử nhiều nguồn, nguồn nào thành công thì trả về */
async function downloadAny(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // trước khi đổi nguồn xóa file dở của nguồn trước (byte giữa các nguồn không trộn được)
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await download(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`Tất cả nguồn tải đều thất bại:\n${errors.join('\n')}`);
}

/**
 * Tải đồng thời từ nhiều nguồn: cắt file thành nhiều khối, **các khối khác nhau kéo đồng thời từ các nguồn khác nhau**, cộng dồn băng thông.
 *
 * Vì sao cần: GitHub giới hạn tốc độ mỗi kết nối là chuyện thường, còn các mirror thường cũng tự giới hạn;
 * 8 kết nối cùng trỏ về một địa chỉ thì trần chính là giới hạn của địa chỉ đó. Chia 4 kết nối cho GitHub,
 * 4 cho mirror, cộng hai giới hạn lại, thực tế nhanh hơn gấp đôi.
 *
 * Điều kiện an toàn: chỉ trộn các nguồn có「tổng kích thước khai báo bằng nhau」, nếu không có thể ghép ra file hỏng;
 * nguồn nào thất bại giữa chừng thì khối của nó tự chuyển sang địa chỉ khả dụng kế tiếp để thử lại (không làm lại cả gói).
 */
async function downloadMulti(urls, dest, opt = {}) {
  const {
    connections = 8,
    onProgress = () => {},
    minChunk = 2 * 1024 * 1024,
    // Số lần thử lại của mỗi khối. 3 lần không đủ trên đường truyền「ba nguồn thì hai nguồn thỉnh thoảng đứng」:
    // gói runtime 1.4GB hễ có khối hết lượt thử lại là hủy cả gói tải lại. Cho 6 lần (mỗi nguồn hai vòng).
    // Thử lại tiếp tục từ điểm dừng (giữ c.pos), không tải lại byte đã nhận.
    retries = 6,
  } = opt;
  const idleMs = Number(opt.idleMs) > 0 ? Number(opt.idleMs) : 20000;

  const list = [...new Set((urls || []).filter(Boolean))];
  if (!list.length) throw new Error('Không có địa chỉ tải khả dụng');
  if (list.length === 1) return downloadParallel(list[0], dest, opt);

  // 1) Dò song song: tổng kích thước + có hỗ trợ Range không
  const probes = await Promise.all(list.map(async (u) => {
    try {
      const res = await openStream(u, { headers: { Range: 'bytes=0-0' } });
      const cr = res.headers['content-range'];
      const total = res.statusCode === 206 && cr ? Number(/\/(\d+)$/.exec(cr)[1]) || 0 : 0;
      res.destroy();
      return { url: u, total, ranged: !!total };
    } catch (_) {
      return { url: u, total: 0, ranged: false };
    }
  }));

  const usable = probes.filter((p) => p.ranged && p.total > 0);
  if (!usable.length) {
    return downloadAnyParallel(list, dest, opt);
  }
  // Chỉ trộn các nguồn có「tổng kích thước khai báo bằng nhau」, nếu không sẽ ghép ra file hỏng.
  // Mốc lấy **tổng kích thước của nguồn đo được nhanh nhất** (thứ tự usable chính là thứ tự tốc độ đã được rank() sắp xếp,
  // dò bằng Promise.all nhưng kết quả trả về theo thứ tự đầu vào):
  // gói do GitHub và Gitee tự nén có số byte khác nhau (chênh vài MB là bình thường),
  // trước đây luôn lấy Math.max, tức là luôn tải từ nguồn có dung lượng lớn hơn —— trên mạng trong Trung Quốc
  // lại thành「gói Gitee nhanh hơn bị loại, buộc đi gói GitHub chậm」.
  const total = usable[0].total;
  const same = usable.filter((p) => p.total === total);
  if (same.length === 1 || total < minChunk * 2) {
    return downloadParallel(same[0].url, dest, opt);
  }

  // 2) Chia khối, phân nguồn xoay vòng
  const n = Math.max(2, Math.min(connections, Math.ceil(total / minChunk)));
  const per = Math.ceil(total / n);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Tải tiếp theo khối: gói 1.4GB trên đường truyền「mirror thỉnh thoảng đứng」rất dễ có khối hết lượt thử lại,
  // một khi hủy cả gói tải lại, người dùng phải chờ thêm hơn chục phút. Ở đây ghi「khối nào đã tải xong」vào
  // file phụ, lần sau (cùng đường dẫn, cùng cách chia khối) chỉ bù các khối còn thiếu.
  const meta = `${dest}.chunks.json`;
  let doneSet = new Set();
  let resume = false;
  try {
    const m = JSON.parse(fs.readFileSync(meta, 'utf8'));
    if (m && m.total === total && m.n === n && fs.existsSync(dest) && fs.statSync(dest).size === total) {
      doneSet = new Set(m.done || []);
      resume = true;
    }
  } catch (_) { /* không có file phụ thì tải mới hoàn toàn */ }

  if (!resume) {
    fs.rmSync(dest, { force: true });
    fs.rmSync(meta, { force: true });
  }
  const fd = resume ? fs.openSync(dest, 'r+') : fs.openSync(dest, 'w');
  if (!resume) fs.ftruncateSync(fd, total);

  const chunks = Array.from({ length: n }, (_, i) => ({
    start: i * per,
    end: Math.min(total - 1, i * per + per - 1),
    pos: i * per,
    src: i % same.length,
    tries: 0,
    rotates: 0,   // bắt buộc khởi tạo rõ ràng: undefined < 2 là false, đổi nguồn sẽ không bao giờ kích hoạt
  })).filter((c) => !doneSet.has(c.start));

  const saveMeta = () => {
    try {
      fs.writeFileSync(meta, JSON.stringify({ total, n, done: [...doneSet] }));
    } catch (_) { /* không ghi được file phụ thì không ảnh hưởng việc tải */ }
  };

  // Khi tải tiếp, tính các khối đã xong vào tiến độ, phần trăm người dùng thấy không bị bắt đầu lại từ 0
  let got = resume ? [...doneSet].reduce((sum, start) => (
    sum + (Math.min(total - 1, start + per - 1) - start + 1)
  ), 0) : 0;
  let lastTick = Date.now();
  let lastBytes = got;
  const tick = (force) => {
    const now = Date.now();
    if (!force && now - lastTick < 400) return;
    const speed = (got - lastBytes) / Math.max(0.001, (now - lastTick) / 1000);
    lastTick = now;
    lastBytes = got;
    onProgress({
      got,
      total,
      percent: Math.min(100, (got / total) * 100),
      speed,
      eta: speed > 0 ? Math.max(0, (total - got) / speed) : null,
      sources: same.length,
    });
  };

  // Đổi nguồn khi chậm: khi một khối từ một nguồn chỉ chạy vài chục KB/s, chờ nó tải xong sẽ kéo cả quá trình thành
  //「kẹt ở 95% không nhúc nhích」. Chạy đủ slowAfterMs mà tốc độ trung bình dưới slowBps thì ngắt, đổi sang nguồn kế tiếp
  // (tiếp tục từ điểm dừng, không mất dữ liệu). Mỗi khối đổi tối đa 2 lần, tránh nhảy qua lại giữa mấy nguồn chậm.
  const slowAfterMs = Number(opt.slowAfterMs) > 0 ? Number(opt.slowAfterMs) : 45000;
  const slowBps = Number(opt.slowBps) > 0 ? Number(opt.slowBps) : 120 * 1024;

  const fetchChunk = async (c) => {
    const url = same[c.src % same.length].url;
    const res = await openStream(url, { headers: { Range: `bytes=${c.pos}-${c.end}` } });
    if (res.statusCode !== 206) {
      res.resume();
      throw new Error(`Khối bị từ chối HTTP ${res.statusCode}`);
    }
    const startPos = c.pos;
    const startedAt = Date.now();
    // Cùng một kết nối sau khi destroy vẫn có thể nhận thêm gói đã đệm, sẽ kích hoạt đổi nguồn lặp lại, nhảy quá nguồn,
    // nên mỗi yêu cầu chỉ cho đổi một lần.
    let rotated = false;
    await new Promise((resolve, reject) => {
      // Watchdog nhàn rỗi +「đảm bảo settle」: kết nối đã thiết lập nhưng không có byte nào tới (thường gặp
      //「TCP thông nhưng bị chặn/bị giới hạn」), chờ socket hết giờ mất 30 giây; còn res.destroy(err)
      // có thể chỉ phát close không phát error, promise sẽ không bao giờ reject —— biểu hiện là một khối treo,
      // cả quá trình tải đứng im (đã gặp thực tế). Vì vậy watchdog tự gọi finish.
      let settled = false;
      const finish = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(idle);
        if (err) reject(err); else resolve();
      };
      let idle = setTimeout(() => { res.destroy(); finish(new Error('Kết nối bị đình trệ (lâu không có dữ liệu)')); }, idleMs);
      const kick = () => {
        clearTimeout(idle);
        idle = setTimeout(() => { res.destroy(); finish(new Error('Kết nối bị đình trệ (hết giờ không có dữ liệu)')); }, idleMs);
      };
      res.on('data', (buf) => {
        try {
          fs.writeSync(fd, buf, 0, buf.length, c.pos);
        } catch (e) {
          res.destroy();
          return finish(e);
        }
        c.pos += buf.length;
        got += buf.length;
        kick();
        tick(false);
        // Chưa tải xong mà chậm tới mức không chấp nhận được → đổi nguồn (c.pos đã tiến, lần sau tiếp tục từ điểm dừng)
        const took = Date.now() - startedAt;
        if (!rotated && took > slowAfterMs && (c.rotates || 0) < 2 && c.pos <= c.end) {
          const bps = (c.pos - startPos) / (took / 1000);
          if (bps < slowBps) {
            rotated = true;
            c.rotates = (c.rotates || 0) + 1;
            // Ở đây không đẩy c.src: đổi nguồn do catch bên dưới làm thống nhất, nếu không một lần thất bại sẽ nhảy hai nguồn
            res.destroy();
            finish(new Error(`Tốc độ nguồn này quá thấp (${(bps / 1024).toFixed(0)} KB/s), đổi nguồn thử lại`));
          }
        }
      });
      res.on('end', () => finish());
      res.on('error', (e) => finish(e));
      res.on('close', () => finish(new Error('Kết nối bị gián đoạn')));
    });
    return c.pos > c.end;
  };

  try {
    await Promise.all(chunks.map(async (c) => {
      for (;;) {
        try {
          // eslint-disable-next-line no-await-in-loop
          if (await fetchChunk(c)) {
            doneSet.add(c.start);
            saveMeta();
            return;
          }
          throw new Error('Khối trả về không đầy đủ');
        } catch (e) {
          c.tries += 1;
          if (c.tries >= retries) {
            // Hết lượt thử lại: file này đã lẫn「các khối kéo từ nguồn khác nhau」, có tải tiếp cũng
            // không ghép ra đúng byte. Hủy cả gói + file phụ, lần sau làm lại sạch sẽ.
            // Trước đây ở đây chỉ saveMeta() giữ lại, kết quả mỗi lần mở đều tiếp tục từ khối hỏng → tải lại vô hạn.
            discardPartial(dest);
            throw new Error(`Khối thất bại (${c.start}-${c.end}): ${e.message}`);
          }
          // Đổi sang nguồn khác thử lại: một mirror trục trặc không nên kéo sập cả quá trình tải
          c.src += 1;
          // eslint-disable-next-line no-await-in-loop
          await new Promise((r) => setTimeout(r, 600 * c.tries));
        }
      }
    }));
  } catch (e) {
    try { fs.closeSync(fd); } catch (_) { /* ignore */ }
    discardPartial(dest);
    throw e;
  }
  fs.closeSync(fd);
  fs.rmSync(meta, { force: true });

  const size = fs.statSync(dest).size;
  tick(true);
  if (size !== total) {
    discardPartial(dest);
    throw new Error(`Tải xuống không đầy đủ: ${size}/${total} byte`);
  }
  return { file: dest, size, parallel: n, sources: same.length, multi: true, resumed: resume };
}

/** Lần lượt thử nhiều nguồn (bản chia khối song song), nguồn nào thành công thì trả về */
async function downloadAnyParallel(urls, dest, opt = {}) {
  const errors = [];
  for (const u of urls) {
    discardPartial(dest);   // trước khi đổi nguồn xóa file dở của nguồn trước
    try {
      // eslint-disable-next-line no-await-in-loop
      const r = await downloadParallel(u, dest, opt);
      return { ...r, url: u };
    } catch (e) {
      errors.push(`${u} → ${e.message}`);
      discardPartial(dest);
    }
  }
  throw new Error(`Tất cả nguồn tải đều thất bại:\n${errors.join('\n')}`);
}

module.exports = {
  download, downloadAny, downloadParallel, downloadAnyParallel, downloadMulti,
  head, sha256File, openStream, discardPartial,
};
