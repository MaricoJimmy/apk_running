'use strict';

const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const state = {
  apps: [],
  settings: null,
  status: null,
  filter: '',
  installing: false,
  setupBusy: null,
  menuPkg: null,
};

/* ---------------- Tiện ích ---------------- */

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

function initialOf(label) {
  const t = String(label || '?').trim();
  return (t[0] || '?').toUpperCase();
}

function fmtSize(bytes) {
  if (!bytes) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${mb.toFixed(0)} MB`;
}

function relTime(ts) {
  if (!ts) return '';
  const d = Date.now() - ts;
  if (d < 60000) return 'Vừa xong';
  if (d < 3600000) return `${Math.floor(d / 60000)} phút trước`;
  if (d < 86400000) return `${Math.floor(d / 3600000)} giờ trước`;
  if (d < 86400000 * 30) return `${Math.floor(d / 86400000)} ngày trước`;
  return new Date(ts).toLocaleDateString('vi-VN');
}

/**
 * Toast mini
 *
 * Loại bỏ trùng lặp + giới hạn số lượng cho cùng một loại thông báo:
 * khi cài thất bại, "log khởi động runtime" vẫn liên tục đẩy về, trước đây mỗi dòng lại tạo một toast mới,
 * nên trên màn hình cứ chồng mãi cùng một lỗi, trông như "thông báo lỗi lặp vô tận".
 */
let _toastSeq = 0;
function toast({ title, body = '', type = 'info', progress = null, sticky = false, spinner = false }) {
  const wrap = $('toastWrap');
  // ① Bỏ trùng: cùng tiêu đề + nội dung (trong 4 giây) chỉ làm mới toast đó, không chồng thêm
  const key = `${title}|${body}`;
  const dup = [...wrap.children].find((n) => n.dataset.key === key && Date.now() - Number(n.dataset.at || 0) < 4000);
  if (dup) {
    dup.dataset.at = String(Date.now());
    return {
      el: dup,
      dismiss: () => dup.remove(),
      update: ({ title: t2, body: b2 } = {}) => {
        if (t2 !== undefined) dup.querySelector('.t-title-text').textContent = t2;
        if (b2 !== undefined) dup.querySelector('.t-body').textContent = b2;
      },
    };
  }
  // ② Giới hạn: tối đa 4 toast cùng lúc, vượt quá thì đẩy cái cũ nhất ra trước
  while (wrap.children.length >= 4) wrap.firstElementChild.remove();

  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.dataset.key = key;
  el.dataset.at = String(Date.now());
  el.dataset.seq = String(++_toastSeq);
  el.innerHTML = `
    <div class="t-title">
      ${spinner ? '<span class="spinner"></span>' : ''}
      <span class="t-title-text">${esc(title)}</span>
    </div>
    <div class="t-body">${esc(body)}</div>
    ${progress === null ? '' : '<div class="bar"><i></i></div>'}
  `;
  $('toastWrap').appendChild(el);

  const dismiss = () => {
    el.style.transition = 'opacity .18s, transform .18s';
    el.style.opacity = '0';
    el.style.transform = 'translateY(4px)';
    setTimeout(() => el.remove(), 200);
  };

  const ctl = {
    el, dismiss,
    update({ title: t2, body: b2, progress: p2, type: ty } = {}) {
      if (t2 !== undefined) el.querySelector('.t-title-text').textContent = t2;
      if (b2 !== undefined) el.querySelector('.t-body').textContent = b2;
      if (p2 !== undefined && el.querySelector('.bar i')) {
        el.querySelector('.bar i').style.width = `${Math.max(2, Math.min(100, p2))}%`;
      }
      if (ty === 'error') el.classList.add('error');
      if (ty === 'ok') {
        el.querySelector('.spinner')?.remove();
        el.classList.remove('error');
      }
    },
  };

  if (!sticky) setTimeout(dismiss, type === 'error' ? 6000 : 3200);
  return ctl;
}

/* ---------------- Hiển thị ---------------- */

function visibleApps() {
  const q = state.filter.trim().toLowerCase();
  if (!q) return state.apps;
  return state.apps.filter((a) => (
    a.label.toLowerCase().includes(q)
    || a.package.toLowerCase().includes(q)
  ));
}

function renderGrid() {
  const apps = visibleApps();
  const grid = $('grid');
  const empty = $('empty');

  const hasAny = state.apps.length > 0;
  grid.classList.toggle('hidden', apps.length === 0);
  empty.classList.toggle('hidden', apps.length > 0);

  if (!hasAny) {
    const s = state.status;
    $('emptyHint').textContent = s && s.adbOk === false
      ? 'Lần đầu dùng: mở Cài đặt ở góc trên bên phải → Runtime → Thiết lập nhanh, rồi quay lại cài ứng dụng.'
      : 'Mẹo: mọi ứng dụng dùng chung một runtime Android, nên ứng dụng thứ hai khởi động gần như tức thì.';
    grid.innerHTML = '';
    return;
  }

  grid.innerHTML = apps.map((a) => `
    <div class="card" data-pkg="${esc(a.package)}" title="${esc(a.label)} · ${esc(a.package)}">
      ${a.pinned ? '<span class="pin">★</span>' : ''}
      ${a.running ? '<span class="badge-run" title="Đang chạy"></span>' : ''}
      <div class="icon">
        ${a.iconUrl
          ? `<img src="${esc(a.iconUrl)}" alt="" draggable="false" />`
          : `<div class="fallback" style="background:${esc(a.accent || '#9aa6b2')}">${esc(initialOf(a.label))}</div>`}
      </div>
      <div class="name">${esc(a.label)}</div>
      <div class="meta">${a.running ? 'Đang chạy' : `v${esc(a.versionName)}${a.lastLaunchAt ? ' · ' + relTime(a.lastLaunchAt) : ''}`}</div>
      <div class="open-hint">${a.running ? 'Chuyển lên trước' : 'Mở'}</div>
    </div>
  `).join('');
}

/* ---------------- Làm mới dữ liệu ---------------- */

async function refreshApps() {
  try {
    state.apps = await api.listApps();
    renderGrid();
    updateStats();
  } catch (e) {
    console.error(e);
  }
}

function updateStats() {
  const n = state.apps.length;
  $('statusStats').textContent = n ? `${n} ứng dụng` : 'Chưa có ứng dụng';
}

async function refreshStatus() {
  try {
    state.status = await api.runtimeStatus();
    const s = state.status;
    const dot = $('statusDot');
    const text = $('statusText');
    const tag = $('engineTag');

    if (!s.adbOk) {
      dot.className = 'dot err';
      text.textContent = 'Chưa triển khai runtime — mở Cài đặt → Runtime, Thiết lập nhanh';
      tag.textContent = 'Cần triển khai';
      tag.className = 'brand-tag';
    } else if (s.deviceOnline) {
      dot.className = 'dot ok';
      text.textContent = `Runtime đã sẵn sàng · Android ${s.android || '?'}${s.freeform ? ' · Đã bật cửa sổ riêng' : ''}`;
      tag.textContent = `Android ${s.android || ''}`.trim();
      tag.className = 'brand-tag ok';
    } else if (s.phase === 'booting' || s.vmStarting) {
      dot.className = 'dot warn';
      text.textContent = 'Đang khởi động Android…';
      tag.textContent = 'Đang khởi động';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'accel') {
      dot.className = 'dot warn';
      text.textContent = 'Không phát hiện tăng tốc phần cứng: đã tự lùi về giả lập phần mềm (lần khởi động đầu khá chậm)';
      tag.textContent = 'Giả lập phần mềm';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'sysimg') {
      dot.className = 'dot err';
      text.textContent = 'Thiếu ảnh hệ thống chung Android 14 — tải trong Cài đặt → Runtime (khoảng 1.5GB, chỉ tải một lần)';
      tag.textContent = 'Chờ tải ảnh';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'emulator') {
      dot.className = 'dot err';
      text.textContent = 'Chưa cài engine runtime — mở Cài đặt → Runtime, Thiết lập nhanh';
      tag.textContent = 'Cần triển khai';
      tag.className = 'brand-tag';
    } else if (s.needsSetup === 'boot') {
      dot.className = 'dot warn';
      text.textContent = 'Runtime đã sẵn sàng — cài APK hoặc nhấp đúp biểu tượng desktop sẽ tự khởi động';
      tag.textContent = 'Chờ khởi động';
      tag.className = 'brand-tag';
    } else if (s.installing) {
      dot.className = 'dot warn';
      text.textContent = 'Trình cài đặt đang chạy — vui lòng hoàn tất cài đặt trong cửa sổ máy ảo';
      tag.textContent = 'Đang cài';
      tag.className = 'brand-tag';
    } else {
      dot.className = 'dot';
      text.textContent = s.installed
        ? 'Runtime đang chờ (tự bật khi cài hoặc mở ứng dụng)'
        : 'Runtime chưa cài hệ thống Android — mở Cài đặt → Runtime để tiếp tục';
      tag.textContent = s.installed ? 'Chờ' : 'Chờ cài';
      tag.className = 'brand-tag';
    }
    $('statusDevice').textContent = s.deviceOnline ? (s.serial || '') : '';

    renderSetup(s);
  } catch (e) {
    $('statusText').textContent = `Kiểm tra trạng thái thất bại: ${e.message}`;
  }
}

/* ---------------- Triển khai runtime (cố định trong Cài đặt) ---------------- */

/**
 * Bảng runtime/triển khai/tự kiểm tra giờ đều nằm trong "Cài đặt", giao diện chính chỉ giữ ứng dụng đã cài.
 * Giữ showSetup để menu khay và ui:navigate dùng lại, ý nghĩa đổi thành "mở Cài đặt và nhảy tới phần runtime".
 */
function showSetup(on) {
  if (!on) { $('setupGuide').hidden = true; return; }
  openSettings().then(() => {
    const box = $('runtimeGroup');
    if (box) box.scrollIntoView({ block: 'start', behavior: 'smooth' });
  }).catch(() => {});
}

function fmtGB(n) { return n ? `${(n / 1073741824).toFixed(2)} GB` : ''; }

function stepRow(opt) {
  const cls = ['step'];
  if (opt.done) cls.push('done');
  if (opt.busy) cls.push('busy');
  return `
    <div class="${cls.join(' ')}" data-step="${opt.key}">
      <div class="idx">${opt.done ? '✓' : opt.index}</div>
      <div class="body">
        <div class="t">${esc(opt.title)}${opt.tag ? `<span class="tag ${opt.req ? 'req' : ''}">${esc(opt.tag)}</span>` : ''}</div>
        <div class="d" data-desc>${esc(opt.desc)}</div>
        <div class="bar"><i data-bar></i></div>
      </div>
      <div class="act">${opt.actions || ''}</div>
    </div>`;
}

function renderSetup(s) {
  if (!s) return;
  const env = s.env || {};
  const hv = env.hypervisor || {};
  const accel = env.accel || s.accel || {};

  // Khởi động là thấy ngay ứng dụng đã cài: không dùng trình hướng dẫn triển khai chiếm toàn màn hình chính nữa,
  // trạng thái chỉ thể hiện ở bảng runtime trong Cài đặt + thanh trạng thái phía dưới.
  const accelOk = accel.ok || hv.whpx;
  const adbDone = !!(env.adb && env.adb.ok);
  const emuDone0 = !!(env.emulator && env.emulator.ok);
  const imgDone0 = !!(env.sysimg && env.sysimg.ok);
  const allDone0 = adbDone && emuDone0 && imgDone0;
  const stateText = $('setupStateText');
  if (stateText) {
    const missing = [];
    if (!adbDone) missing.push('adb');
    if (!emuDone0) missing.push('engine');
    if (!imgDone0) missing.push('ảnh hệ thống');
    stateText.textContent = s.deviceOnline
      ? `Đã sẵn sàng · Android ${s.android || ''}`
      : s.phase === 'booting' || s.vmStarting
        ? 'Đang khởi động Android…'
        : allDone0
          ? 'Đủ thành phần · Chờ khởi động (tự bật khi mở ứng dụng)'
          : `Thiếu ${missing.join(', ')}${accelOk ? '' : ' (không có tăng tốc phần cứng, sẽ lùi về giả lập phần mềm)'}`;
    stateText.title = s.autoProfile || accel.note || hv.note || '';
  }

  const emuDone = !!(env.emulator && env.emulator.ok);
  const imgDone = !!(env.sysimg && env.sysimg.ok);
  const busy = state.setupBusy;
  const booting = s.phase === 'booting';

  // Chỉ giữ một bước: tải về, tự thích ứng tham số, khởi động đều do "Thiết lập nhanh" nối lại,
  // và lần khởi động đầu sẽ tự chạy ở nền, người dùng không cần bấm từng bước.
  const allDone = !!(env.adb && env.adb.ok) && emuDone && imgDone;
  const left = [];
  if (!(env.adb && env.adb.ok)) left.push('bộ công cụ adb');
  if (!emuDone) left.push('runtime Android');
  if (!imgDone) left.push('ảnh hệ thống');
  const step = {
    key: 'all',
    index: 1,
    title: allDone ? 'Mọi thứ đã sẵn sàng' : 'Thiết lập nhanh',
    tag: allDone ? 'Đã tự hoàn tất' : 'Tự động',
    done: allDone,
    busy: !!busy,
    desc: s.deviceOnline
      ? `Android ${s.android || ''} đã sẵn sàng · cửa sổ ứng dụng tự khớp theo màn hình`
      : booting
        ? 'Đang khởi động Android…'
        : allDone
          ? 'Đủ thành phần, nhấp đúp bất kỳ APK hoặc biểu tượng desktop là tự khởi động'
          : `Còn thiếu ${left.join(', ')}; bấm "Thiết lập nhanh" bên dưới để cài một lần ở nền và tự khởi động`,
    actions: s.deviceOnline
      ? '<button class="btn ghost sm" data-act="vmStop">Dừng runtime</button>'
      : '',
  };

  $('setupSteps').innerHTML = stepRow(step);
  $('btnDeployAll').disabled = !!busy;
  $('btnDeployAll').textContent = busy ? 'Đang chuẩn bị…' : (allDone ? 'Đã xong · Kiểm tra lại' : 'Thiết lập nhanh');
  // "Lần trước vì sao không khởi động được" ưu tiên hiện bản ghi lỗi đã lưu: sau khi tiến trình khởi động lại, diagnosis trong bộ nhớ là rỗng,
  // chỉ hiện autoProfile thì người dùng hoàn toàn không biết nguyên nhân (báo cáo issue #20/#25 là như vậy).
  const lf = s.lastFailure;
  const lastMsg = (lf && lf.diagnosis && lf.diagnosis.title)
    ? `Lần khởi động trước thất bại: ${lf.diagnosis.title}`
    : (s.diagnosis ? `Chẩn đoán tự động lần khởi động trước: ${s.diagnosis.title}` : '');
  $('setupNote').textContent = lastMsg
    || s.autoProfile || 'Hoàn toàn tự động: không cần chọn ảnh hệ thống, bật tăng tốc hay chỉnh RAM';
}

function store_getDiskSize() {
  return (state.settings && state.settings.runtime && state.settings.runtime.diskSizeGB) || 24;
}

function setStepBusy(key, on) {
  state.setupBusy = on ? key : null;
  // Năm bước đã gộp thành một dòng, tiến độ của mọi bước con đều hiện trên thanh tiến độ duy nhất này
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (row) {
    row.classList.toggle('busy', !!on);
    if (on) {
      const bar = row.querySelector('[data-bar]');
      if (bar) bar.style.width = '3%';
    }
  }
}

function updateStepProgress(component, p) {
  if (!component) return;
  const row = $('setupSteps').querySelector('[data-step="all"]');
  if (!row) return;
  if (p.percent !== undefined) {
    const bar = row.querySelector('[data-bar]');
    if (bar) bar.style.width = `${Math.max(3, Math.min(100, p.percent))}%`;
  }
  if (p.message) {
    const d = row.querySelector('[data-desc]');
    if (d) d.textContent = p.message;
  }
}

async function deployAll() {
  if (state.setupBusy) return;
  setStepBusy('all', true);
  try {
    // Một lần gọi cài xong adb / engine / ảnh hệ thống, tiến độ hiển thị chung ở dòng duy nhất đó
    // Người dùng bấm "Triển khai nhanh" là thử lại thủ công rõ ràng, bỏ qua thời gian chờ sau thất bại
    const r = await api.autoDeploy({ force: true });
    if (!r || !r.ok) {
      toast({ title: 'Chuẩn bị thất bại', body: (r && r.error) || 'Vui lòng kiểm tra mạng rồi thử lại', type: 'error', sticky: true });
      return;
    }
    await refreshStatus();
    toast({ title: 'Thành phần đã sẵn sàng, đang tự khởi động…', body: 'Lần đầu khoảng 1-3 phút, sau đó chỉ vài giây.', type: 'info' });
    const started = await api.runtimeStart();
    await refreshStatus();
    toast(started && started.ok
      ? { title: 'Runtime đã sẵn sàng', body: 'Giờ hãy kéo APK vào cửa sổ, hoặc nhấp đúp biểu tượng desktop.', type: 'ok' }
      : { title: 'Khởi động chưa xong', body: (started && started.error) || 'Vui lòng xuất báo cáo chẩn đoán để xem nguyên nhân', type: 'error', sticky: true });
  } catch (e) {
    toast({ title: 'Chuẩn bị thất bại', body: e.message, type: 'error', sticky: true });
  } finally {
    setStepBusy('all', false);
    await refreshStatus();
    selfCheck();
  }
}

async function runStep(key) {
  if (state.setupBusy) return { ok: false, error: 'Đang có tác vụ triển khai chạy' };
  setStepBusy(key, true);
  let r;
  try {
    if (key === 'adb') r = await api.installAdb();
    else if (key === 'emulator') r = await api.installEmulator();
    else if (key === 'sysimg') r = await api.installSysimg();
    else if (key === 'accel') {
      const t = toast({
        title: 'Đang cài driver tăng tốc phần cứng…',
        body: 'Vui lòng bấm "Có" trong cửa sổ hỏi quyền hiện ra',
        sticky: true,
        spinner: true,
      });
      r = await api.enableAccel();
      if (r.ok) t.update({ title: 'Đã bật tăng tốc phần cứng', type: 'ok' });
      else t.update({ title: 'Chưa bật được tăng tốc', body: r.error, type: 'error', sticky: true });
    } else if (key === 'qemu') r = await api.installQemu();
    else if (key === 'iso') r = await api.downloadIso();
    else if (key === 'disk') r = await api.createDisk(store_getDiskSize());
    else r = { ok: false, error: 'Bước không xác định' };
  } catch (e) {
    r = { ok: false, error: e.message };
  }
  setStepBusy(key, false);
  await refreshStatus();
  return r;
}

async function startInstall() {
  const r = await api.startInstaller();
  if (!r.ok) {
    toast({ title: 'Không khởi động được môi trường cài đặt', body: r.error, type: 'error', sticky: true });
    return;
  }
  $('setupGuide').hidden = false;
  $('setupGuide').scrollIntoView({ behavior: 'smooth', block: 'start' });
  toast({ title: 'Đã mở cửa sổ máy ảo', body: 'Làm theo 6 bước bên dưới để cài; xong thì bấm "Tôi đã cài xong".', type: 'ok', sticky: true });
}

async function markInstalled() {
  await api.markInstalled();
  await api.runtimeStop();
  $('setupGuide').hidden = true;
  await refreshStatus();
  toast({ title: 'Cài xong, runtime đã tiếp quản', body: 'Giờ có thể kéo APK vào để cài.', type: 'ok' });
}



/* ---------------- Cài đặt ứng dụng ---------------- */

/** Dịch lỗi cài đặt thành "bước tiếp theo nên làm gì", chỉ gợi ý cho vài lỗi hay gặp nhất, còn lại hiện nguyên văn */
function friendlyInstallErrorText(msg) {
  const s = String(msg || 'Lỗi không xác định');
  if (/INSUFFICIENT_STORAGE|not enough space|空间不足|không đủ dung lượng|ENOSPC/i.test(s)) {
    return `${s}\nPhân vùng dữ liệu Android không đủ: Cài đặt → Hiệu năng và tài nguyên → tăng Phân vùng dữ liệu Android rồi bấm "Mở rộng ngay".`;
  }
  if (/NO_MATCHING_ABIS/i.test(s)) return `${s}\nGói này chỉ có thư viện ARM, đang tự chuyển sang ảnh tương thích rồi thử lại.`;
  if (/INSTALL_FAILED_ALREADY_EXISTS|signatures do not match/i.test(s)) {
    return `${s}\nCùng tên gói nhưng chữ ký khác (thường do từng cài từ nguồn khác). Chuột phải vào thẻ ứng dụng chọn "Gỡ cài đặt" rồi cài lại.`;
  }
  if (/INSTALL_FAILED_VERSION_DOWNGRADE/i.test(s)) return `${s}\nBản đã cài cao hơn, hãy gỡ trong menu chuột phải trước rồi cài lại.`;
  if (/ERR_FS_FILE_TOO_LARGE|greater than possible Buffer|Cannot allocate|ENOMEM|out of memory/i.test(s)) {
    return `${s}\nGói cài quá lớn hoặc thiếu bộ nhớ, hệ thống từ chối phân tích. Hãy đảm bảo đủ đĩa và RAM rồi thử lại; `
      + 'vẫn lỗi thì đổi đường dẫn gói cài thành đường dẫn ngắn toàn ký tự Latin (như D:\\a.apk).';
  }
  return s;
}

/* Toast sticky "Đang cài…" hiện tại. Sự kiện install:error phải đóng được nó:
 * tiến trình chính send('install:error') trước rồi mới cho invoke thất bại, cả hai đều có thể tới rất muộn,
 * chỉ dựa vào catch để đóng sẽ thành "báo lỗi rồi mà góc dưới phải vẫn quay". */
let installToast = null;

async function installFiles(paths) {
  if (!paths || !paths.length) return;
  if (state.installing) {
    toast({ title: 'Đang có tác vụ cài đặt', body: 'Vui lòng đợi ứng dụng hiện tại cài xong.' });
    return;
  }
  state.installing = true;
  let ok = 0;
  let failed = 0;

  for (const p of paths) {
    const name = p.split(/[\\/]/).pop();
    const t = toast({ title: `Đang cài ${name}`, body: 'Đang phân tích APK…', progress: 8, sticky: true, spinner: true });
    installToast = t;
    let off = () => {};
    try {
      off = api.on('install:progress', (pr) => {
        const base = { parse: 12, 'parse-done': 24, runtime: 38, install: 62, shortcut: 88, done: 100 }[pr.stage] || 50;
        const pct = pr.percent != null ? Math.min(60, Math.round((pr.percent / 100) * 60)) : base;
        t.update({ title: pr.meta ? `Đang cài ${pr.meta.label}` : `Đang cài ${name}`, body: pr.message, progress: pct });
      });
      const r = await api.installApk(p);
      t.update({ title: `Đã cài ${r.app.label}`, body: r.app.shortcutPath ? 'Đã tạo lối tắt desktop, nhấp đúp là mở ngay.' : 'Có thể chuột phải vào thẻ ứng dụng để tạo lối tắt desktop.', progress: 100, type: 'ok' });
      t.el.querySelector('.spinner')?.remove();
      setTimeout(t.dismiss, 3600);
      if (r.warnings && r.warnings.length) {
        toast({ title: `Lưu ý tương thích: ${r.app.label}`, body: r.warnings.join(' '), type: 'error', sticky: false });
      }
      ok++;
    } catch (e) {
      failed++;
      // Đóng toast sticky "Đang cài…" trước, nếu không nó cứ quay mãi và tiếp tục bị
      // log runtime làm mới — người dùng thấy là "thông báo lỗi lặp vô tận".
      // Thông báo lỗi do listener install:error bên dưới đảm nhận (kèm tên file và nguyên nhân dễ hiểu),
      // ở đây không bật thêm một cái nữa.
      try { off(); } catch (_) { /* ignore */ }
      t.dismiss();
      if (installToast === t) installToast = null;
    } finally {
      try { off(); } catch (_) { /* ignore */ }
    }
  }

  state.installing = false;
  await refreshApps();
  if (ok && !failed) $('search').value = '';
}

/* ---------------- Thao tác ứng dụng ---------------- */

async function launchApp(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  state.launchPkg = pkg;
  const t = toast({
    title: `Đang mở ${app ? app.label : pkg}`,
    body: 'Lần đầu cần khởi động runtime, vui lòng chờ…',
    sticky: true,
    spinner: true,
  });
  const r = await api.launch(pkg);
  if (r.ok) {
    // Ứng dụng có cửa sổ riêng, giao diện chính tự thu lại; ở đây chỉ để một câu thông báo rồi ẩn cửa sổ
    t.update({ title: 'Đã khởi động', body: 'Ứng dụng đang chạy trong cửa sổ riêng (có thể xoay màn hình ở thanh trên).', type: 'ok' });
    setTimeout(t.dismiss, 1600);
    setTimeout(() => api.winHide(), 900);
    setTimeout(refreshApps, 1200);
  } else {
    t.update({ title: 'Khởi động thất bại', body: r.error, type: 'error' });
    setTimeout(t.dismiss, 6000);
  }
}

async function createShortcut(pkg) {
  try {
    const r = await api.createShortcut(pkg);
    toast({ title: 'Đã tạo lối tắt desktop', body: r.path, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Tạo lối tắt thất bại', body: e.message, type: 'error' });
  }
}

async function uninstall(pkg) {
  const app = state.apps.find((a) => a.package === pkg);
  if (!app) return;
  const ok = window.confirm(`Gỡ cài đặt "${app.label}"?\n\nDữ liệu ứng dụng sẽ bị xóa cùng, lối tắt desktop cũng bị xóa.`);
  if (!ok) return;
  try {
    await api.uninstall(pkg);
    toast({ title: 'Đã gỡ cài đặt', body: app.label, type: 'ok' });
    refreshApps();
  } catch (e) {
    toast({ title: 'Gỡ cài đặt thất bại', body: e.message, type: 'error' });
  }
}

/* ---------------- Menu chuột phải ---------------- */

const MENU_ITEMS = [
  { key: 'open', label: 'Mở ứng dụng', kbd: 'Enter' },
  { key: 'shortcut', label: 'Tạo lối tắt desktop' },
  { key: 'pin', label: 'Ghim lên đầu' },
  { divider: true },
  { key: 'reveal', label: 'Mở vị trí file APK' },
  { key: 'clear', label: 'Xóa dữ liệu ứng dụng' },
  { divider: true },
  { key: 'uninstall', label: 'Gỡ cài đặt', danger: true },
];

function showMenu(x, y, pkg) {
  const menu = $('ctxmenu');
  state.menuPkg = pkg;
  const app = state.apps.find((a) => a.package === pkg);
  menu.innerHTML = MENU_ITEMS.map((it) => {
    if (it.divider) return '<div class="divider"></div>';
    const label = it.key === 'pin' ? (app && app.pinned ? 'Bỏ ghim' : 'Ghim lên đầu') : it.label;
    return `<div class="item ${it.danger ? 'danger' : ''}" data-act="${it.key}">
      <span>${esc(label)}</span>${it.kbd ? `<span class="k">${it.kbd}</span>` : ''}
    </div>`;
  }).join('');
  menu.classList.add('on');

  const rect = menu.getBoundingClientRect();
  menu.style.left = `${Math.min(x, window.innerWidth - rect.width - 10)}px`;
  menu.style.top = `${Math.min(y, window.innerHeight - rect.height - 10)}px`;
}

function hideMenu() {
  $('ctxmenu').classList.remove('on');
  state.menuPkg = null;
}

async function handleMenu(act) {
  const pkg = state.menuPkg;
  const app = state.apps.find((a) => a.package === pkg);
  hideMenu();
  if (!app) return;
  switch (act) {
    case 'open': return launchApp(pkg);
    case 'shortcut': return createShortcut(pkg);
    case 'pin': return api.pin(pkg, !app.pinned).then(refreshApps);
    case 'reveal': return api.revealApk(pkg);
    case 'clear': {
      if (!window.confirm(`Xóa toàn bộ dữ liệu của "${app.label}"? Thao tác này không thể hoàn tác.`)) return;
      try {
        await api.clearData(pkg);
        toast({ title: 'Đã xóa dữ liệu', body: app.label, type: 'ok' });
      } catch (e) {
        toast({ title: 'Xóa thất bại', body: e.message, type: 'error' });
      }
      return;
    }
    case 'uninstall': return uninstall(pkg);
    default: return undefined;
  }
}

/* ---------------- Cài đặt ---------------- */

// ---------------- Cài đặt hệ thống Android ----------------

let volumeTimer = null;

async function refreshAndroid() {
  const el = $('androidStatus');
  if (!el) return;
  el.textContent = 'Đang đọc…';
  const r = await api.android.status().catch(() => null);
  if (!r || !r.ok) {
    el.textContent = r && r.error ? `Runtime chưa sẵn sàng (${String(r.error).slice(0, 36)})` : 'Runtime chưa khởi động';
    return;
  }
  el.textContent = `Android ${r.sdk || '?'} · ${r.wifi ? 'Wi-Fi bật' : 'Wi-Fi tắt'}` +
    `${r.airplane ? ' · Chế độ máy bay' : ''} · Âm lượng ${r.volume}%`;
  $('setAndroidWifi').checked = !!r.wifi;
  $('setAndroidAirplane').checked = !!r.airplane;
  $('setAndroidAnim').checked = !r.animationsOff;
  $('setAndroidVolume').value = r.volume;
  $('androidVolumeText').textContent = `${r.volume}%`;
  if (r.fontScale) $('setAndroidFont').value = Number(r.fontScale).toFixed(2);
  if (r.density) {
    const opt = [...$('setAndroidDensity').options].find((o) => o.value === String(r.density));
    if (opt) $('setAndroidDensity').value = String(r.density);
  }
}

function bindAndroid() {
  const set = async (key, value, msg) => {
    const r = await api.android.set(key, value).catch(() => null);
    toast({
      type: r && r.ok ? 'ok' : 'error',
      title: r && r.ok ? (msg || 'Đã áp dụng') : `Thất bại: ${(r && r.error) || 'Runtime chưa sẵn sàng'}`,
    });
    if (r && r.ok) refreshAndroid();
  };
  $('setAndroidWifi').addEventListener('change', (e) => set('wifi', e.target.checked, e.target.checked ? 'Đã bật Wi-Fi' : 'Đã tắt Wi-Fi'));
  $('setAndroidAirplane').addEventListener('change', (e) => set('airplane', e.target.checked, e.target.checked ? 'Đã bật chế độ máy bay' : 'Đã tắt chế độ máy bay'));
  $('setAndroidAnim').addEventListener('change', (e) => set('animations', e.target.checked, e.target.checked ? 'Đã bật hiệu ứng hệ thống' : 'Đã tắt hiệu ứng hệ thống, giao diện nhanh hơn'));
  $('setAndroidFont').addEventListener('change', (e) => set('fontScale', Number(e.target.value), 'Đã chỉnh cỡ chữ'));
  $('setAndroidDensity').addEventListener('change', (e) => set('density', Number(e.target.value), 'Đã chỉnh kích thước hiển thị'));
  $('setAndroidVolume').addEventListener('input', (e) => {
    $('androidVolumeText').textContent = `${e.target.value}%`;
    clearTimeout(volumeTimer);
    volumeTimer = setTimeout(() => set('volume', Number(e.target.value), 'Đã chỉnh âm lượng'), 260);
  });
  $('btnAndroidRefresh').addEventListener('click', () => refreshAndroid());
  $('btnAndroidTune').addEventListener('click', async () => {
    const r = await api.android.tune(state.launchPkg || '').catch(() => null);
    toast({ type: r && r.ok ? 'ok' : 'error', title: r && r.ok ? 'Đã tối ưu: tắt hiệu ứng, nới nền, danh sách trắng pin' : 'Tối ưu thất bại, có thể runtime chưa khởi động' });
    if (r && r.ok) refreshAndroid();
  });
  const open = async (action) => {
    const r = await api.android.open(action).catch(() => null);
    if (!r || !r.ok) {
      toast({ type: 'error', title: 'Cần mở một ứng dụng trước để runtime khởi động' });
    }
  };
  $('btnAndroidSettings').addEventListener('click', () => open('settings'));
  $('btnAndroidDisplay').addEventListener('click', () => open('display'));
  $('btnAndroidSound').addEventListener('click', () => open('sound'));
  $('btnAndroidLocale').addEventListener('click', () => open('locale'));
  $('btnAndroidApps').addEventListener('click', () => open('apps'));
}

function fillSettings(s) {
  $('setEngineMode').value = s.engine.mode;
  $('setAdbPath').value = s.adbPath || '';
  $('setDevice').value = s.device || '';
  $('setSystemImage').value = s.runtime.isoPath || '';
  $('setMemory').value = s.engine.memoryMB;
  $('setCores').value = s.engine.cores;
  $('setIdle').value = s.engine.idleShutdownMinutes;
  if ($('setSourcePref')) $('setSourcePref').value = (s.runtime && s.runtime.sourcePreference) || 'auto';
  if ($('setAutoMirror')) $('setAutoMirror').checked = (s.runtime && s.runtime.autoMirror) !== false;
  if ($('setGiteeToken')) $('setGiteeToken').value = (s.runtime && s.runtime.giteeToken) || '';
  if ($('setMirrorPrefix')) $('setMirrorPrefix').value = (s.runtime && s.runtime.mirrorPrefix) || '';
  if ($('setConnections')) $('setConnections').value = Number((s.runtime && s.runtime.downloadConnections) || 8);
  $('setAudio').checked = s.engine.audio !== false;
  $('setLiteMode').checked = s.engine.liteMode !== false;
  $('setPrewarm').checked = s.engine.prewarm !== false;
  $('setPriorityMode').value = ['performance', 'game'].includes(s.engine.priorityMode)
    ? s.engine.priorityMode : 'balanced';
  $('setDeepTrim').checked = !!s.engine.deepTrim;
  $('setMouseRightBack').checked = s.engine.mouseRightBack !== false;
  $('setMouseWheelMode').value = ['smooth', 'native', 'off'].includes(s.engine.mouseWheelMode)
    ? s.engine.mouseWheelMode : 'smooth';
  $('setMouseSideButtons').checked = !!s.engine.mouseSideButtons;
  $('setCompat').checked = !!(s.runtime && s.runtime.compatImage);
  $('setAutoShortcut').checked = !!s.createShortcutOnInstall;
  $('setStartMenuShortcut').checked = s.createStartMenuShortcut !== false;
  $('setShortcutDir').value = s.shortcutDir || '';
  $('setSharedDir').value = s.sharedDir || '';
  $('setDeviceSharedDir').value = s.deviceSharedDir || '';
  const d = s.display || {};
  $('setAutoStart').checked = s.autoStart !== false;
  const eng = s.engine || {};
  if ($('setResourceMode')) $('setResourceMode').value = eng.resourceMode || 'balanced';
  if ($('setRenderSize')) $('setRenderSize').value = eng.renderSize || 'auto';
  if ($('setDataGB')) $('setDataGB').value = String(Number(eng.dataPartitionGB || 0));
  if ($('setFastDns')) $('setFastDns').checked = eng.fastDns !== false;
  if ($('setKeepSnapshot')) $('setKeepSnapshot').checked = eng.keepSnapshot !== false;
  $('setDisplayMode').value = d.mode === 'fullscreen' ? 'fullscreen' : 'window';
  $('setPortrait').value = d.portrait || '900x1600';
  $('portraitField').hidden = $('setDisplayMode').value === 'fullscreen';
}

/** Kích thước thực của phân vùng dữ liệu + dung lượng đĩa trống, hiển thị dưới ô chọn dung lượng trong trang cài đặt */
async function refreshDataInfo() {
  const el = $('dataNote');
  if (!el) return;
  const info = await api.dataInfo().catch(() => null);
  if (!info) { el.textContent = 'Không đọc được thông tin phân vùng dữ liệu'; return; }
  const auto = Number(($('setDataGB') || {}).value || 0) === 0;
  const img = info.imageGB ? `${info.imageGB} GB` : 'chưa tạo';
  const free = info.freeDiskMB ? `${(info.freeDiskMB / 1024).toFixed(1)} GB` : 'không rõ';
  el.textContent = `Ảnh phân vùng dữ liệu hiện tại: ${img}${auto ? ' (tự động)' : ''} · Ổ đĩa chứa còn trống ${free}. `
    + 'Game báo "không đủ bộ nhớ" thì tăng mục này rồi bấm "Mở rộng ngay" — mở rộng tại chỗ, ứng dụng đã cài và dữ liệu lưu đều được giữ.';
}

async function openSettings() {
  state.settings = await api.getSettings();
  fillSettings(state.settings);
  const info = await api.info();
  $('setRuntimeDir').value = info.runtimeDir || info.dataDir;
  if ($('setAvdDir')) {
    const di = await api.dataInfo().catch(() => null);
    $('setAvdDir').value = (di && di.avdDir) || '';
  }
  const verEl = document.getElementById('aboutVer');
  if (verEl && info.version) verEl.textContent = `v${info.version}`;
  const curVerEl = document.getElementById('updateCurrent');
  if (curVerEl && info.version) curVerEl.textContent = `v${info.version}`;
  const assoc = await api.assocStatus();
  const btn = $('btnAssoc');
  btn.textContent = assoc.registered ? 'Đã liên kết · Bấm để hủy' : 'Chưa liên kết · Bấm để bật';
  btn.dataset.on = assoc.registered ? '1' : '0';

  api.doctorProfile().then((r) => {
    if (r && r.text) $('autoProfileText').textContent = r.text;
  }).catch(() => { $('autoProfileText').textContent = 'Chế độ tự động'; });
  api.runtimeUsage().then((u) => {
    $('usageText').textContent = u
      ? `Tổng ${u.totalText}${u.reclaimable ? ` · Thu hồi được ${u.reclaimableText} (${u.count} mục)` : ' · Đã gọn nhẹ'}`
      : 'Không thống kê được';
  }).catch(() => { $('usageText').textContent = 'Không thống kê được'; });

  $('settingsMask').classList.add('on');
  refreshAndroid();
  refreshDataInfo();
}

function closeSettings() {
  $('settingsMask').classList.remove('on');
}

/* ---------------- Cập nhật phần mềm ---------------- */

let lastUpdate = null;

/** Vẽ kết quả một lần kiểm tra lên bảng cài đặt (cũng dùng cho trạng thái do kiểm tra ngầm lúc khởi động đẩy tới) */
function renderUpdate(info) {
  lastUpdate = info || null;
  const cur = $('updateCurrent');
  const st = $('updateState');
  const btn = $('btnDoUpdate');
  const bar = $('updateBar');
  if (!cur || !st || !btn) return;
  if (!info) return;
  if (info.current) cur.textContent = `v${info.current}`;

  if (info.ok === false) {
    st.textContent = `Kiểm tra thất bại: ${info.error || 'Mạng không khả dụng'}`;
    // Kiểm tra thất bại cũng phải chừa một lối ra: mở thẳng trang phát hành, người dùng ít nhất còn tải thủ công được.
    // Trước đây chỗ này "không hiện gì cả", người dùng chỉ nghĩ "chức năng cập nhật hỏng rồi".
    showUpdateBtn(true);
    btn.textContent = 'Mở trang tải';
    btn.dataset.mode = 'manual';
    lastUpdate = { htmlUrl: info.htmlUrl || '' };
    if (bar) bar.hidden = true;
    return;
  }
  if (info.hasUpdate) {
    // Nói rõ lần này nguồn nào cung cấp phiên bản, nguồn kia vì sao không tham gia —
    // khi người dùng tìm hiểu "vì sao kiểm tra cập nhật chậm", dòng này trực tiếp hơn mọi log.
    const src = (info.sources || []).map((x) => `${x.name} ${x.tag || ''}`.trim()).join(' / ');
    const bad = (info.unreachable || []).map((x) => x.name).join(', ');
    const stale = info.stale ? ' (cache ngoại tuyến, có thể chưa mới nhất)' : '';
    st.textContent = `Có phiên bản mới ${info.tag}${src ? ` (${src})` : ''}${bad ? `; ${bad} không truy cập được` : ''}${stale}`;
    showUpdateBtn(true);
    btn.textContent = info.asset ? 'Cập nhật ngay' : 'Mở trang tải';
    btn.dataset.mode = info.asset ? 'auto' : 'manual';
    const note = $('updateNote');
    if (note && info.notes) {
      const brief = String(info.notes).split('\n').slice(0, 8).join('\n').trim();
      if (brief) note.textContent = `Nội dung cập nhật:\n${brief}`;
    }
    if (bar) bar.hidden = true;
  } else {
    const src = (info.sources || []).map((x) => x.name).join(' / ');
    const stale = info.stale ? ' (cache ngoại tuyến)' : '';
    st.textContent = `Đã là bản mới nhất (v${info.current})${src ? ` · qua ${src}` : ''}${stale}`;
    showUpdateBtn(false);
    if (bar) bar.hidden = true;
  }
}

/** .btn có sẵn display:inline-flex, sẽ đè thuộc tính hidden, nên ở đây đổi display trực tiếp */
function showUpdateBtn(on) {
  const btn = $('btnDoUpdate');
  if (!btn) return;
  btn.hidden = !on;
  btn.style.display = on ? '' : 'none';
}

function renderUpdateProgress(p) {
  if (!p) return;
  const st = $('updateState');
  const bar = $('updateBar');
  const fill = $('updateBarFill');
  if (p.stage === 'error') {
    if (st) st.textContent = `Cập nhật thất bại: ${p.message || ''}`;
    if (bar) bar.hidden = true;
    toast({ title: 'Cập nhật thất bại', body: p.message || '', type: 'error' });
    return;
  }
  if (st) st.textContent = p.message || 'Đang cập nhật…';
  if (bar && fill) {
    bar.hidden = false;
    fill.style.width = `${Math.max(0, Math.min(100, p.percent || 0))}%`;
  }
}

function bindUpdate() {
  const check = $('btnCheckUpdate');
  const go = $('btnDoUpdate');
  if (!check || !go) return;

  const runCheck = async (silent) => {
    if (!silent) {
      check.disabled = true;
      const old = check.textContent;
      check.textContent = 'Đang kiểm tra…';
      $('updateState').textContent = 'Đang kết nối GitHub…';
      try {
        const info = await api.updateCheck();
        renderUpdate(info);
        if (info && info.hasUpdate) toast({ title: `Có phiên bản mới ${info.tag}`, body: 'Bấm "Cập nhật ngay" để tự tải và cài', type: 'info' });
        else if (info && info.ok !== false) toast({ title: 'Đã là bản mới nhất', body: `v${info.current}`, type: 'ok' });
      } catch (e) {
        $('updateState').textContent = `Kiểm tra thất bại: ${e.message}`;
      } finally {
        check.disabled = false;
        check.textContent = old;
      }
      return;
    }
    const info = await api.updateCheck().catch(() => null);
    if (info) renderUpdate(info);
  };

  check.addEventListener('click', () => runCheck(false));

  go.addEventListener('click', async () => {
    if (go.dataset.mode === 'manual') {
      api.updateOpenRelease(lastUpdate && lastUpdate.htmlUrl);
      return;
    }
    go.disabled = true;
    go.textContent = 'Đang cập nhật…';
    const r = await api.updateApply().catch((e) => ({ ok: false, error: e.message }));
    if (!r || !r.ok) {
      go.disabled = false;
      go.textContent = 'Cập nhật ngay';
      if (r && r.error && !r.manual) {
        $('updateState').textContent = `Cập nhật thất bại: ${r.error}`;
        toast({ title: 'Cập nhật thất bại', body: r.error, type: 'error' });
      }
    } else {
      $('updateState').textContent = `Đã tải v${r.version}, đang khởi động lại để hoàn tất cài đặt…`;
    }
  });

  // Khi mở cài đặt mà chưa có kết quả thì tiện kiểm tra một lần (chạy nền, không làm phiền)
  runCheck(true).catch(() => {});
}

function bindSettings() {
  const save = async (patch) => {
    state.settings = await api.setSettings(patch);
  };

  $('setEngineMode').addEventListener('change', (e) => save({ engine: { mode: e.target.value } }));
  $('setAdbPath').addEventListener('change', (e) => save({ adbPath: e.target.value.trim() }));
  $('setDevice').addEventListener('change', async (e) => {
    await save({ device: e.target.value.trim() });
    refreshStatus();
  });
  $('setSystemImage').addEventListener('change', (e) => save({ runtime: { isoPath: e.target.value.trim() } }));
  // RAM / nhân: điền giá trị cụ thể thì tắt "tự động", điền 0 thì quay lại tự động.
  // Code cũ chỉ ghi memoryMB, mà overridesFromSettings chỉ nhận nó khi autoMemory=false,
  // nên "điền RAM thủ công" luôn bị bỏ qua — đây là mục dễ bị coi là "vô dụng" nhất trong trang cài đặt.
  $('setMemory').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { memoryMB: v, autoMemory: false } } : { engine: { memoryMB: 0, autoMemory: true } });
  });
  $('setCores').addEventListener('change', (e) => {
    const v = Number(e.target.value) || 0;
    save(v > 0 ? { engine: { cores: v, autoMemory: false } } : { engine: { cores: 0, autoMemory: true } });
  });
  if ($('setResourceMode')) {
    $('setResourceMode').addEventListener('change', async (e) => {
      // Chiến lược tài nguyên kéo theo thay đổi liteMode / priorityMode / renderSize (được dịch trong tiến trình chính)
      state.settings = await api.setSettings({ engine: { resourceMode: e.target.value } });
      fillSettings(state.settings);
      toast({ title: 'Đã đổi chiến lược tài nguyên', body: 'Có hiệu lực từ lần mở ứng dụng tiếp theo', type: 'ok' });
    });
  }
  if ($('setRenderSize')) {
    $('setRenderSize').addEventListener('change', (e) => save({ engine: { renderSize: e.target.value } }));
  }
  if ($('setFastDns')) {
    $('setFastDns').addEventListener('change', (e) => save({ engine: { fastDns: e.target.checked } }));
  }
  if ($('setKeepSnapshot')) {
    $('setKeepSnapshot').addEventListener('change', (e) => save({ engine: { keepSnapshot: e.target.checked } }));
  }
  if ($('setDataGB')) {
    $('setDataGB').addEventListener('change', (e) => {
      save({ engine: { dataPartitionGB: Number(e.target.value) || 0 } });
      refreshDataInfo();
    });
  }
  if ($('btnGrowData')) {
    $('btnGrowData').addEventListener('click', async () => {
      const gb = Number($('setDataGB').value) || 0;
      if (!gb) { toast({ title: 'Hãy chọn một dung lượng trước', body: '"Tự động" nghĩa là phần mềm tự quyết theo dung lượng đĩa trống, không cần mở rộng', type: 'info' }); return; }
      const { response } = await api.confirm({
        title: 'Mở rộng phân vùng dữ liệu Android ngay?',
        message: `Sẽ chỉnh /data thành ${gb} GB (mở rộng tại chỗ, ứng dụng đã cài và dữ liệu lưu đều được giữ).`,
        detail: 'Cần đóng các ứng dụng Android đang chạy trước khi mở rộng, xong rồi lần mở ứng dụng sau sẽ khởi động lại, mất thêm chục giây.',
        okLabel: 'Bắt đầu mở rộng',
      });
      if (response !== 1) return;
      $('btnGrowData').disabled = true;
      const old = $('btnGrowData').textContent;
      $('btnGrowData').textContent = 'Đang mở rộng…';
      const r = await api.setDataSize(gb).catch((e) => ({ ok: false, error: e.message }));
      $('btnGrowData').disabled = false;
      $('btnGrowData').textContent = old;
      toast({
        type: r && r.ok ? 'ok' : 'error',
        title: r && r.ok ? 'Đã mở rộng phân vùng dữ liệu' : 'Mở rộng thất bại',
        body: r && r.ok ? `Hiện có khoảng ${r.imageGB || gb} GB khả dụng` : (r && r.error) || 'Lỗi không xác định',
      });
      refreshDataInfo();
    });
  }
  $('setIdle').addEventListener('change', (e) => save({ engine: { idleShutdownMinutes: Number(e.target.value) || 0 } }));
  if ($('setSourcePref')) {
    $('setSourcePref').addEventListener('change', (e) => save({ runtime: { sourcePreference: e.target.value } }));
  }
  if ($('setAutoMirror')) {
    $('setAutoMirror').addEventListener('change', (e) => save({ runtime: { autoMirror: e.target.checked } }));
  }
  if ($('setGiteeToken')) {
    $('setGiteeToken').addEventListener('change', (e) => save({ runtime: { giteeToken: e.target.value.trim() } }));
  }
  if ($('setMirrorPrefix')) {
    $('setMirrorPrefix').addEventListener('change', (e) => save({ runtime: { mirrorPrefix: e.target.value.trim() } }));
  }
  if ($('setConnections')) {
    $('setConnections').addEventListener('change', (e) => {
      const n = Math.max(1, Math.min(16, Number(e.target.value) || 8));
      e.target.value = n;
      save({ runtime: { downloadConnections: n } });
    });
  }
  $('setAudio').addEventListener('change', (e) => save({ engine: { audio: e.target.checked } }));
  $('setLiteMode').addEventListener('change', (e) => save({ engine: { liteMode: e.target.checked } }));
  $('setPrewarm').addEventListener('change', (e) => save({ engine: { prewarm: e.target.checked } }));
  $('setPriorityMode').addEventListener('change', (e) => save({ engine: { priorityMode: e.target.value } }));
  const savePointer = async (patch) => {
    await save({ engine: patch });
    // Cài/gỡ hook ngay theo focus cửa sổ hiện tại, không đợi lần chuyển cửa sổ sau
    api.refreshPointerMapping().catch(() => {});
  };
  $('setMouseRightBack').addEventListener('change', (e) => savePointer({ mouseRightBack: e.target.checked }));
  $('setMouseWheelMode').addEventListener('change', (e) => savePointer({ mouseWheelMode: e.target.value }));
  $('setMouseSideButtons').addEventListener('change', (e) => savePointer({ mouseSideButtons: e.target.checked }));
  $('setDeepTrim').addEventListener('change', async (e) => {
    await save({ engine: { deepTrim: e.target.checked } });
    // Tắt cắt sâu thì phải khôi phục các gói đã pm disable-user trước đó, nếu không ảnh hưởng là vĩnh viễn
    if (!e.target.checked) {
      api.restoreSystemApps().catch(() => {});
      toast({ title: 'Đã khôi phục thành phần hệ thống', body: 'Đã tắt cắt sâu, các gói nền đang được khôi phục', type: 'info' });
    }
  });
  $('setCompat').addEventListener('change', async (e) => {
    const on = e.target.checked;
    await save({ runtime: { compatImage: on } });
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (on && !ok) toast({ title: 'Đã bật chế độ tương thích ARM', body: 'Cần tải thêm ảnh tương thích Google Play (Android 14, khoảng 1.5GB), bấm nút bên dưới để bắt đầu', type: 'info' });
    else if (on) toast({ title: 'Đã bật chế độ tương thích ARM', body: 'Có hiệu lực sau khi khởi động lại runtime', type: 'info' });
  });
  $('setAutoShortcut').addEventListener('change', (e) => save({ createShortcutOnInstall: e.target.checked }));
  $('setStartMenuShortcut').addEventListener('change', (e) => save({ createStartMenuShortcut: e.target.checked }));
  $('setShortcutDir').addEventListener('change', (e) => save({ shortcutDir: e.target.value.trim() }));
  $('setDeviceSharedDir').addEventListener('change', (e) => save({ deviceSharedDir: e.target.value.trim() }));
  $('setAutoStart').addEventListener('change', (e) => save({ autoStart: e.target.checked }));
  $('setDisplayMode').addEventListener('change', async (e) => {
    const mode = e.target.value;
    $('portraitField').hidden = mode === 'fullscreen';
    state.settings = await api.setSettings({ display: { mode } });
    toast({ title: mode === 'fullscreen' ? 'Đã chuyển toàn màn hình' : 'Đã chuyển cửa sổ dọc', type: 'ok' });
  });
  $('setPortrait').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ display: { portrait: e.target.value } });
    toast({ title: 'Đã cập nhật kích thước màn hình', body: 'Có hiệu lực khi mở hoặc chuyển ứng dụng lần sau', type: 'ok' });
  });
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const r = await api.rebuildShortcuts();
    toast({
      title: r && r.fixed && r.fixed.length ? 'Đã bổ sung lối tắt' : 'Lối tắt vẫn còn đủ',
      body: r && r.fixed && r.fixed.length ? r.fixed.join(', ') : 'Lối tắt Desktop và Start Menu bình thường',
      type: 'ok',
    });
  });

  $('btnDiagnostics').addEventListener('click', async () => {
    try {
      const r = await api.doctorReport();
      toast({ title: 'Đã xuất báo cáo chẩn đoán', body: `${r.diagnosis.title} · ${r.file}`, type: 'ok', sticky: true });
    } catch (e) {
      toast({ title: 'Xuất thất bại', body: e.message, type: 'error' });
    }
  });

  $('btnCleanup').addEventListener('click', async () => {
    const btn = $('btnCleanup');
    const includeSnapshots = $('chkCleanSnapshots') && $('chkCleanSnapshots').checked;
    btn.disabled = true;
    try {
      const preview = await api.runtimeCleanup({ apply: false, includeSnapshots });
      if (!preview.candidates.length) {
        toast({ title: 'Đã gọn nhẹ', body: 'Không có ảnh hoặc snapshot cũ nào để thu hồi.', type: 'ok' });
        return;
      }
      const r = await api.runtimeCleanup({ apply: true, includeSnapshots });
      if (r.cancelled) return;
      toast({
        title: 'Dọn dẹp xong',
        body: `Đã giải phóng khoảng ${(r.saved / 1048576).toFixed(0)} MB (${r.removed.length} mục), ứng dụng đã cài được giữ lại.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Tổng ${u.totalText} · Thu hồi được ${u.reclaimableText} (${u.count} mục)`;
    } catch (e) {
      toast({ title: 'Dọn dẹp thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Đặt lại dữ liệu Android: xác nhận hai lần (xác nhận ý định trước, rồi xác nhận không thể hoàn tác), xóa xong thì làm mới thống kê dung lượng
  $('btnResetData').addEventListener('click', async () => {
    const btn = $('btnResetData');
    btn.disabled = true;
    try {
      const first = await api.confirm({
        type: 'warning',
        title: 'Đặt lại dữ liệu Android?',
        message: 'Thao tác này đưa hệ thống Android về trạng thái sạch "như vừa cài":',
        detail: '• Xóa toàn bộ app bên thứ ba đã cài (kể cả app video, game...) cùng dữ liệu và trạng thái đăng nhập\n'
          + '• Xóa snapshot khởi động nhanh của AVD hiện tại\n'
          + '• Bản thân ảnh hệ thống không bị ảnh hưởng, mở lại ứng dụng sẽ khởi động nguội lại và tạo dữ liệu\n\n'
          + 'Thao tác này không thể hoàn tác. Tiếp tục?',
        buttons: ['Hủy', 'Tiếp tục'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!first || first.response !== 1) return;
      const second = await api.confirm({
        type: 'warning',
        title: 'Xác nhận lần nữa',
        message: 'Các app đã cài và dữ liệu của chúng sẽ bị xóa vĩnh viễn, chắc chắn muốn đặt lại?',
        detail: 'Yên tâm: ảnh hệ thống, các AVD khác, cache APK và biểu tượng trên máy đều không bị động tới.',
        buttons: ['Hủy', 'Đặt lại'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!second || second.response !== 1) return;
      const r = await api.runtimeResetData();
      if (!r || !r.ok) {
        toast({ title: 'Đặt lại thất bại', body: (r && r.error) || 'Vui lòng thử lại', type: 'error' });
        return;
      }
      toast({
        title: 'Đã đặt lại dữ liệu Android',
        body: `Đã giải phóng khoảng ${r.reclaimedMB} MB, danh sách ứng dụng đã cài đã được xóa.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Tổng ${u.totalText} · Thu hồi được ${u.reclaimableText} (${u.count} mục)`;
    } catch (e) {
      toast({ title: 'Đặt lại thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Sửa mạng: dùng khi trang cần mạng trong Android cứ đen màn hình (vd. app video bấm "Đồng ý và tiếp tục" xong đen cả màn).
  // Nguyên nhân gốc là cấu hình Wi-Fi trong /data của máy ảo bị hỏng, wlan0 không lên, không có route mặc định.
  // Ảnh Play Store không cho root, chỉ có thể đặt lại toàn bộ /data; danh sách ứng dụng được giữ, mở ra sẽ tự cài lại.
  $('btnRepairNetwork').addEventListener('click', async () => {
    const btn = $('btnRepairNetwork');
    btn.disabled = true;
    try {
      const ok = await api.confirm({
        type: 'warning',
        title: 'Sửa mạng máy ảo?',
        message: 'Trang cần mạng trong ứng dụng cứ đen màn hình/quay mãi, thường là do máy ảo Android không có mạng.',
        detail: 'Việc sửa sẽ thử lần lượt "từ nhẹ đến nặng":\n\n'
          + '1. Khởi động nguội máy ảo (không nạp snapshot) rồi chờ có mạng — không ảnh hưởng dữ liệu nào\n'
          + '2. Vẫn không được mới đặt lại dữ liệu Android — danh sách ứng dụng được giữ, mở ra sẽ tự cài lại,\n'
          + '   nhưng trạng thái đăng nhập, lịch sử xem... trong ứng dụng sẽ mất\n\n'
          + 'Chỉ ảnh hưởng AVD hiện tại, ảnh hệ thống và cache APK trên máy đều không bị động tới. Toàn bộ mất khoảng 1–5 phút. Tiếp tục?',
        buttons: ['Hủy', 'Bắt đầu sửa'],
        defaultId: 0,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const r = await api.runtimeRepairNetwork();
      if (!r || !r.ok) {
        toast({
          title: 'Mạng vẫn chưa khôi phục',
          body: (r && r.error) || 'Sau khi đặt lại máy ảo vẫn không có mạng, vui lòng kiểm tra mạng/tường lửa trên máy có chặn trình giả lập không.',
          type: 'error',
        });
        return;
      }
      toast({
        title: 'Đã khôi phục mạng',
        body: `${(r.network && r.network.ip) || 'Đã có mạng'}${r.wiped ? ' (đã đặt lại dữ liệu Android để sửa mạng, mở ứng dụng sẽ tự cài lại)' : ' (không động tới dữ liệu của bạn)'}`,
        type: 'ok',
      });
    } catch (e) {
      toast({ title: 'Sửa thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  // Dọn tàn dư bản cũ: quét thư mục chương trình cũ / mục gỡ cài đặt hết hiệu lực / file tạm cập nhật, xác nhận rồi xóa một lần.
  $('btnLeftovers').addEventListener('click', async () => {
    const btn = $('btnLeftovers');
    btn.disabled = true;
    try {
      const r = await api.leftoversScan();
      if (!r || !r.ok) {
        toast({ title: 'Quét thất bại', body: (r && r.error) || 'Vui lòng thử lại', type: 'error' });
        return;
      }
      const items = r.items || [];
      if (!items.length) {
        toast({ title: 'Rất sạch', body: 'Không tìm thấy tàn dư bản cũ.', type: 'ok' });
        return;
      }
      const mb = Math.round((r.totalBytes || 0) / 1048576);
      const lines = items.slice(0, 8).map((x) => `• ${x.note}: ${x.path}`);
      if (items.length > 8) lines.push(`…và ${items.length - 8} mục khác`);
      const ok = await api.confirm({
        type: 'warning',
        title: 'Dọn tàn dư bản cũ?',
        message: `Tìm thấy ${items.length} mục tàn dư, khoảng ${mb} MB:`,
        detail: `${lines.join('\n')}\n\nChỉ xóa "thư mục chương trình bản cũ / mục gỡ cài đặt hết hiệu lực / file tạm cập nhật", `
          + 'phiên bản đang chạy và dữ liệu ứng dụng của bạn đều không bị động tới.',
        buttons: ['Hủy', 'Bắt đầu dọn'],
        defaultId: 1,
        cancelId: 0,
      });
      if (!ok || ok.response !== 1) return;
      const c = await api.leftoversClean(items);
      if (!c || !c.ok) {
        toast({ title: 'Dọn dẹp thất bại', body: (c && c.error) || 'Vui lòng thử lại', type: 'error' });
        return;
      }
      const failNote = (c.failed && c.failed.length) ? `, ${c.failed.length} mục đang bị dùng nên chưa xóa` : '';
      toast({
        title: 'Đã dọn tàn dư bản cũ',
        body: `Đã xóa ${c.removed.length} mục, giải phóng ${c.freedMB || 0} MB${failNote}.`,
        type: 'ok',
      });
      const u = await api.runtimeUsage();
      $('usageText').textContent = `Tổng ${u.totalText} · Thu hồi được ${u.reclaimableText} (${u.count} mục)`;
    } catch (e) {
      toast({ title: 'Dọn dẹp thất bại', body: e.message, type: 'error' });
    } finally {
      btn.disabled = false;
    }
  });

  $('btnOpenShared').addEventListener('click', () => api.openSharedDir());

  // Tạo lại lối tắt: lối dự phòng khi biểu tượng desktop bị xóa nhầm / bị phần mềm bảo mật chặn
  $('btnRebuildShortcuts').addEventListener('click', async () => {
    const btn = $('btnRebuildShortcuts');
    btn.disabled = true;
    try {
      const r = await api.rebuildShortcuts().catch(() => ({ ok: false }));
      const fixed = (r && r.fixed) || [];
      toast(fixed.length
        ? { title: 'Đã tạo lại lối tắt', body: fixed.join(', '), type: 'ok' }
        : { title: 'Lối tắt vẫn còn đủ', body: 'Không có lối tắt nào cần tạo lại', type: 'info' });
    } finally {
      btn.disabled = false;
    }
  });

  // Thư mục chia sẻ: duyệt chọn thư mục trước, rồi "Lưu và di chuyển" để chuyển file cũ sang thư mục mới một lần
  $('btnBrowseShared').addEventListener('click', async () => {
    const picked = await api.openDir();
    if (!picked) return;
    $('setSharedDir').value = picked;
    toast({ title: 'Đã chọn thư mục mới', body: 'Bấm "Lưu và di chuyển" để chuyển file cũ sang', type: 'info' });
  });
  $('btnSaveShared').addEventListener('click', async () => {
    const dir = $('setSharedDir').value.trim();
    if (!dir) { toast({ title: 'Vui lòng điền hoặc duyệt chọn thư mục trước', type: 'error' }); return; }
    const btn = $('btnSaveShared');
    btn.disabled = true;
    const r = await api.setSharedDir(dir).catch(() => ({ ok: false }));
    btn.disabled = false;
    if (r.ok) {
      const moved = r.oldDir && r.oldDir !== r.newDir;
      toast({ title: 'Đã cập nhật thư mục chia sẻ', body: moved ? 'File có sẵn trong thư mục cũ đã được chuyển sang thư mục mới' : 'Đã lưu', type: 'ok' });
    } else {
      toast({ title: 'Lưu thất bại', body: r.error, type: 'error' });
    }
  });

  // Gỡ cài đặt ApkStart (hủy liên kết .apk + chạy trình gỡ cài đặt; bản portable xóa thủ công)
  $('btnUninstall').addEventListener('click', async () => {
    const ok = window.confirm('Gỡ cài đặt ApkStart?\n\nSẽ hủy liên kết file .apk và xóa chương trình. Thao tác này không thể hoàn tác.');
    if (!ok) return;
    const btn = $('btnUninstall');
    btn.disabled = true;
    const r = await api.removeSelf().catch(() => ({ ok: false }));
    if (r.ok && r.portable) {
      btn.disabled = false;
      toast({
        title: 'Bản portable không tự gỡ được',
        body: `Vui lòng xóa thủ công thư mục chương trình (${r.exeDir}) và thư mục dữ liệu (${r.dataDir})`,
        type: 'info', sticky: true,
      });
      return;
    }
    if (!r.ok) {
      btn.disabled = false;
      toast({ title: 'Gỡ cài đặt thất bại', body: r.error, type: 'error' });
      return;
    }
    toast({ title: 'Đang gỡ cài đặt…', body: 'Đã chạy trình gỡ cài đặt, ApkStart sắp thoát', type: 'ok', sticky: true });
  });

  // Tải ảnh tương thích ARM (toast có tiến độ)
  $('btnInstallPlay').addEventListener('click', async () => {
    const btn = $('btnInstallPlay');
    btn.disabled = true;
    const t = toast({ title: 'Bắt đầu tải ảnh tương thích ARM', body: 'Đang chuẩn bị…', sticky: true, spinner: true, progress: 3 });
    const un = api.on('provision:progress', (p) => {
      if (p.component !== 'playimg') return;
      t.update({ title: 'Đang tải ảnh tương thích ARM', body: p.message || '', progress: p.percent });
    });
    try {
      const r = await api.installPlayImage();
      if (r && r.ok) {
        t.update({ title: 'Ảnh tương thích ARM đã sẵn sàng', body: 'Có hiệu lực sau khi khởi động lại runtime', progress: 100 });
        setTimeout(() => t.dismiss(), 3000);
        $('compatInstallField').hidden = true;
        refreshStatus();
      } else {
        t.update({ title: 'Tải ảnh tương thích thất bại', body: (r && r.error) || 'Lỗi không xác định', progress: null });
        t.dismiss();
        toast({ title: 'Tải ảnh tương thích thất bại', body: (r && r.error) || 'Lỗi không xác định', type: 'error' });
      }
    } catch (e) {
      t.dismiss();
      toast({ title: 'Tải ảnh tương thích thất bại', body: e.message, type: 'error' });
    } finally {
      un();
      btn.disabled = false;
    }
  });

  // Hiển thị trạng thái ảnh tương thích
  (async () => {
    const env = ((state.status = await api.runtimeStatus()).env) || {};
    const s = state.settings;
    const on = !!(s && s.runtime && s.runtime.compatImage);
    const ok = env.playImage && env.playImage.ok;
    $('compatInstallField').hidden = !on || !!ok;
    if (env.playImage) {
      $('compatImgStatus').textContent = ok
        ? `Đã sẵn sàng (${(env.playImage.size / 1073741824).toFixed(2)} GB)` : 'Chưa tải';
    }
  })();
  $('btnOpenData').addEventListener('click', async () => {
    const info = await api.info();
    const dir = info.runtimeDir || info.dataDir;
    window.open(`file:///${dir.replace(/\\/g, '/')}`);
  });
  $('btnBrowseRuntimeDir').addEventListener('click', async () => {
    const info = await api.info();
    const picked = await api.openDir();
    if (!picked) return;
    await api.setSettings({ runtime: { dir: picked } });
    $('setRuntimeDir').value = picked;
    toast({ title: 'Đã cập nhật thư mục dữ liệu', body: 'Vui lòng khởi động lại ApkStart để áp dụng (dữ liệu cũ không tự chuyển)', type: 'ok', sticky: true });
  });

  // Thư mục dữ liệu Android (AVD + snapshot): phần thực sự ngốn ổ đĩa, trỏ riêng sang ổ khác
  if ($('btnBrowseAvdDir')) {
    $('btnBrowseAvdDir').addEventListener('click', async () => {
      const picked = await api.openDir();
      if (!picked) return;
      await api.setSettings({ runtime: { avdDir: picked } });
      $('setAvdDir').value = picked;
      toast({
        title: 'Đã cập nhật thư mục dữ liệu Android',
        body: 'Vui lòng khởi động lại ApkStart để áp dụng. Có thể chuyển nguyên apkstart.avd trong thư mục cũ sang thư mục mới rồi xóa bản cũ.',
        type: 'ok',
        sticky: true,
      });
    });
  }
  if ($('btnOpenAvdDir')) {
    $('btnOpenAvdDir').addEventListener('click', async () => {
      const info = await api.dataInfo().catch(() => null);
      const dir = (info && info.avdDir) || (await api.info()).dataDir;
      window.open(`file:///${String(dir).replace(/\\/g, '/')}`);
    });
  }

  $('btnProbe').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Đang dò tìm…';
    const found = await api.runtimeProbe();
    if (!found.length) {
      el.textContent = 'Không tìm thấy runtime đang chạy';
      return;
    }
    el.textContent = `Tìm thấy: ${found.map((f) => f.name).join(', ')}`;
    await api.setSettings({ device: found[0].serial });
    $('setDevice').value = found[0].serial;
    refreshStatus();
  });

  $('btnRuntimeStart').addEventListener('click', async () => {
    const el = $('probeResult');
    el.textContent = 'Đang khởi động…';
    const r = await api.runtimeStart();
    el.textContent = r.ok ? `Đã sẵn sàng: ${r.engine}` : `Khởi động thất bại: ${r.error}`;
    refreshStatus();
  });

  $('btnRuntimeStop').addEventListener('click', async () => {
    await api.runtimeStop();
    $('probeResult').textContent = 'Đã dừng máy ảo tích hợp';
    refreshStatus();
  });

  $('btnAssoc').addEventListener('click', async () => {
    const btn = $('btnAssoc');
    if (btn.dataset.on === '1') {
      await api.assocUnregister();
      btn.textContent = 'Chưa liên kết · Bấm để bật';
      btn.dataset.on = '0';
      toast({ title: 'Đã hủy liên kết .apk' });
    } else {
      const r = await api.assocRegister();
      btn.textContent = 'Đã liên kết · Bấm để hủy';
      btn.dataset.on = '1';
      toast({ title: 'Đã bật liên kết .apk', body: r.ok ? 'Giờ nhấp đúp APK sẽ cài thẳng vào ApkStart' : '', type: r.ok ? 'ok' : 'error' });
    }
  });
}

