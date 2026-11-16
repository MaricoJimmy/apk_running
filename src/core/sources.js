'use strict';
/**
 * Quản lý thống nhất nguồn tải: hai nguồn (GitHub / Gitee) + tiền tố mirror.
 *
 * Kết nối thẳng GitHub từ Trung Quốc có hai cái bẫy:
 *   1. api.github.com thường mất hàng chục giây mới phản hồi, thậm chí hết thời gian chờ — biểu hiện là "kiểm tra cập nhật quay mãi";
 *   2. Tải tài nguyên (objects.githubusercontent.com) bị giới hạn tốc độ mỗi kết nối, thường quanh 100KB/s —
 *      gói runtime 1.5 GB phải tải mất 4 tiếng.
 *
 * Vì vậy ở đây không định sẵn "nguồn chính", mà mỗi lần đều đo tốc độ bằng byte thật:
 *   - Thông tin phiên bản: hỏi GitHub / Gitee **song song**, bên nào trả về phiên bản cao hơn trước thì dùng bên đó;
 *   - Địa chỉ tải: liệt kê hết "GitHub trực tiếp / tài nguyên cùng tên trên Gitee / ghép tiền tố mirror",
 *     mỗi địa chỉ tải thật 128KB, sắp xếp theo tốc độ đo được, chọn cái nhanh nhất.
 *
 * Kết quả đo tốc độ được cache trong bộ nhớ 30 phút (trong cùng tiến trình, kiểm tra cập nhật/tải nhiều thành phần không cần đo lại).
 */
const https = require('https');
const http = require('http');
const { URL } = require('url');
const { cmpVer } = require('./version');

const OWNER_GH = 'RoutineMiku';
const OWNER_GITEE = 'daily-miku';
const REPO = 'apkstart';

const SOURCES = {
  github: {
    id: 'github',
    name: 'GitHub',
    api: `https://api.github.com/repos/${OWNER_GH}/${REPO}`,
    web: `https://github.com/${OWNER_GH}/${REPO}`,
  },
  gitee: {
    id: 'gitee',
    name: 'Gitee',
    api: `https://gitee.com/api/v5/repos/${OWNER_GITEE}/${REPO}`,
    web: `https://gitee.com/${OWNER_GITEE}/${REPO}`,
  },
};

/** Các tiền tố tăng tốc GitHub đã biết dùng được. Chỉ tham gia đo tốc độ khi người dùng bật autoMirror và chưa tùy chỉnh. */
const KNOWN_MIRRORS = [
  'https://ghfast.top/',
  'https://gh-proxy.com/',
];

/**
 * Số byte lấy mẫu cho một lần đo tốc độ.
 * 128KB quá nhỏ: riêng bắt tay + TLS đã mất vài trăm ms, "tốc độ" đo được thực chất chủ yếu là đo độ trễ,
 * sẽ đánh giá nhầm nguồn "độ trễ cao nhưng băng thông lớn" là chậm. 256KB tách được hai thứ này, lưu lượng cũng chấp nhận được.
 */
const SAMPLE_BYTES = 256 * 1024;

function openUrl(url, { timeout = 10000, headers = {}, redirects = 0, followRedirect = true } = {}) {
  return new Promise((resolve, reject) => {
    if (redirects > 6) return reject(new Error('Chuyển hướng quá nhiều lần'));
    let u;
    try { u = new URL(url); } catch (_) { return reject(new Error('Địa chỉ không hợp lệ')); }
    const mod = u.protocol === 'http:' ? http : https;
    const req = mod.request(url, {
      method: 'GET',
      timeout,
      headers: {
        'User-Agent': 'ApkStart/0.3 (Windows)',
        'Accept-Encoding': 'identity',
        ...headers,
      },
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && followRedirect) {
        res.resume();
        const next = new URL(res.headers.location, url).href;
        openUrl(next, { timeout, headers, redirects: redirects + 1, followRedirect }).then(resolve, reject);
        return;
      }
      resolve(res);
    });
    req.on('timeout', () => req.destroy(new Error('Hết thời gian kết nối')));
    req.on('error', reject);
    req.end();
  });
}

