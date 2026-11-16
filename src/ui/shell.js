'use strict';
/* Thanh tiêu đề cửa sổ ứng dụng: chỉ có Xoay / Thu nhỏ / Phóng to / Đóng, các cài đặt khác nằm ở giao diện chính ApkStart */
const api = window.apkstart;
const $ = (id) => document.getElementById(id);

const btn = {
  keymap: $('btnKeymap'),
  rotate: $('btnRotate'),
  min: $('btnMin'),
  max: $('btnMax'),
  close: $('btnClose'),
};

btn.keymap.addEventListener('click', () => api.shell.keymapEdit());
btn.rotate.addEventListener('click', () => api.shell.rotate());
btn.min.addEventListener('click', () => api.shell.minimize());
btn.max.addEventListener('click', () => api.shell.maximize());
btn.close.addEventListener('click', () => api.shell.close());

// Chuột phải trên thanh tiêu đề không được bật menu web của Chromium; chuột phải trong vùng hình ảnh
// đã được tiến trình chính chặn và ánh xạ thành "Quay lại Android", ở đây xử lý nốt phần viền vỏ.
window.addEventListener('contextmenu', (e) => e.preventDefault());

// Ctrl+R để xoay, F11 để phóng to (giống thói quen trên Windows)
window.addEventListener('keydown', (e) => {
  if (e.ctrlKey && (e.key === 'r' || e.key === 'R')) { e.preventDefault(); api.shell.rotate(); }
  else if (e.key === 'F11') { e.preventDefault(); api.shell.maximize(); }
  else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); api.shell.back(); }
  else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); api.shell.forward(); }
});

function applyState(s) {
  if (!s) return;
  $('appName').textContent = s.label || 'Ứng dụng';
  $('bootName').textContent = s.label || '';
  const icon = s.iconUrl || '';
  if (icon) {
    $('appIcon').src = icon;
    $('bootIcon').src = icon;
  }
  $('bootTip').textContent = s.tip || '';
  if (s.ready) {
    const boot = $('boot');
    if (boot) {
      boot.classList.add('out');
      setTimeout(() => { boot.style.display = 'none'; }, 420);
    }
    document.body.style.background = '#0b0c0e';
  }
}

api.shell.onState(applyState);
api.shell.state().then(applyState).catch(() => {});