/* ---------------- Gắn sự kiện ---------------- */

function bindEvents() {
  // Liên kết luôn mở bằng trình duyệt hệ thống
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href^="http"]');
    if (!a) return;
    e.preventDefault();
    api.openExternal(a.getAttribute('href'));
  });

  $('btnSettings').addEventListener('click', openSettings);
  // Nhãn trạng thái cũng là lối vào: bấm "Cần triển khai / Đang khởi động / Android 14" là vào thẳng bảng runtime trong Cài đặt
  $('engineTag').addEventListener('click', () => showSetup(true));
  $('btnCloseSettings').addEventListener('click', closeSettings);
  $('btnDoneSettings').addEventListener('click', closeSettings);
  $('settingsMask').addEventListener('click', (e) => {
    if (e.target === $('settingsMask')) closeSettings();
  });

  // Triển khai runtime: lối vào đã chuyển vào Cài đặt, ở đây chỉ xử lý các nút trong bảng
  $('btnDeployAll').addEventListener('click', deployAll);
  $('btnMarkInstalled').addEventListener('click', markInstalled);
  $('btnGuideClose').addEventListener('click', () => { $('setupGuide').hidden = true; });
  $('btnSetupAdvanced').addEventListener('click', () => {
    const adv = document.querySelector('.advanced-group');
    if (adv) {
      adv.open = true;
      adv.scrollIntoView({ block: 'start', behavior: 'smooth' });
    }
  });

  // Bộ đếm tự kiểm tra trên thanh trạng thái: bấm vào là mở bảng runtime trong Cài đặt
  $('envChip').addEventListener('click', () => {
    openSettings().then(() => {
      const box = $('envCheck');
      if (box && !box.hidden) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      else $('runtimeGroup').scrollIntoView({ block: 'start', behavior: 'smooth' });
    }).catch(() => {});
  });

  $('setupSteps').addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]');
    if (!btn || btn.disabled) return;
    const act = btn.dataset.act;
    if (act === 'emulator' || act === 'sysimg' || act === 'accel'
      || act === 'adb' || act === 'qemu' || act === 'iso' || act === 'disk') {
      const r = await runStep(act);
      if (!r.ok) toast({ title: 'Thao tác thất bại', body: r.error, type: 'error', sticky: true });
      return;
    }
    if (act === 'isoImport') {
      const r = await api.importIso();
      if (r.ok) { toast({ title: 'Đã nhập ảnh hệ thống', body: r.path, type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Nhập thất bại', body: r.error, type: 'error' });
      return;
    }
    if (act === 'diskImport') {
      const r = await api.importDisk();
      if (r.ok) { toast({ title: 'Đã nhập đĩa ảo', body: 'Có thể khởi động runtime ngay', type: 'ok' }); refreshStatus(); }
      else if (!r.canceled) toast({ title: 'Nhập thất bại', body: r.error, type: 'error' });
      return;
    }
    if (act === 'install') { await startInstall(); return; }
    if (act === 'vmStart') {
      const t = toast({ title: 'Đang khởi động runtime…', body: 'Lần đầu cần khởi động hệ thống Android', sticky: true, spinner: true });
      const r = await api.runtimeStart();
      if (r.ok) { t.update({ title: 'Runtime đã sẵn sàng', type: 'ok' }); setTimeout(t.dismiss, 2200); }
      else t.update({ title: 'Khởi động thất bại', body: r.error, type: 'error' });
      refreshStatus();
      return;
    }
    if (act === 'vmStop') {
      await api.runtimeStop();
      toast({ title: 'Phiên runtime đã kết thúc' });
      refreshStatus();
    }
  });

  const pick = async () => {
    const files = await api.pickApk();
    if (files.length) installFiles(files);
  };
  $('btnInstall').addEventListener('click', pick);
  $('btnInstall2').addEventListener('click', pick);
  // Lối vào thư mục chia sẻ đã chuyển vào Cài đặt: đồng bộ + mở đều nằm trong nhóm "Chia sẻ file"
  const btnSync = $('btnSyncShared');
  if (btnSync) btnSync.addEventListener('click', async () => {
    btnSync.disabled = true;
    try {
      await api.syncShared();
      toast({ title: 'Đã đồng bộ thư mục chia sẻ', type: 'ok' });
    } catch (_) {
      toast({ title: 'Đồng bộ thất bại', body: 'Khi runtime chưa sẵn sàng sẽ bỏ qua đồng bộ', type: 'error' });
    } finally {
      btnSync.disabled = false;
    }
  });

  $('search').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGrid();
  });

  $('grid').addEventListener('click', (e) => {
    const card = e.target.closest('.card');
    if (card) launchApp(card.dataset.pkg);
  });

  $('grid').addEventListener('contextmenu', (e) => {
    const card = e.target.closest('.card');
    if (!card) return;
    e.preventDefault();
    showMenu(e.clientX, e.clientY, card.dataset.pkg);
  });

  $('grid').addEventListener('dblclick', (e) => {
    const card = e.target.closest('.card');
    if (card) createShortcut(card.dataset.pkg);
  });

  $('ctxmenu').addEventListener('click', (e) => {
    const item = e.target.closest('.item');
    if (item) handleMenu(item.dataset.act);
  });

  document.addEventListener('click', (e) => {
    if (!e.target.closest('#ctxmenu')) hideMenu();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      hideMenu();
      closeSettings();
    }
    if (e.ctrlKey && e.key.toLowerCase() === 'f') {
      e.preventDefault();
      $('search').focus();
    }
  });

  // Kéo thả để cài
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    dragDepth++;
    $('dropzone').classList.add('on');
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', (e) => {
    e.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) $('dropzone').classList.remove('on');
  });
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    $('dropzone').classList.remove('on');
    const files = [...(e.dataTransfer?.files || [])];
    const paths = files
      .map((f) => { try { return api.pathForFile(f); } catch (_) { return null; } })
      .filter((p) => p && /\.apk$/i.test(p));
    if (paths.length) installFiles(paths);
    else toast({ title: 'Chỉ có thể kéo vào file .apk', type: 'error' });
  });

  // Sự kiện từ tiến trình chính
  api.on('install:error', (p) => {
    // Đã báo lỗi thì đừng để toast "Đang cài…" quay mãi (có thể đến từ luồng nhấp đúp APK khác)
    if (installToast) { try { installToast.dismiss(); } catch (_) { /* ignore */ } installToast = null; }
    const name = p && p.file ? String(p.file).split(/[\\/]/).pop() : '';
    toast({
      title: name ? `Cài đặt thất bại: ${name}` : 'Cài đặt thất bại',
      body: friendlyInstallErrorText((p && p.message) || 'Lỗi không xác định'),
      type: 'error',
    });
  });
  api.on('toast', (p) => toast({ title: p.message, type: p.type === 'error' ? 'error' : 'info' }));
  api.on('app:launched', () => setTimeout(refreshApps, 800));
  api.on('runtime:log', (m) => console.log('[runtime]', m));
  api.on('ui:navigate', (v) => {
    if (v === 'settings') openSettings();
    if (v === 'setup') { showSetup(true); refreshStatus(); }
  });
  api.on('provision:progress', (p) => updateStepProgress(p.component, p));
  api.on('update:state', (info) => {
    if (!info) return;
    renderUpdate(info);
    // 8 giây sau khi khởi động mới có thông tin cập nhật: nếu thẻ chào mừng vẫn mở thì bổ sung dòng "có phiên bản mới"
    const wm = $('welcomeMask');
    if (wm && !wm.hidden) renderWelcomeTips();
  });
  api.on('update:progress', (p) => renderUpdateProgress(p));
}