/** Lấy một đoạn JSON nhỏ (có chuyển hướng, hết thời gian chờ, giới hạn kích thước) */
async function getJson(url, timeout = 10000) {
  const res = await openUrl(url, { timeout });
  if (res.statusCode < 200 || res.statusCode >= 300) {
    res.resume();
    throw new Error(`${new URL(url).host} ${res.statusCode}`);
  }
  const chunks = [];
  let len = 0;
  await new Promise((resolve, reject) => {
    res.on('data', (c) => {
      len += c.length;
      if (len > 4 * 1024 * 1024) { res.destroy(); resolve(); return; }
      chunks.push(c);
    });
    res.on('end', resolve);
    res.on('error', reject);
  });
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/**
 * Tải thật một đoạn byte nhỏ để đo tốc độ.
 * @returns {Promise<{url:string, ok:boolean, speed:number, got:number, ms:number, error?:string}>}
 */
function measure(url, { bytes = SAMPLE_BYTES, timeoutMs = 9000 } = {}) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    let firstAt = 0;
    let got = 0;
    let settled = false;
    let req = null;
    const done = (ok, error) => {
      if (settled) return;
      settled = true;
      try { req?.destroy(); } catch (_) { /* ignore */ }
      const now = Date.now();
      // Thông lượng chỉ tính thời gian "sau khi bắt đầu nhận byte": vài trăm ms bắt tay TLS + DNS là chi phí cố định,
      // gần như không ảnh hưởng tổng thời gian với gói 1.4GB, trộn vào tốc độ sẽ làm lệch đánh giá.
      const span = Math.max(1, now - (firstAt || t0));
      resolve({
        url,
        ok: ok && got > 0,
        got,
        ms: now - t0,
        ttfb: firstAt ? firstAt - t0 : 0,
        speed: ok && got > 0 ? (got / span) * 1000 : 0,
        error,
      });
    };
    const timer = setTimeout(() => done(got > 0), timeoutMs);
    if (timer.unref) timer.unref();

    openUrl(url, {
      timeout: timeoutMs,
      headers: { Range: `bytes=0-${bytes - 1}` },
    }).then((res) => {
      req = res;
      if (res.statusCode >= 400) {
        res.resume();
        clearTimeout(timer);
        done(false, `HTTP ${res.statusCode}`);
        return;
      }
      res.on('data', (c) => {
        if (!firstAt) firstAt = Date.now();
        got += c.length;
        if (got >= bytes) { clearTimeout(timer); done(true); }
      });
      // Bản thân tài nguyên còn nhỏ hơn mẫu: đọc tới EOF cũng tính là thành công
      res.on('end', () => { clearTimeout(timer); done(got > 0); });
      res.on('error', (e) => { clearTimeout(timer); done(false, e.message); });
    }).catch((e) => { clearTimeout(timer); done(false, e.message); });
  });
}

