'use strict';
/* Trình chỉnh map phím (kéo-thả trên game) + nhãn phím khi chơi. Dữ liệu: xem src/core/keymap.js (Profile/Control). */

const clamp01 = (v) => Math.max(0, Math.min(1, v));
const round4 = (v) => Math.round(v * 10000) / 10000;

/** Tỉ lệ 0–1 -> pixel trong khung (box = {width, height}) */
function toPx(c, box) {
  return { x: Math.round(c.x * box.width), y: Math.round(c.y * box.height) };
}

/** Pixel trong khung -> tỉ lệ 0–1 (kẹp trong khung) */
function fromPx(x, y, box) {
  return { x: round4(clamp01(x / box.width)), y: round4(clamp01(y / box.height)) };
}

const KEY_NAMES = {
  Space: 'Space', Tab: 'Tab', Escape: 'Esc', Backquote: '`', Enter: 'Enter', Backspace: '⌫', CapsLock: 'Caps',
  ShiftLeft: 'Shift', ShiftRight: 'Shift P', ControlLeft: 'Ctrl', ControlRight: 'Ctrl P', AltLeft: 'Alt', AltRight: 'Alt P',
  ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Mouse1: '🖱 Trái', Mouse2: '🖱 Phải',
};
function keyName(code) {
  if (!code) return '?';
  if (KEY_NAMES[code]) return KEY_NAMES[code];
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit\d$/.test(code)) return code.slice(5);
  return code;
}

if (typeof module !== 'undefined' && module.exports) module.exports = { toPx, fromPx, keyName };