/* ---------------- Khởi động ---------------- */

async function init() {
  bindEvents();
  bindSettings();
  bindUpdate();
  bindAndroid();
  bindWelcome();
  state.settings = await api.getSettings();
  await refreshStatus();
  await refreshApps();
  refreshAndroid();
  selfCheck();
  maybeShowWelcome();
  setInterval(refreshStatus, 6000);
  setInterval(refreshApps, 15000);
  setInterval(selfCheck, 60000);
}

/* ---------------- Thẻ chào mừng khi khởi động ---------------- */

let startupInfo = null;

function greetingOf(h) {
  if (h < 5) return 'Khuya rồi';
  if (h < 11) return 'Chào buổi sáng';
  if (h < 13) return 'Chào buổi trưa';
  if (h < 18) return 'Chào buổi chiều';
  return 'Chào buổi tối';
}

function bindWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  const close = () => { mask.hidden = true; };
  const never = $('welcomeNever');
  $('welcomeOk').addEventListener('click', () => {
    if (never && never.checked) api.setSettings({ welcome: { disabled: true } }).catch(() => {});
    close();
  });
  $('welcomeSettings').addEventListener('click', () => { close(); openSettings(); });
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !mask.hidden) close(); });
}

/** Quyết định có bật hay không: tự khởi động cùng Windows thì luôn bật; mở thủ công thì tối đa một lần mỗi ngày, và người dùng có thể tắt vĩnh viễn */
async function maybeShowWelcome() {
  const mask = $('welcomeMask');
  if (!mask) return;
  // Khi chụp màn hình smoke test thì không bật thẻ chào mừng: nếu không mỗi lần tự chụp đều bị nó che giao diện chính
  try { if ((await api.startupInfo()).smoke) return; } catch (_) { /* ignore */ }
  try { startupInfo = await api.startupInfo(); } catch (_) { startupInfo = null; }
  const cfg = (state.settings && state.settings.welcome) || {};
  if (cfg.disabled) return;
  const today = new Date().toISOString().slice(0, 10);
  if (!(startupInfo && startupInfo.autostart) && cfg.lastDate === today) return;

  const h = new Date().getHours();
  $('welcomeHi').textContent = `${greetingOf(h)}, chào mừng trở lại`;
  const ver = (startupInfo && startupInfo.version) || (state.status && state.status.version) || '';
  const ready = state.status && state.status.ready;
  $('welcomeSub').textContent = `ApkStart${ver ? ` v${ver}` : ''} · ${ready ? 'Runtime sẵn sàng, mở là dùng' : 'Runtime sẽ tự chuẩn bị khi cần'}`;

  const apps = (state.apps || []).length;
  const dev = $('statusDevice') ? $('statusDevice').textContent.trim() : '';
  const chips = [
    { k: String(apps), v: 'Ứng dụng đã cài' },
    { k: ready ? 'Sẵn sàng' : 'Chờ', v: 'Runtime Android' },
    { k: dev ? dev.replace(/^.*?(\d+)/, '$1') : '—', v: 'Thiết bị / Cổng' },
  ];
  $('welcomeStats').innerHTML = chips
    .map((c) => `<div class="welcome-stat"><b>${esc(c.k)}</b><span>${esc(c.v)}</span></div>`)
    .join('');

  const tips = [];
  $('welcomeTips').innerHTML = '';
  mask.hidden = false;
  renderWelcomeTips();
  api.setSettings({ welcome: { lastDate: today } }).catch(() => {});
}