/** Gắn tiền tố mirror vào địa chỉ tài nguyên GitHub */
function withMirror(url, prefix) {
  if (!prefix || !/^https?:\/\//i.test(prefix)) return '';
  const p = prefix.endsWith('/') ? prefix : `${prefix}/`;
  return `${p}${url}`;
}

/**
 * Tệp đính kèm release của Gitee giới hạn 100MB mỗi file, gói cài 105~110MB không vừa, nên khi phát hành được cắt thành
 * xxx.zip.part1 / xxx.zip.part2. Ở đây ghép các phần lại thành một tài nguyên logic:
 *   { name: 'xxx.zip', size: tổng, parts: [{index, size, urls:[...]}] }
 * Các phần phải liên tục bắt đầu từ part1, nếu không coi là thiếu và bỏ đi (thà dùng gói nguyên còn hơn tải một gói hỏng).
 */
function groupParts(assets) {
  const groups = new Map();
  const out = [];
  for (const a of assets) {
    const m = /^(.*)\.part(\d+)$/i.exec(String(a.name || ''));
    if (!m) { out.push(a); continue; }
    const base = m[1];
    const idx = Number(m[2]);
    let g = groups.get(base);
    if (!g) {
      g = { name: base, size: 0, parts: [], partial: true };
      groups.set(base, g);
      out.push(g);
    }
    let p = g.parts.find((x) => x.index === idx);
    if (!p) {
      p = { index: idx, size: Number(a.size) || 0, urls: [] };
      g.parts.push(p);
    }
    if (a.url && !p.urls.includes(a.url)) p.urls.push(a.url);
    if (!p.size) p.size = Number(a.size) || 0;
  }
  for (const g of groups.values()) {
    g.parts.sort((x, y) => x.index - y.index);
    const contiguous = g.parts.every((p, i) => p.index === i + 1);
    g.size = g.parts.reduce((n, p) => n + (Number(p.size) || 0), 0);
    // Lưu ý: mục tài nguyên release của Gitee chỉ có name/url, **không có size**.
    // Lấy "size>0" làm điều kiện toàn vẹn sẽ coi cả nhóm phần là thiếu và bỏ đi (đã gặp thực tế),
    // nên ở đây chỉ yêu cầu "các phần liên tục + mỗi phần có địa chỉ"; khi không biết kích thước thì tiến độ hiển thị theo số byte đã nhận.
    if (!contiguous || !g.parts.every((p) => p.urls.length)) g.broken = true;
  }
  return { list: out.filter((a) => !a.broken), broken: [...groups.values()].filter((g) => g.broken).map((g) => g.name) };
}

/** Danh sách mirror: tùy chỉnh của người dùng trước, sau đó tới tích hợp sẵn (tắt autoMirror thì chỉ dùng tùy chỉnh) */
function mirrorList(settings) {
  const r = (settings && settings.runtime) || {};
  const custom = String(r.mirrorPrefix || process.env.APKSTART_MIRROR || '').trim();
  if (custom) return [custom];
  if (r.autoMirror === false) return [];
  return KNOWN_MIRRORS.slice();
}

class Sources {
  constructor(settingsFn) {
    this.settings = typeof settingsFn === 'function' ? settingsFn : () => ({});
    this._rankCache = new Map();   // url -> {at, speed, ok}
    this._rankTtl = 30 * 60 * 1000;
    // Cache kết quả kiểm tra phiên bản: lệnh gọi ẩn danh của Gitee bị giới hạn rất chặt (vài lần liên tiếp là 403),
    // mà "có phiên bản mới hay không" vốn cũng không cần độ mới tính bằng giây.
    this._relCache = { at: 0, key: '', value: null };
    this._relTtl = 10 * 60 * 1000;
    // Ngắt mạch: khi một nguồn bị giới hạn/báo lỗi, bỏ qua nó trong một thời gian, không phải lần khởi động nào cũng đâm vào tường
    this._blocked = new Map();     // sourceId -> until(ms)
    this._blockMs = 15 * 60 * 1000;
  }

  /** Nguồn có đang trong thời gian ngắt mạch không; trả về null nghĩa là dùng được, nếu không trả về lý do hiển thị cho người dùng */
  blockedReason(id) {
    const until = this._blocked.get(id) || 0;
    if (until <= Date.now()) return null;
    return `Tạm bỏ qua (không thử lại trong ${Math.ceil((until - Date.now()) / 60000)} phút)`;
  }

  /** Release mới nhất của từng nguồn (song song, một bên lỗi không ảnh hưởng bên kia) */
  /**
   * Phương án dự phòng không phụ thuộc API: theo thẳng chuyển hướng 302 của `/releases/latest` để lấy tag.
   *
   * Vì sao bắt buộc phải có: API ẩn danh của GitHub chỉ có 60 lần mỗi giờ mỗi IP,
   * API ẩn danh của Gitee còn chặt hơn (thực tế bấm liền vài lần là 403 Rate Limit Exceeded).
   * Dưới mạng công ty/trường học, NAT của nhà mạng, người dùng rất dễ gặp "kiểm tra cập nhật thất bại" —
   * còn chuyển hướng trang web `releases/latest` đi qua CDN, không tiêu tốn hạn mức API.
   *
   * Có tag rồi thì tên tài nguyên ghép được theo quy ước phát hành:
   *   ApkStart-<tag>-win64-portable.zip / ApkStart-<version>-Setup.exe / ApkStart-runtime-<tag>.zip
   */
  async _releaseTagViaRedirect(id) {
    const s = SOURCES[id];
    const page = `${s.web}/releases/latest`;
    const res = await openUrl(page, { timeout: 9000, followRedirect: false });
    const loc = String(res.headers.location || '');
    try { res.resume(); } catch (_) { /* ignore */ }
    const m = /\/releases\/tag\/([^/?#]+)/i.exec(loc);
    return m ? decodeURIComponent(m[1]) : '';
  }

  /** Dùng tag ghép ra một release "tối thiểu dùng được" (dùng khi không có API) */
  _syntheticRelease(id, tag) {
    const s = SOURCES[id];
    const ver = String(tag).replace(/^v/i, '');
    const names = [
      `ApkStart-${tag}-win64-portable.zip`,
      `ApkStart-${ver}-Setup.exe`,
      `ApkStart-runtime-${tag}.zip`,
    ];
    // GitHub và Gitee đều hỗ trợ địa chỉ chuẩn /releases/download/<tag>/<tên file>
    // (thực tế Gitee sẽ 302 tới địa chỉ đính kèm trên foruda.gitee.com, tải được đủ byte),
    // nên không có API vẫn ghép được địa chỉ tải dùng được. Tài nguyên không có trên Gitee sẽ trả 404,
    // bước sắp xếp theo tốc độ phía sau sẽ tự bỏ qua nó.
    const assets = names.map((n) => ({
      name: n,
      size: 0,
      browser_download_url: `${s.web}/releases/download/${tag}/${n}`,
    }));
    return {
      tag_name: tag,
      name: tag,
      body: '',
      html_url: `${s.web}/releases/tag/${tag}`,
      published_at: '',
      assets,
      synthetic: true,
    };
  }

  async fetchReleases() {
    const prefs = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const ids = prefs === 'github' || prefs === 'gitee' ? [prefs] : ['github', 'gitee'];
    // API releases của repo công khai đọc ẩn danh được; nếu repo là riêng tư, Gitee sẽ trả 404
    // "Not Found Project" (chứ không phải 401), chỉ khi đó mới cần điền một token chỉ đọc ở đây.
    // Ngoài ra lệnh gọi ẩn danh bị giới hạn tần suất, người dùng quan tâm có thể điền token để tăng hạn mức.
    const token = String((this.settings().runtime || {}).giteeToken || '').trim();
    const withToken = (id, url) => (id === 'gitee' && token
      ? `${url}${url.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`
      : url);

    const jobs = ids.map(async (id) => {
      const s = SOURCES[id];
      const skip = this.blockedReason(id);
      if (skip) return { source: id, name: s.name, web: s.web, error: skip };
      try {
        const rel = await getJson(withToken(id, `${s.api}/releases/latest`), 9000);
        return { source: id, name: s.name, web: s.web, rel };
      } catch (e) {
        // Gitee không có release chính thức, hoặc GitHub bị chặn, đều lùi về lấy mục đầu tiên của danh sách
        try {
          const list = await getJson(withToken(id, `${s.api}/releases?per_page=10`), 9000);
          const first = (Array.isArray(list) ? list : []).find((r) => r && !r.draft);
          if (first) return { source: id, name: s.name, web: s.web, rel: first };
        } catch (_) { /* tiếp tục thử phương án dự phòng không phụ thuộc API */ }
        // Dự phòng khi API bị giới hạn/bị chặn: lấy tag qua chuyển hướng trang web, tên tài nguyên ghép theo quy ước
        try {
          const tag = await this._releaseTagViaRedirect(id);
          if (tag) {
            return { source: id, name: s.name, web: s.web, rel: this._syntheticRelease(id, tag), degraded: true };
          }
        } catch (_) { /* dự phòng cũng không được */ }
        const limited = /\b(403|429)\b/.test(e.message);
        if (limited) this._blocked.set(id, Date.now() + this._blockMs);
        const hint = limited
          ? ' (bị giới hạn, đã tạm ngừng dùng nguồn này một thời gian)'
          : (id === 'gitee' && !token ? ' (có thể thử lại sau, hoặc điền token chỉ đọc trong Cài đặt để tăng hạn mức)' : '');
        return { source: id, name: s.name, web: s.web, error: `${e.message}${hint}` };
      }
    });
    return Promise.all(jobs);
  }

  /**
   * Gộp phiên bản mới nhất của hai bên: số phiên bản cao hơn thắng, nhưng **danh sách tài nguyên lấy hợp**,
   * như vậy dù Gitee chỉ có metadata còn tài nguyên nằm trên GitHub, vẫn thử được cả hai đường.
   */
  async latest({ force = false } = {}) {
    const pref = String((this.settings().runtime || {}).sourcePreference || 'auto');
    const cached = this._relCache;
    if (!force && cached.value && cached.key === pref && Date.now() - cached.at < this._relTtl) {
      return cached.value;
    }
    const all = await this.fetchReleases();
    // Nguồn bị giới hạn được ghi vào ngắt mạch (đặt ở đây chứ không trong fetchReleases là để việc "ai cung cấp
    // kết quả" có thể thay thế/kiểm thử, đồng thời đảm bảo 403 từ bất kỳ lối vào nào cũng kích hoạt ngắt mạch)
    for (const x of all) {
      if (x && x.error && /\b(403|429)\b/.test(x.error)) {
        this._blocked.set(x.source, Date.now() + this._blockMs);
      }
    }
    const ok = all.filter((x) => x && x.rel);
    if (!ok.length) {
      const why = all.map((x) => `${x.name || x.source}: ${x.error || 'không có dữ liệu'}`).join('; ');
      // Tất cả đều hỏng nhưng còn kết quả lần trước: thà đưa thông tin phiên bản "có thể đã cũ",
      // còn hơn để giao diện báo lỗi thẳng — ít nhất người dùng vẫn thấy phiên bản hiện tại và lối vào trang phát hành.
      if (cached.value) return { ...cached.value, stale: true, staleReason: why };
      throw new Error(`Không kết nối được máy chủ cập nhật (${why})`);
    }
    ok.sort((a, b) => cmpVer(b.rel.tag_name || b.rel.name, a.rel.tag_name || a.rel.name));
    const top = ok[0];
    const tag = String(top.rel.tag_name || top.rel.name || '');
    const version = tag.replace(/^v/i, '');

    // Chỉ tài nguyên cùng phiên bản mới được tính (tài nguyên bản cũ từ nguồn khác không dùng để cài được).
    // Khi có cả gói nguyên cùng tên lẫn nhóm phần, ưu tiên gói nguyên: các phần phải ghép lại, thêm một điểm có thể lỗi.
    let raw = [];
    for (const item of ok) {
      const t = String(item.rel.tag_name || item.rel.name || '').replace(/^v/i, '');
      if (t !== version) continue;
      for (const a of (item.rel.assets || [])) {
        const key = String(a.name || '');
        if (!key) continue;
        // Gitee tự gắn "gói mã nguồn" làm tài nguyên (v0.3.2.zip / v0.3.2.tar.gz),
        // đây không phải gói cài, quy tắc khớp `\.zip$` sẽ coi nó là gói cập nhật và tải về — bắt buộc phải loại trừ.
        // Tài nguyên phát hành của chúng ta đều bắt đầu bằng ApkStart, dùng tiền tố này làm danh sách trắng an toàn hơn.
        if (!/^ApkStart/i.test(key)) continue;
        raw.push({
          name: key,
          size: Number(a.size) || 0,
          url: a.browser_download_url || a.url || '',
          source: item.source,
        });
      }
    }
    const grouped = groupParts(raw);
    const wholeNames = new Set(grouped.list.filter((a) => !a.partial).map((a) => a.name));
    raw = grouped.list.filter((a) => !(a.partial && wholeNames.has(a.name)));

    // Cả hai nguồn đều có tài nguyên cùng tên (sau khi gói nguyên không còn cắt phần thì đây là chuyện thường): giữ tất cả địa chỉ làm ứng viên.
    // Trước đây là "bỏ trùng theo tên, ai tới trước dùng nấy" — GitHub đứng trước, địa chỉ Gitee bị bỏ,
    // "tự chọn nguồn mạng tốt hơn" thực tế thoái hóa thành chỉ đi GitHub. Giờ chọn theo tốc độ đo thực tế (xem rank()).
    // Kích thước mỗi địa chỉ ghi riêng: gói của hai nguồn không phải cùng một bộ byte (trình nén/máy build khác nhau, có thể lệch vài MB),
    // downloadMulti chỉ trộn các địa chỉ có "tổng kích thước khai báo bằng nhau", nên tuyệt đối không được lấy trung bình kích thước hai bên.
    const assets = [];
    const byName = new Map();
    for (const a of raw) {
      const hit = byName.get(a.name);
      if (!hit) {
        const item = { ...a, urls: a.url ? [a.url] : [], sizes: {} };
        if (a.url && a.size) item.sizes[a.url] = a.size;
        byName.set(a.name, item);
        assets.push(item);
        continue;
      }
      if (a.url && !hit.urls.includes(a.url)) hit.urls.push(a.url);
      if (a.url && a.size) hit.sizes[a.url] = a.size;
      if (!hit.size && a.size) hit.size = a.size;
    }

    const result = {
      version,
      tag,
      name: top.rel.name || tag,
      notes: top.rel.body || '',
      htmlUrl: top.rel.html_url || top.web,
      publishedAt: top.rel.published_at || top.rel.created_at || '',
      assets,
      sources: ok.map((x) => ({ source: x.source, name: x.name, tag: x.rel.tag_name || x.rel.name || '' })),
      unreachable: all.filter((x) => x && x.error).map((x) => ({ source: x.source, name: x.name, error: x.error })),
      bySource: top.source,
    };
    this._relCache = { at: Date.now(), key: pref, value: result };
    return result;
  }

  /**
   * Các địa chỉ ứng viên của một tài nguyên trên mọi nguồn + mirror (bỏ trùng, giữ thứ tự: nguồn gốc trước, mirror sau).
   * Mirror chỉ gắn vào địa chỉ GitHub: ghfast / gh-proxy chỉ làm proxy cho GitHub,
   * ghép vào link Gitee chỉ nhận được 403, tốn công đo tốc độ thêm một lần.
   */
  candidates(assetOrUrl) {
    // Hỗ trợ ba kiểu tham số: một địa chỉ, đối tượng tài nguyên (url), đối tượng tài nguyên đã gộp (mảng urls, gồm cả hai nguồn)
    const urls = (typeof assetOrUrl === 'string'
      ? [assetOrUrl]
      : (assetOrUrl && (assetOrUrl.urls && assetOrUrl.urls.length ? assetOrUrl.urls : [assetOrUrl.url])))
      .filter(Boolean);
    const out = [];
    if (!urls.length) return out;
    const mirrors = mirrorList(this.settings());
    for (const url of urls) {
      if (out.includes(url)) continue;
      out.push(url);
      let host = '';
      try { host = new URL(url).host.toLowerCase(); } catch (_) { continue; }
      const isGithub = /(^|\.)github\.com$/.test(host) || /(^|\.)githubusercontent\.com$/.test(host);
      if (!isGithub) continue;
      for (const m of mirrors) {
        const u = withMirror(url, m);
        if (u && !out.includes(u)) out.push(u);
      }
    }
    return out;
  }

  /**
   * Sắp xếp các địa chỉ ứng viên theo tốc độ đo thực tế. Kết quả đo được cache 30 phút;
   * nếu đo tốc độ thất bại hết thì giữ nguyên thứ tự ban đầu (đảm bảo "trường hợp xấu nhất vẫn tải được").
   */
  async rank(urls, { onProgress } = {}) {
    const list = (urls || []).filter(Boolean);
    if (list.length <= 1) return list;
    const now = Date.now();
    const need = [];
    for (const u of list) {
      const c = this._rankCache.get(u);
      if (!c || now - c.at > this._rankTtl) need.push(u);
    }
    if (need.length) {
      onProgress?.({ stage: 'probe', message: `Đang đo tốc độ ${need.length} nguồn tải…` });
      // Đo tuần tự chứ không song song: song song sẽ tranh băng thông lẫn nhau, thứ hạng đo được thành "ai giành mạnh hơn",
      // chứ không phải "ai thực sự nhanh". Mỗi nguồn 256KB, bình thường chỉ khoảng một giây.
      // Mỗi nguồn chờ tối đa 6 giây rồi bỏ (bản cũ 9 giây × 4 nguồn = tới 36 giây không có tiến độ byte nào,
      // người dùng thấy là "kẹt ở bước chuẩn bị runtime"); đo thất bại chỉ bị xếp cuối, không ảnh hưởng việc tải.
      let i = 0;
      for (const u of need) {
        i += 1;
        let host = u;
        try { host = new URL(u).host; } catch (_) { /* địa chỉ không hợp lệ thì hiển thị nguyên văn */ }
        onProgress?.({ stage: 'probe', message: `Đang đo tốc độ nguồn ${i}/${need.length}: ${host}…` });
        // eslint-disable-next-line no-await-in-loop
        const r = await measure(u, { timeoutMs: 6000 });
        this._rankCache.set(u, { at: Date.now(), ok: r.ok, speed: r.speed });
      }
    }
    const score = (u) => {
      const c = this._rankCache.get(u);
      return c && c.ok ? c.speed : -1;
    };
    const sorted = list.slice().sort((a, b) => score(b) - score(a));
    const best = sorted[0];
    const s = score(best);
    if (s > 0) {
      onProgress?.({
        stage: 'probe',
        message: `Đã chọn nguồn nhanh nhất: ${new URL(best).host} (khoảng ${(s / 1048576).toFixed(2)} MB/s)`,
      });
    }
    return sorted;
  }

  /** Xóa cache đo tốc độ (gọi khi người dùng đổi tiền tố mirror / đổi mạng) */
  reset() {
    this._rankCache.clear();
    this._relCache = { at: 0, key: '', value: null };
    this._blocked.clear();
  }
}

module.exports = { Sources, SOURCES, measure, KNOWN_MIRRORS, withMirror, mirrorList };
