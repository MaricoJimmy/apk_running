'use strict';
/**
 * Tự kiểm tra luồng cập nhật (không cần phát hành bản mới thật, cũng không động đến bản cài hiện tại).
 *
 * 1) Có đọc được release mới nhất trên GitHub không, và có chọn đúng tệp đính kèm cho dạng hiện tại không;
 * 2) Logic so sánh phiên bản;
 * 3) Script «giải nén + ghi đè + khởi động lại» thực sự chạy được: tạo một thư mục cài đặt giả để script ghi đè lên.
 *
 * Cách dùng: node tools/check-update.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const { Updater, cmpVer } = require('../src/core/updater');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ok = (c, m) => console.log(`${c ? '✓' : '✗'} ${m}`);

(async () => {
  let pass = true;
  const check = (c, m) => { ok(c, m); if (!c) pass = false; };

  // ---- 1. So sánh phiên bản ----
  check(cmpVer('v0.3.2', '0.3.1') === 1, 'v0.3.2 > 0.3.1');
  check(cmpVer('0.3.1', 'v0.3.1') === 0, 'Tiền tố v không ảnh hưởng đến so sánh bằng');
  check(cmpVer('v0.10.0', '0.9.9') === 1, '0.10.0 > 0.9.9 (so theo số, không phải chuỗi)');
  check(cmpVer('1.0.0', '1.0.1') === -1, '1.0.0 < 1.0.1');

  // ---- 2. GitHub release ----
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'apkstart-upd-'));
  const install = path.join(sandbox, 'install');
  fs.mkdirSync(install, { recursive: true });

  const u = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  let info = null;
  try {
    info = await u.check();
    check(!!info && !!info.version, `Đọc được phiên bản mới nhất ${info && info.tag}`);
    check(info.hasUpdate === true, 'Phiên bản hiện tại 0.0.0 → xác định có bản cập nhật');
    check(!!info.asset && /\.(zip|exe)$/i.test(info.asset.name), `Dạng portable chọn được tệp ${info.asset && info.asset.name}`);
  } catch (e) {
    check(false, `Kiểm tra GitHub thất bại: ${e.message}`);
  }

  // Dạng cài đặt (có trình gỡ cài đặt) phải chọn Setup.exe
  fs.writeFileSync(path.join(install, 'Uninstall ApkStart.exe'), 'stub');
  const u2 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  check(u2.flavor === 'setup', 'Nhận diện là bản cài đặt (có Uninstall ApkStart.exe)');

  // ---- 3. Script ghi đè thực sự chạy được ----
  const payload = path.join(sandbox, 'payload');
  fs.mkdirSync(path.join(payload, 'resources', 'app'), { recursive: true });
  fs.writeFileSync(path.join(payload, 'ApkStart.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload, 'resources', 'app', 'main.js'), 'new-main');
  fs.writeFileSync(path.join(install, 'ApkStart.exe'), 'old-exe');

  // Dùng một tiến trình thoát ngay làm «tiến trình cũ cần chờ»
  const decoy = spawn(process.execPath, ['-e', 'setTimeout(()=>{},1500)'], { stdio: 'ignore' });

  const script = u.apply(
    { mode: 'zip', payload, version: '9.9.9' },
    { waitPid: decoy.pid, spawn: false },
  );
  check(/Copy-Item/.test(script) && /Wait-Process/.test(script), 'Script có bước chờ tiến trình và ghi đè');

  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Không thật sự Start-Process mở ApkStart.exe (đó là exe giả), chỉ kiểm tra việc sao chép
  const body = script.replace(/if \(Test-Path[^\r\n]*relaunched' \}/, "'skipped relaunch'");
  const b64 = Buffer.from(body, 'utf16le').toString('base64');
  try {
    execFileSync(ps, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', b64], {
      stdio: 'ignore', timeout: 60000, windowsHide: true,
    });
  } catch (e) {
    check(false, `Chạy script ghi đè thất bại: ${e.message}`);
  }
  await sleep(600);
  const newExe = fs.readFileSync(path.join(install, 'ApkStart.exe'), 'utf8');
  const newMain = fs.readFileSync(path.join(install, 'resources', 'app', 'main.js'), 'utf8');
  check(newExe === 'new-exe', 'ApkStart.exe trong thư mục cài đặt đã được thay thế');
  check(newMain === 'new-main', 'Tệp trong thư mục con cũng được thay thế thành công');

  // ---- 4. apply() thực sự chạy một tiến trình để thay thế (luồng bất đồng bộ, không qua mạng) ----
  const install2 = path.join(sandbox, 'install2');
  const payload2 = path.join(sandbox, 'payload2');
  fs.mkdirSync(install2, { recursive: true });
  fs.mkdirSync(payload2, { recursive: true });
  fs.writeFileSync(path.join(install2, 'ApkStart.exe'), 'old-exe');
  fs.writeFileSync(path.join(install2, 'marker.txt'), 'old');
  fs.writeFileSync(path.join(payload2, 'ApkStart.exe'), 'new-exe');
  fs.writeFileSync(path.join(payload2, 'marker.txt'), 'new');

  const u3 = new Updater({
    currentVersion: '0.0.0',
    exePath: path.join(install2, 'ApkStart.exe'),
    isPackaged: true,
    dataDir: sandbox,
  });
  const decoy2 = spawn(process.execPath, ['-e', 'setTimeout(()=>{},600)'], { stdio: 'ignore' });
  u3.apply({ mode: 'zip', payload: payload2, version: '9.9.8' }, { waitPid: decoy2.pid });
  let asyncOk = false;
  for (let i = 0; i < 40; i += 1) {
    await sleep(500);
    try {
      if (fs.readFileSync(path.join(install2, 'marker.txt'), 'utf8') === 'new') { asyncOk = true; break; }
    } catch (_) { /* vẫn đang thay thế */ }
  }
  check(asyncOk, 'apply() đã hoàn tất thay thế trong tiến trình nền (luồng bất đồng bộ hoạt động)');

  try { decoy.kill(); } catch (_) { /* ignore */ }
  try { decoy2.kill(); } catch (_) { /* ignore */ }
  fs.rmSync(sandbox, { recursive: true, force: true });

  console.log('');
  console.log(pass ? 'Kết quả: ĐẠT' : 'Kết quả: có mục thất bại');
  process.exit(pass ? 0 : 1);
})().catch((e) => { console.error('FATAL', e); process.exit(1); });