/** Vùng gợi ý được vẽ riêng: 8 giây sau khi khởi động mới có thông tin cập nhật, lúc đó thẻ có thể vẫn mở, cần vẽ bổ sung */
function renderWelcomeTips() {
  const box = $('welcomeTips');
  if (!box) return;
  const apps = (state.apps || []).length;
  const tips = [];
  if (lastUpdate && lastUpdate.hasUpdate) {
    tips.push(`Có phiên bản mới <b>${esc(lastUpdate.tag || '')}</b>, có thể cập nhật trong "Cài đặt → Cập nhật phần mềm"`);
  }
  if (!apps) {
    tips.push('Kéo APK vào cửa sổ là cài được, cài xong sẽ tự tạo biểu tượng desktop');
  } else {
    tips.push('Nhấp đúp thẻ ứng dụng để chạy trong cửa sổ riêng, góc trên bên phải có thể xoay / thu phóng / đóng');
  }
  tips.push('Đóng cửa sổ chỉ thoát ứng dụng đó, môi trường Android vẫn được giữ, lần sau mở nhanh hơn');
  box.innerHTML = tips
    .map((t, i) => `<div class="welcome-tip"><i>${i + 1}</i><span>${t}</span></div>`)
    .join('');
}

/* ---------------- Tự kiểm tra môi trường ---------------- */