if (typeof document !== 'undefined') {
  const api = window.apkstart;
  const $ = (id) => document.getElementById(id);
  const stage = $('stage');
  const panel = $('panel');
  // Phím dành riêng: không gán được cho nút trong game
  const RESERVED = new Set(['Backquote', 'Escape']);

  let state = { mode: 'play', profile: null, template: null, labels: true, disableKey: 'F12' };
  let selected = null;     // id control đang chọn
  let listening = null;    // 'key' | 'dir:<up|left|down|right>' | 'disable'

  const box = () => stage.getBoundingClientRect();
  const ctlById = (id) => state.profile.controls.find((c) => c.id === id);
  const newId = () => `c${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}`;

  function render() {
    document.body.className = `${state.mode}${state.labels ? '' : ' nolabels'}`;
    stage.innerHTML = '';
    if (!state.profile) return;
    const b = box();
    for (const c of state.profile.controls) {
      const el = document.createElement('div');
      el.className = `ctl ${c.type}${c.id === selected ? ' selected' : ''}`;
      el.dataset.id = c.id;
      if (c.type === 'camera') {
        el.style.left = `${(c.x - c.w / 2) * 100}%`;
        el.style.top = `${(c.y - c.h / 2) * 100}%`;
        el.style.width = `${c.w * 100}%`;
        el.style.height = `${c.h * 100}%`;
        el.textContent = 'Vùng xoay camera (chuột)';
        const h = document.createElement('div');
        h.className = 'resize';
        el.appendChild(h);
      } else if (c.type === 'joystick') {
        const d = 2 * c.r * b.height;
        el.style.left = `${c.x * 100}%`;
        el.style.top = `${c.y * 100}%`;
        el.style.width = `${d}px`;
        el.style.height = `${d}px`;
        const k = c.keys;
        [['up', '50%', '6px', 'translateX(-50%)'], ['down', '50%', null, 'translateX(-50%)'],
          ['left', '6px', '50%', 'translateY(-50%)'], ['right', null, '50%', 'translateY(-50%)']].forEach(([dir, l, t, tr]) => {
          const s = document.createElement('span');
          s.textContent = keyName(k[dir]);
          if (l) s.style.left = l; else s.style.right = '6px';
          if (t) s.style.top = t; else s.style.bottom = '6px';
          s.style.transform = tr;
          el.appendChild(s);
        });
      } else {
        el.style.left = `${c.x * 100}%`;
        el.style.top = `${c.y * 100}%`;
        el.textContent = keyName(c.key);
        if (c.label) {
          const s = document.createElement('small');
          s.textContent = c.label;
          el.appendChild(s);
        }
      }
      stage.appendChild(el);
    }
    renderPanel();
  }

  function renderPanel() {
    const c = selected && state.mode === 'edit' ? ctlById(selected) : null;
    panel.hidden = !c || c.type === 'camera';
    if (panel.hidden) return;
    const isKey = c.type === 'key';
    for (const el of panel.querySelectorAll('.row')) {
      const joyRow = el.classList.contains('joy');
      el.style.display = (joyRow ? !isKey : isKey) ? '' : 'none';
    }
    if (isKey) {
      $('pKey').textContent = listening === 'key' ? 'Nhấn phím…' : keyName(c.key);
      $('pKey').classList.toggle('listening', listening === 'key');
      $('pLabel').value = c.label || '';
      $('pRelease').checked = !!c.releaseMouse;
    } else {
      for (const btn of panel.querySelectorAll('[data-dir]')) {
        const dir = btn.dataset.dir;
        btn.textContent = listening === `dir:${dir}` ? '…' : keyName(c.keys[dir]);
        btn.classList.toggle('listening', listening === `dir:${dir}`);
      }
    }
  }

  function renderToolbar() {
    $('sens').value = state.profile ? state.profile.sensitivity : 1;
    $('sensVal').textContent = Number($('sens').value).toFixed(1);
    $('disableKey').textContent = listening === 'disable' ? 'Nhấn phím…' : keyName(state.disableKey);
    $('disableKey').classList.toggle('listening', listening === 'disable');
    $('labels').checked = !!state.labels;
  }

  function select(id, listen = null) {
    selected = id;
    listening = listen;
    render();
  }

  function add(kind) {
    const list = state.profile.controls;
    if (kind === 'joystick' || kind === 'camera') {
      const exist = list.find((c) => c.type === kind);
      if (exist) { select(exist.id); return; }
      const c = kind === 'joystick'
        ? { id: newId(), type: 'joystick', x: 0.14, y: 0.72, r: 0.16, keys: { up: 'KeyW', left: 'KeyA', down: 'KeyS', right: 'KeyD' } }
        : { id: newId(), type: 'camera', x: 0.70, y: 0.40, w: 0.56, h: 0.60 };
      list.push(c);
      select(c.id);
      return;
    }
    const c = kind === 'fire'
      ? { id: newId(), type: 'key', key: 'Mouse1', x: 0.8, y: 0.5, label: 'Bắn' }
      : { id: newId(), type: 'key', key: '', x: 0.5, y: 0.5, label: '' };
    list.push(c);
    select(c.id, kind === 'fire' ? null : 'key');
  }

  // ---- kéo thả / đổi cỡ / xóa
  let drag = null;
  stage.addEventListener('pointerdown', (e) => {
    if (state.mode !== 'edit' || e.button !== 0) return;
    const el = e.target.closest('.ctl');
    if (!el) { select(null); return; }
    const c = ctlById(el.dataset.id);
    const b = box();
    drag = {
      c, resize: e.target.classList.contains('resize'),
      dx: e.clientX - b.left - c.x * b.width, dy: e.clientY - b.top - c.y * b.height,
    };
    stage.setPointerCapture(e.pointerId);
    if (selected !== c.id) select(c.id, c.type === 'key' && !c.key ? 'key' : null);
  });
  stage.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const b = box();
    const c = drag.c;
    if (drag.resize) {
      // Góc dưới phải của vùng camera: giữ cạnh trên trái, đổi rộng/cao
      const left = c.x - c.w / 2;
      const top = c.y - c.h / 2;
      const p = fromPx(e.clientX - b.left, e.clientY - b.top, b);
      c.w = round4(Math.max(0.1, p.x - left));
      c.h = round4(Math.max(0.1, p.y - top));
      c.x = round4(left + c.w / 2);
      c.y = round4(top + c.h / 2);
    } else {
      const p = fromPx(e.clientX - b.left - drag.dx, e.clientY - b.top - drag.dy, b);
      c.x = p.x;
      c.y = p.y;
    }
    render();
  });
  stage.addEventListener('pointerup', () => { drag = null; });
  stage.addEventListener('wheel', (e) => {
    if (state.mode !== 'edit') return;
    const el = e.target.closest('.ctl.joystick');
    if (!el) return;
    const c = ctlById(el.dataset.id);
    c.r = round4(Math.max(0.05, Math.min(0.4, c.r + (e.deltaY < 0 ? 0.01 : -0.01))));
    render();
  }, { passive: true });
  window.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    if (state.mode !== 'edit') return;
    const el = e.target.closest('.ctl');
    if (!el) return;
    state.profile.controls = state.profile.controls.filter((c) => c.id !== el.dataset.id);
    select(null);
  });

  // ---- gán phím
  window.addEventListener('keydown', (e) => {
    if (state.mode !== 'edit') return;
    if (document.activeElement === $('pLabel')) return;
    e.preventDefault();
    const code = e.code;
    if (listening === 'disable') {
      if (!RESERVED.has(code)) state.disableKey = code;
      listening = null;
      renderToolbar();
      return;
    }
    const c = selected && ctlById(selected);
    if (!c || RESERVED.has(code) || code === state.disableKey) return;
    if (c.type === 'key') {
      c.key = code;
      listening = null;
    } else if (c.type === 'joystick' && listening && listening.startsWith('dir:')) {
      c.keys[listening.slice(4)] = code;
      listening = null;
    }
    render();
  });

  $('pKey').addEventListener('click', () => { listening = 'key'; renderPanel(); });
  $('pMouse1').addEventListener('click', () => { const c = ctlById(selected); c.key = 'Mouse1'; listening = null; render(); });
  $('pMouse2').addEventListener('click', () => { const c = ctlById(selected); c.key = 'Mouse2'; listening = null; render(); });
  $('pLabel').addEventListener('input', (e) => { const c = ctlById(selected); c.label = e.target.value; render(); $('pLabel').focus(); });
  $('pRelease').addEventListener('change', (e) => { ctlById(selected).releaseMouse = e.target.checked; });
  for (const btn of panel.querySelectorAll('[data-dir]')) {
    btn.addEventListener('click', () => { listening = `dir:${btn.dataset.dir}`; renderPanel(); });
  }

  // ---- thanh công cụ
  for (const btn of document.querySelectorAll('[data-add]')) btn.addEventListener('click', () => add(btn.dataset.add));
  $('btnTemplate').addEventListener('click', () => {
    state.profile = JSON.parse(JSON.stringify(state.template));
    select(null);
    renderToolbar();
  });
  $('sens').addEventListener('input', (e) => {
    state.profile.sensitivity = Number(e.target.value);
    $('sensVal').textContent = state.profile.sensitivity.toFixed(1);
  });
  $('disableKey').addEventListener('click', () => { listening = 'disable'; renderToolbar(); });
  $('labels').addEventListener('change', (e) => { state.labels = e.target.checked; });
  $('btnCancel').addEventListener('click', () => api.keymap.cancel());
  $('btnSave').addEventListener('click', () => {
    const profile = { ...state.profile, controls: state.profile.controls.filter((c) => c.type !== 'key' || c.key) };
    api.keymap.save({ profile, disableKey: state.disableKey, labels: state.labels });
  });

  window.addEventListener('resize', render);

  api.keymap.onMode((p) => {
    const editing = p.mode === 'edit';
    const profile = p.profile || (editing ? p.template : null);
    state = {
      mode: p.mode,
      profile: profile ? JSON.parse(JSON.stringify(profile)) : null,
      template: p.template,
      labels: p.labels !== false,
      disableKey: p.disableKey || 'F12',
    };
    if (state.profile) state.profile.landscape = !!p.landscape;
    selected = null;
    listening = null;
    renderToolbar();
    render();
  });
}