let envBusy = false;

/** Lấy doctor:selfCheck: vẽ các vấn đề vào bảng tự kiểm tra trong Cài đặt, và để lại bộ đếm trên thanh trạng thái */
async function selfCheck() {
  if (envBusy) return;
  envBusy = true;
  try {
    const r = await api.selfCheck().catch(() => null);
    if (r) renderEnvCheck(r);
  } catch (_) { /* tự kiểm tra thất bại không chặn luồng chính */ }
  finally { envBusy = false; }
}

function renderEnvCheck(r) {
  const box = $('envCheck');
  if (!box) return;
  // "Thiếu thành phần" đã được bao gồm trong Thiết lập nhanh của cùng bảng, không liệt kê lại
  const needDeploy = !!(state.status && state.status.needsSetup);
  const issues = (r.issues || []).filter((i) => !(needDeploy && i.fix === 'deploy'));

  // Giao diện chính không đặt banner nữa: chỉ để một bộ đếm bấm được trên thanh trạng thái phía dưới, bấm vào là bảng tự kiểm tra trong Cài đặt
  const chip = $('envChip');
  if (chip) {
    const errs = issues.filter((i) => i.severity === 'error').length;
    chip.hidden = issues.length === 0;
    chip.textContent = errs ? `${errs} mục cần sửa` : `${issues.length} gợi ý`;
    chip.className = `status-chip${errs ? ' err' : ''}`;
    chip.title = issues.map((i) => i.title).join('; ');
  }

  if (!issues.length) {
    box.hidden = false;
    box.innerHTML = `
      <div class="env-check-ok">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M20 6 9 17l-5-5"/></svg>
        <span>Tự kiểm tra môi trường đạt, không phát hiện vấn đề ảnh hưởng tới việc chạy.</span>
        <span style="flex:1"></span>
        <button class="btn ghost sm" id="btnEnvRecheck">Kiểm tra lại</button>
      </div>`;
    const re = $('btnEnvRecheck');
    if (re) re.addEventListener('click', selfCheck);
    return;
  }
  const errs = issues.filter((i) => i.severity === 'error').length;
  const warns = issues.length - errs;
  box.hidden = false;
  box.innerHTML = `
    <div class="env-check-head">
      <span class="ec-title">Tự kiểm tra môi trường</span>
      ${errs ? `<span class="ec-count">${errs} nghiêm trọng</span>` : ''}
      ${warns ? `<span class="ec-count warn">${warns} gợi ý</span>` : ''}
      <span class="ec-spacer"></span>
      <button class="btn ghost sm" id="btnEnvRecheck">Kiểm tra lại</button>
      <button class="btn primary sm" id="btnEnvFixAll">Sửa tất cả</button>
    </div>
    <div class="env-check-list">
      ${issues.map((i) => `
        <div class="env-check-item ${i.severity}">
          <span class="ec-sev"></span>
          <div class="ec-body">
            <div class="ec-name">${esc(i.title)}</div>
            <div class="ec-hint">${esc(i.hint || '')}</div>
          </div>
          ${i.fix ? `<button class="ec-fix" data-code="${esc(i.code)}">Sửa</button>` : ''}
        </div>`).join('')}
    </div>`;
  const re = $('btnEnvRecheck');
  if (re) re.addEventListener('click', selfCheck);
  const fixAll = $('btnEnvFixAll');
  if (fixAll) fixAll.addEventListener('click', () => fixAllIssues(issues));
  box.querySelectorAll('.ec-fix').forEach((b) => {
    b.addEventListener('click', () => {
      const issue = issues.find((x) => x.code === b.dataset.code);
      if (issue) fixIssue(issue);
    });
  });
}

async function fixIssue(issue) {
  switch (issue.fix) {
    case 'vcRedist': {
      const r = await api.installVcRedist().catch(() => ({ ok: false }));
      if (!r.ok && r.reason === 'no-installer') {
        api.openExternal('https://learn.microsoft.com/zh-CN/cpp/windows/latest-supported-vc-redist?view=msvc-170#visual-studio-2015-2017-2019-and-2022');
        toast({ title: 'Không tìm thấy gói cài tích hợp', body: 'Đã mở trang tải chính thức của Microsoft, vui lòng tải bản x64', type: 'info' });
        break;
      }
      toast(r.ok
        ? { title: 'Đã cài VC++ Runtime', type: 'ok' }
        : { title: 'Cài đặt chưa hoàn tất', body: r.error || 'Vui lòng thử lại', type: 'error' });
      break;
    }
    case 'virtualization': {
      const t = toast({ title: 'Đang bật tăng tốc phần cứng…', body: 'Vui lòng bấm "Có" trong cửa sổ hiện ra', sticky: true, spinner: true });
      const r = await api.enableVirtualization().catch(() => ({ ok: false }));
      if (r.ok) {
        t.update({ title: 'Đã bật tăng tốc phần cứng', body: r.restartNeeded ? 'Vui lòng khởi động lại máy tính để có hiệu năng tốt nhất' : (r.note || ''), type: 'ok' });
        setTimeout(t.dismiss, 3200);
      } else {
        t.update({ title: 'Không bật được', body: r.error || 'Vui lòng thử lại', type: 'error', sticky: true });
      }
      break;
    }
    case 'disk': {
      // Tiến trình chính sẽ bật hộp xác nhận gốc (kèm xem trước dung lượng giải phóng được), ở đây không confirm lặp lại
      const r = await api.runtimeCleanup({ apply: true }).catch(() => null);
      if (!r) { toast({ title: 'Dọn dẹp thất bại', body: 'Vui lòng thử lại', type: 'error' }); break; }
      if (r.cancelled) break;
      toast({ title: 'Dọn dẹp xong', body: `Đã giải phóng khoảng ${((r.saved || 0) / 1048576).toFixed(0)} MB`, type: 'ok' });
      break;
    }
    case 'path': {
      toast({ title: 'Nên chuyển sang thư mục tên Latin', body: 'Vào Cài đặt → Tích hợp hệ thống, đổi "Thư mục dữ liệu runtime", rồi khởi động lại phần mềm.', type: 'info', sticky: true });
      openSettings();
      break;
    }
    case 'deploy': {
      toast({ title: 'Đang bổ sung các thành phần runtime còn thiếu…', type: 'info', sticky: true, spinner: true });
      await deployAll();
      break;
    }
    case 'lock': {
      const r = await api.clearLocks().catch(() => ({ ok: false }));
      toast(r.ok ? { title: 'Đã dọn file khóa còn sót', type: 'ok' } : { title: 'Dọn dẹp thất bại', body: r.error, type: 'error' });
      break;
    }
    default:
      toast({ title: 'Chưa hỗ trợ tự sửa', body: issue.hint || '', type: 'info' });
  }
  // Sau khi sửa thì tự kiểm tra lại, làm mới banner và trạng thái
  setTimeout(selfCheck, 600);
  setTimeout(refreshStatus, 600);
}

async function fixAllIssues(issues) {
  const fixable = issues.filter((i) => i.fix);
  for (const i of fixable) {
    // eslint-disable-next-line no-await-in-loop
    await fixIssue(i);
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res) => setTimeout(res, 500));
  }
}

init().catch((e) => {
  console.error(e);
  toast({ title: 'Khởi tạo thất bại', body: e.message, type: 'error', sticky: true });
});
