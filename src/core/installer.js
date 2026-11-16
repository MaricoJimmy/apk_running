'use strict';
/**
 * Lớp điều phối cài đặt / khởi chạy / gỡ cài đặt
 * Nối「phân tích APK → cài vào runtime → lưu metadata cục bộ → tạo lối tắt trên desktop」thành một pipeline.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const store = require('./store');
const { parseApk } = require('./apk');
const { ZipFile } = require('./zip');
const { iconToIco, writeShortcut, removeShortcut, safeFileName } = require('./shortcut');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** APK chỉ có thư viện native ARM (đa số app Trung Quốc đều vậy) */
function isArmOnly(meta) {
  return !!(meta && meta.abis && meta.abis.length && !meta.abis.some((a) => /x86/i.test(a)));
}

/**
 * Gói cài đặt dạng tách (.apks / .xapk): giải nén các APK phân mảnh bên trong ra thư mục tạm thuần ASCII.
 * Dùng trình đọc ZIP theo file + ghi đĩa dạng stream: gói tách thường 2GB+, đọc cả gói vào bộ nhớ sẽ thất bại.
 * Trả về { meta, files, cleanup }; meta lấy từ base APK có AndroidManifest.
 */
async function parseBundle(filePath) {
  const zip = new ZipFile(filePath);
  const dir = path.join(os.tmpdir(), 'apkstart-bundle', crypto.createHash('sha1')
    .update(filePath).digest('hex').slice(0, 12));
  const cleanup = () => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* ignore */ } };
  try {
    const apkNames = zip.names().filter((n) => /\.apk$/i.test(n));
    if (!apkNames.length) throw new Error('Không tìm thấy APK phân mảnh nào trong gói cài đặt này (có thể không phải .apks/.xapk)');
    fs.mkdirSync(dir, { recursive: true });
    const files = [];
    for (let i = 0; i < apkNames.length; i++) {
      const target = path.join(dir, `split-${i}.apk`);
      // Một phân mảnh cũng có thể vài trăm MB: giải nén dạng stream, không qua Buffer
      // eslint-disable-next-line no-await-in-loop
      await zip.pipeTo(apkNames[i], fs.createWriteStream(target));
      files.push(target);
    }
    let meta = null;
    for (const f of files) {
      try { meta = parseApk(f); break; } catch (_) { /* phân mảnh này không có manifest */ }
    }
    if (!meta) throw new Error('Phân tích base APK của gói tách thất bại');
    return { meta, files, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  } finally {
    zip.close();
  }
}

function accentOf(pkg) {
  let h = 0;
  for (let i = 0; i < pkg.length; i++) h = (h * 31 + pkg.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  return `hsl(${hue} 62% 52%)`;
}

class Installer {
  constructor(runtime, ctx) {
    this.runtime = runtime;
    this.ctx = ctx; // { launcherTarget, launcherArgs, cwd, isDev, desktopDir }
  }

  shortcutTarget() {
    const { launcherTarget, launcherArgs } = this.ctx;
    return { target: launcherTarget, baseArgs: launcherArgs || '' };
  }

  iconFile(pkg) { return store.iconPath(pkg); }

  icoFile(pkg) { return path.join(store.ICON_DIR, `${pkg}.ico`); }

  shortcutPath(app) {
    const s = store.getSettings();
    const dir = s.shortcutDir && s.shortcutDir.trim() ? s.shortcutDir : this.ctx.desktopDir;
    return path.join(dir, `${safeFileName(app.label)}.lnk`);
  }

  /**
   * Tạo hai bản: desktop + Start Menu.
   * Windows Search chỉ lập chỉ mục .lnk trong「Start Menu \ Programs」, chỉ đặt trên desktop thì không tìm thấy;
   * một số máy có desktop bị OneDrive chuyển hướng, bản Start Menu đảm bảo không mất lối vào.
   */
  shortcutPaths(app) {
    const out = [this.shortcutPath(app)];
    if (this.ctx.startMenuDir && store.getSettings().createStartMenuShortcut !== false) {
      // Đặt trong thư mục con riêng: vừa được Windows Search lập chỉ mục, vừa không ghi đè lối tắt của app bên thứ ba cùng tên
      // (thực tế「Hongguo Free Short Drama」trong Start Menu đã bị một trợ lý desktop khác chiếm)
      out.push(path.join(this.ctx.startMenuDir, 'ApkStart', `${safeFileName(app.label)}.lnk`));
    }
    return [...new Set(out)];
  }

  /** Image tương thích được tải khi「lần đầu gặp app ARM」, dùng làm lớp nền chỉ đọc dùng chung, chỉ tải một lần */
  async ensureCompatImage(onProgress) {
    const prov = this.runtime.provisioner;
    if (prov.playImageInfo().ok) return true;
    onProgress({ stage: 'runtime', message: 'Lần đầu cài app ARM: đang tải image tương thích (khoảng 1.5GB, chỉ cần một lần)…' });
    await prov.installPlayImage((p) => onProgress({ stage: 'runtime', message: p.message, percent: p.percent }));
    if (!prov.playImageInfo().ok) throw new Error('Tải image tương thích thất bại, vui lòng kiểm tra mạng rồi thử lại');
    return true;
  }

  /** Đổi image bắt buộc khởi động lại runtime; sau khi khởi động lại thì cài lại các app đã cài từ bản sao lưu APK cục bộ */
  async switchToCompat(onProgress) {
    const apps = store.getApps();
    store.saveSettings({ runtime: { compatImage: true } });
    onProgress({ stage: 'runtime', message: 'Đang chuyển sang image tương thích và khởi động lại runtime…' });
    try { await this.runtime.stop(); } catch (_) { /* ignore */ }
    // Chờ thiết bị cũ biến mất khỏi danh sách adb, tránh bị ensure() coi là instance có thể tái sử dụng
    for (let i = 0; i < 12; i += 1) {
      // eslint-disable-next-line no-await-in-loop
      const ds = await this.runtime.client().devices().catch(() => []);
      if (!ds.some((d) => /^emulator-\d+$/.test(d.serial))) break;
      // eslint-disable-next-line no-await-in-loop
      await sleep(1000);
    }
    const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime không khả dụng sau khi chuyển sang image tương thích');
      err.needsSetup = rt.needsSetup || 'provision';
      throw err;
    }
    for (const app of apps) {
      if (!app.apkPath || !fs.existsSync(app.apkPath)) continue;
      try {
        if (app.bundle) {
          // eslint-disable-next-line no-await-in-loop
          const b = await parseBundle(app.apkPath);
          // eslint-disable-next-line no-await-in-loop
          await rt.client.installMultiple(b.files);
          b.cleanup();
        } else {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.install(app.apkPath);
        }
        onProgress({ stage: 'runtime', message: `Đang khôi phục app đã cài ${app.label}…` });
      } catch (_) { /* khôi phục một app thất bại thì không chặn các app khác */ }
    }
    return rt;
  }

  async install(filePath, onProgress = () => {}) {
    onProgress({ stage: 'parse', message: 'Đang phân tích APK…' });
    let meta;
    let bundle = null;
    if (/\.(apks|xapk)$/i.test(filePath)) {
      bundle = await parseBundle(filePath);
      meta = bundle.meta;
    } else {
      meta = parseApk(filePath);
    }
    onProgress({
      stage: 'parse-done',
      message: `Đã nhận diện ${meta.label} (${meta.package})`,
      meta: { label: meta.label, package: meta.package, versionName: meta.versionName },
    });

    try {
      // Không cần cấu hình: app chỉ có thư viện ARM sẽ tự dùng image có lớp dịch ARM, người dùng không cần bật gì
      if (isArmOnly(meta) && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const switched = await this.switchToCompat(onProgress);
        return this.finishInstall(switched, meta, filePath, bundle, onProgress);
      }

      onProgress({ stage: 'runtime', message: 'Đang chuẩn bị runtime Android…' });
      const rt = await this.runtime.ensure({ onLog: (m) => onProgress({ stage: 'runtime', message: m }) });
      if (!rt.ok) {
        const err = new Error(rt.error || 'Runtime không khả dụng');
        err.needsSetup = rt.needsSetup || 'provision';
        throw err;
      }
      return await this.finishInstall(rt, meta, filePath, bundle, onProgress);
    } finally {
      if (bundle) bundle.cleanup();
    }
  }

  /** Cài app + lưu metadata + lối tắt; khi lỗi sẽ tự sửa và thử lại một lần */
  async finishInstall(rt, meta, filePath, bundle, onProgress) {
    const client = rt.client;
    const existing = store.getApp(meta.package);
    // Sau khi cài, trạng thái đĩa trong snapshot quickboot cũ đã lỗi thời, giữ lại sẽ gây ra「app đã cài biến mất sau khi khởi động lại」
    try { this.runtime.emulator?.invalidateSnapshot(); } catch (_) { /* ignore */ }
    onProgress({ stage: 'install', message: existing ? 'Đang cập nhật app…' : 'Đang cài đặt app…' });
    try {
      if (bundle) await client.installMultiple(bundle.files);
      else await client.install(filePath);
    } catch (e) {
      // Đến bước này vẫn báo ABI không khớp: nghĩa là runtime hiện tại là image AOSP, tự chuyển sang image tương thích rồi cài lại
      if (e.code === 'NO_MATCHING_ABIS' && !this.runtime.provisioner.playImageInfo().ok) {
        await this.ensureCompatImage(onProgress);
        const rt2 = await this.switchToCompat(onProgress);
        onProgress({ stage: 'install', message: 'Đã chuyển sang image tương thích, đang cài đặt lại…' });
        if (bundle) await rt2.client.installMultiple(bundle.files);
        else await rt2.client.install(filePath);
      } else {
        throw e;
      }
    }
    this.runtime.touch();

    // Lưu icon ra đĩa. Icon APK phần lớn là WebP, nativeImage không giải mã được, giao cho renderer giải mã +
    // ảnh giữ chỗ thương hiệu làm dự phòng, đảm bảo .lnk luôn có icon (trước đây icoPath luôn là null).
    // iconFallback ghi nhận「không giải mã được icon thật, đã dùng ảnh giữ chỗ」—— trường hợp này cần báo người dùng như cảnh báo nhẹ,
    // nếu không trên desktop chỉ có một tam giác xanh, người dùng sẽ tưởng ApkStart lấy nhầm icon.
    let iconPath = null;
    let icoPath = null;
    let iconFallback = '';
    if (meta.iconPng) {
      try {
        iconPath = store.iconPath(meta.package);
        fs.writeFileSync(iconPath, meta.iconPng);
      } catch (_) { /* ignore */ }
      try {
        const ico = await iconToIco(meta.iconPng, {
          decode: this.ctx.decodeIcon,
          onFallback: (why) => { iconFallback = why; },
        });
        if (ico) {
          icoPath = this.icoFile(meta.package);
          fs.writeFileSync(icoPath, ico);
        }
      } catch (_) { /* lỗi icon không ảnh hưởng việc cài đặt */ }
    }

    // Sao lưu APK để sau này cài lại / khôi phục
    let apkCopy = null;
    try {
      apkCopy = store.apkPath(meta.package, meta.versionCode.toString(36));
      fs.copyFileSync(filePath, apkCopy);
    } catch (_) { /* ignore */ }

    // Lối vào khởi chạy lấy theo kết quả phân giải của hệ thống:「Activity chính」phân tích từ APK thường không phải
    // lối vào LAUNCHER thật, khởi chạy thẳng bằng nó sẽ bỏ qua trang khởi tạo của app và gây crash.
    let launchActivity = meta.launchActivity;
    try {
      client.clearLauncherCache?.(meta.package);
      const resolved = await client.resolveLauncher(meta.package);
      if (resolved) launchActivity = resolved;
    } catch (_) { /* giữ kết quả phân tích APK */ }

    const app = {
      package: meta.package,
      label: meta.label,
      versionName: meta.versionName,
      versionCode: meta.versionCode,
      activity: launchActivity,
      abis: meta.abis,
      minSdk: meta.minSdk,
      sizeBytes: meta.sizeBytes,
      iconPath,
      icoPath,
      apkPath: apkCopy,
      bundle: !!bundle,
      accent: existing ? existing.accent : accentOf(meta.package),
      installedAt: existing ? existing.installedAt : Date.now(),
      updatedAt: Date.now(),
      launchCount: existing ? existing.launchCount || 0 : 0,
      lastLaunchAt: existing ? existing.lastLaunchAt || 0 : 0,
      shortcutPath: existing ? existing.shortcutPath || null : null,
      bounds: existing ? existing.bounds || null : null,
      pinned: existing ? !!existing.pinned : false,
    };

    store.upsertApp(app);

    const settings = store.getSettings();
    if (settings.createShortcutOnInstall) {
      onProgress({ stage: 'shortcut', message: 'Đang tạo lối tắt trên desktop…' });
      try {
        app.shortcutPath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: app.shortcutPath });
      } catch (e) {
        onProgress({ stage: 'shortcut-warn', message: `Tạo lối tắt thất bại: ${e.message}` });
      }
    }

    // Gợi ý tương thích: khi chỉ có thư viện native ARM, runtime x86 cần lớp dịch
    const warnings = [];
    if (meta.minSdk && meta.minSdk > 34) {
      warnings.push(`App này yêu cầu Android ${meta.minSdk}+, cao hơn runtime hiện tại, có thể không chạy bình thường.`);
    }
    if (iconFallback === 'placeholder') {
      warnings.push('Không phân tích được icon app (có thể là icon thích ứng định dạng đặc biệt), lối tắt tạm dùng icon giữ chỗ.');
    } else if (iconFallback === 'webp-decode-failed') {
      warnings.push('Giải mã icon app (WebP) thất bại, lối tắt tạm dùng icon giữ chỗ.');
    }
    client.batteryOptimizeOff(meta.package).catch(() => {});
    // Khi cài app đã hủy snapshot cũ, ở đây lên lịch lại một lần: lúc rảnh lưu trạng thái「đã cài app mới」,
    // nếu không lần bật máy sau phải khởi động nguội lại (hơn 20 giây).
    try { this.runtime.scheduleSnapshotSave?.(12000); } catch (_) { /* ignore */ }

    onProgress({ stage: 'done', message: `Đã cài đặt xong ${app.label}`, app });
    return { app, warnings, engine: rt.engine };
  }

  createShortcut(app) {
    const { target, baseArgs } = this.shortcutTarget();
    const args = `${baseArgs ? baseArgs + ' ' : ''}--launch "${app.package}"`.trim();
    const ico = app.icoPath && fs.existsSync(app.icoPath) ? app.icoPath : undefined;
    const paths = this.shortcutPaths(app);

    const write = (shortcutPath) => writeShortcut({
      shortcutPath,
      target,
      args,
      iconIcoPath: ico,
      description: `${app.label} — chạy bằng ApkStart`,
      cwd: this.ctx.cwd,
      // Mỗi app một AUMID: nhóm theo app trên taskbar, không bị dồn hết vào ApkStart
      appUserModelId: `RoutineMiku.ApkStart.${app.package}`.slice(0, 128),
    });

    let first = null;
    let startMenuPath = null;
    const errors = [];
    paths.forEach((p, i) => {
      try {
        write(p);
        if (!first) first = p;
        if (i === 1) startMenuPath = p;
      } catch (e) {
        errors.push(`${p}: ${e.message}`);
      }
    });

    // Đường chính đều thất bại (thư mục lối tắt tùy chỉnh không ghi được / bị phần mềm bảo mật chặn):
    // lùi về desktop thử lại một lần —— có icon trên desktop thì người dùng mới tìm được app.
    if (!first) {
      const fallback = path.join(this.ctx.desktopDir, `${safeFileName(app.label)}.lnk`);
      try {
        write(fallback);
        first = fallback;
      } catch (e) {
        errors.push(`${fallback}: ${e.message}`);
      }
    }
    if (!first) throw new Error(errors.join('; ') || 'Tạo lối tắt thất bại');
    // Lưu cả đường dẫn bản Start Menu, khi gỡ cài đặt sẽ xóa cùng
    if (startMenuPath || first) {
      store.upsertApp({ package: app.package, startMenuPath });
    }
    return first;
  }

  /** Bổ sung lối tắt và icon còn thiếu: bản cũ chỉ tạo bản trên desktop, và icon WebP khi đó chưa chuyển đổi được */
  async ensureShortcuts() {
    const made = [];
    // Khi người dùng đã tắt rõ ràng「tự tạo sau khi cài」và app này vốn không có lối vào nào thì không tự ý bổ sung,
    // nếu không thì dù tắt công tắc cũng không ngăn được việc tạo lại khi khởi động.
    const auto = store.getSettings().createShortcutOnInstall !== false;
    for (const app of store.getApps()) {
      if (!auto && !app.shortcutPath && !app.startMenuPath) continue;
      let dirty = false;
      if ((!app.icoPath || !fs.existsSync(app.icoPath)) && app.iconPath && fs.existsSync(app.iconPath)) {
        try {
          const ico = await iconToIco(fs.readFileSync(app.iconPath), { decode: this.ctx.decodeIcon });
          if (ico) {
            const p = this.icoFile(app.package);
            fs.writeFileSync(p, ico);
            store.upsertApp({ package: app.package, icoPath: p });
            app.icoPath = p;
            dirty = true;
          }
        } catch (_) { /* tạo lại icon thất bại không ảnh hưởng lối vào */ }
      }
      const missing = this.shortcutPaths(app).filter((p) => !fs.existsSync(p));
      if (!missing.length && !dirty) continue;
      try {
        // Khi icon vừa được tạo bổ sung, dù .lnk đã tồn tại cũng phải tạo lại để lối tắt dùng icon thật của app
        const madePath = this.createShortcut(app);
        store.upsertApp({ package: app.package, shortcutPath: madePath });
        made.push(app.label);
      } catch (_) { /* một mục thất bại không chặn việc khởi động */ }
    }
    return made;
  }

  async uninstall(pkg, { removeShortcut: rm = true } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure();
    if (rt.ok) await rt.client.uninstall(pkg).catch(() => {});
    if (app && rm) {
      removeShortcut(app.shortcutPath);
      removeShortcut(app.startMenuPath);
    }
    if (app) {
      try { if (app.iconPath && fs.existsSync(app.iconPath)) fs.unlinkSync(app.iconPath); } catch (_) {}
      try { if (app.icoPath && fs.existsSync(app.icoPath)) fs.unlinkSync(app.icoPath); } catch (_) {}
      try { if (app.apkPath && fs.existsSync(app.apkPath)) fs.unlinkSync(app.apkPath); } catch (_) {}
    }
    store.removeApp(pkg);
    return true;
  }

  async launch(pkg, { onLog = () => {}, beforeStart = null, onMark = () => {} } = {}) {
    const app = store.getApp(pkg);
    const rt = await this.runtime.ensure({ onLog });
    onMark('ensure done');
    if (!rt.ok) {
      const err = new Error(rt.error || 'Runtime không khả dụng');
      err.needsSetup = rt.needsSetup;
      throw err;
    }
    // Phải đổi độ phân giải trước khi mở app, tránh wm size gây thay đổi cấu hình làm Activity vừa khởi chạy bị tạo lại
    if (beforeStart) await beforeStart(rt).catch((e) => onLog(`Bỏ qua điều chỉnh hiển thị: ${e.message}`));
    // Xóa các ghi đè wm size / density và thiết lập tự xoay mà bản cũ có thể để lại trong /data.
    // Các ghi đè này được lưu bền, không dọn thì mỗi lần khởi chạy màn hình sẽ bị xoay nằm 90°, có viền đen,
    // click chuột cũng không khớp vị trí (người dùng phản ánh「xoay viền đen / không lấp đầy / không bấm được Đồng ý」).
    await rt.client.resetDisplayOverrides(!!(store.getSettings().display || {}).landscape).catch(() => {});
    // Khi khởi động nguội đã kiểm tra mạng: không có mạng thì nói rõ luôn. Nếu không người dùng chỉ thấy「app này cứ màn hình đen」,
    // hoàn toàn không nghĩ ra là máy ảo không có mạng (trang cần mạng không lấy được dữ liệu thì chỉ là một nền đen).
    // Sửa then chốt: liên kết Wi-Fi thường muộn hơn sys.boot_completed vài chục giây, Hongguo vừa vào đã tải dữ liệu trang chủ,
    // không có mạng thì trang chủ hiện thành một khối đen —— đây chính là nguyên nhân thật của「bấm Đồng ý và tiếp tục rồi cứ màn hình đen」.
    // Vì vậy trước khi mở app hãy chờ mạng sẵn sàng (tối đa 90 giây), thà chờ thêm vài giây còn hơn để người dùng thấy màn hình đen.
    // Trước khi mở app hãy xem mạng: **chỉ chờ, không khởi động lại**.
    // Trước đây ở đây gọi ensureNetwork(), khi mạng chậm sẽ「dừng máy ảo → khởi động nguội」,
    // kết quả là thiết bị adb biến mất giữa lúc cài, thành ra「không mở được Hongguo」.
    // Trên đường khởi chạy tuyệt đối không làm thao tác phá hủy như vậy, chờ không được thì cứ khởi chạy trước, cùng lắm trang tải chậm một chút.
    if (rt.engine === 'emulator' || rt.engine === 'builtin') {
      const net = await this.runtime.waitForNetwork({ onLog, timeoutMs: 20000 }).catch(() => null);
      if (net && net.ok) {
        onLog(`Mạng máy ảo đã sẵn sàng (${net.ip || ''})`);
      } else {
        onLog('Mạng máy ảo chưa sẵn sàng, khởi chạy app trước (trang cần mạng có thể tải sau)');
      }
    }
    const settings = store.getSettings();
    const start = () => rt.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
      freeform: settings.freeform,
      bounds: app ? app.bounds : null,
    });
    // App có thể chưa được cài vào runtime hiện tại (image dựng lại / đã xóa dữ liệu / lần đầu), mở thẳng sẽ báo
    // "Invalid packageName". Cài từ bộ nhớ đệm cục bộ trước rồi mới khởi chạy, như vậy「mở app」luôn vào được,
    // không cần cài thủ công trước —— đúng trải nghiệm「bấm app đã cài là vào thẳng」.
    if (app && app.apkPath && fs.existsSync(app.apkPath)) {
      const pkgs = await rt.client.shell(`pm list packages ${pkg}`, { timeout: 8000 }).catch(() => '');
      if (!new RegExp(`package:${pkg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`).test(pkgs)) {
        onLog('App chưa được cài, đang tự động cài đặt…');
        await rt.client.install(app.apkPath).catch((e) => onLog(`Tự động cài đặt thất bại: ${e.message}`));
      }
    }
    // Theo dõi 25 giây và yêu cầu「sống liên tục 5 giây」mới tính là khởi chạy thành công.
    // Then chốt: tiến trình "chưa lên" và "đã lên rồi lại mất" phải xét riêng. Trước đây hễ pidof rỗng là phán thất bại,
    // kết quả app lớn (như Hongguo lần đầu mở mất hơn chục giây) bị force-stop khởi động lại giữa lúc đang tải,
    // lặp ba vòng mới chạy được, người dùng cảm thấy "bấm xong phải chờ một phút".
    const staysAlive = async () => {
      const t0 = Date.now();
      let aliveSince = 0;
      let seen = false;
      while (Date.now() - t0 < 25000) {
        // Kiểm tra trước rồi mới ngủ: trong container thường trú, khởi động nóng thường thấy tiến trình trong 1 giây,
        // sleep 1 giây trước chẳng khác gì kéo chậm đường nhanh nhất thêm một giây.
        // eslint-disable-next-line no-await-in-loop
        const pid = await rt.client.shell(`pidof ${pkg}`, { timeout: 6000 }).catch(() => '');
        if (!String(pid).trim()) {
          if (seen) return false; // đã lên rồi lại mất = thật sự crash
        } else {
          seen = true;
          if (!aliveSince) aliveSince = Date.now();
          if (Date.now() - aliveSince >= 4000) return true;
        }
        // eslint-disable-next-line no-await-in-loop
        await sleep(700);
      }
      return seen; // chỉ khi chưa từng thấy tiến trình mới tính là thất bại
    };
    try {
      // Đảm bảo đủ quyền runtime trước: -g lúc cài có thể mất hiệu lực sau khi xóa dữ liệu,
      // thiếu quyền thì app bị hộp cấp quyền hệ thống chặn, người dùng thấy「bấm không phản hồi / không mở được」.
      await rt.client.grantRuntimePermissions(pkg).catch(() => {});
      onMark('permissions granted');
      let ok = false;
      for (let attempt = 1; attempt <= 3 && !ok; attempt += 1) {
        if (attempt > 1) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.forceStop(pkg).catch(() => {});
          // Khi hộp cấp quyền chắn phía trước, app trông như「không mở được」; cấp quyền trước rồi đóng hộp thoại
          // eslint-disable-next-line no-await-in-loop
          await rt.client.grantRuntimePermissions(pkg).catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await rt.client.dismissPermissionDialog().catch(() => {});
          // eslint-disable-next-line no-await-in-loop
          await sleep(600 * attempt);
        }
        let started = true;
        try {
          // eslint-disable-next-line no-await-in-loop
          await start();
        } catch (e) {
          // Có log crash rõ ràng mới giao cho lớp ngoài (có thể cần chuyển image tương thích); không có bằng chứng thì phần lớn chỉ là khởi động chậm, thử lại là được
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
          started = false;
        }
        onMark(`am start #${attempt} ${started ? 'ok' : 'fail'}`);
        // Activity lên xong thì khóa hướng ngay. Đặt ở đây vì bản thân quá trình khởi chạy app sẽ gây
        // thay đổi cấu hình (Activity tạo lại), user-rotation đặt trước khi khởi chạy có thể bị hệ thống đặt lại về 0 ——
        // một khi về 0, hình trên màn hình ngang sẽ nằm nghiêng 90° (người dùng thấy「xoay không thẳng」).
        if (started) {
          // eslint-disable-next-line no-await-in-loop
          await rt.client.setOrientation(!!(store.getSettings().display || {}).landscape).catch(() => {});
        }
        // eslint-disable-next-line no-await-in-loop
        ok = started ? await staysAlive() : false;
        onMark(`alive #${attempt} ${ok}`);
        if (!ok && attempt < 3) onLog(`App thoát sau khi khởi chạy (lần ${attempt}), đang tự động thử lại…`);
      }
      if (!ok) {
        // Dự phòng: thoát bất thường sẽ để lại dữ liệu「khởi tạo dở」, khiến về sau lần nào cũng crash.
        // Xóa dữ liệu app một lần rồi mở lại, tỉ lệ thành công cao nhất (người dùng không phải tự vào cài đặt xóa cache).
        onLog('App liên tục thoát, đang đặt lại dữ liệu app rồi thử lại…');
        await rt.client.shell(`pm clear ${pkg}`, { timeout: 20000 }).catch(() => '');
        await sleep(800);
        // pm clear sẽ xóa luôn quyền runtime, bắt buộc cấp lại, nếu không sẽ kẹt ở hộp cấp quyền hệ thống
        await rt.client.grantRuntimePermissions(pkg).catch(() => {});
        await start().catch((e) => {
          if (e.code === 'APP_CRASHED' && e.crash) throw e;
        });
        ok = await staysAlive();
        if (!ok) await rt.client.dismissPermissionDialog().catch(() => {});
      }
      if (!ok) {
        const err = new Error('App thoát ngay sau khi khởi chạy, đã tự động thử lại và đặt lại dữ liệu app nhưng vẫn không thành công');
        err.code = 'APP_UNSTABLE';
        throw err;
      }
    } catch (e) {
      if (e.code === 'APP_CRASHED' && !this.runtime.provisioner.playImageInfo().ok) {
        // Crash đến từ lớp dịch ARM: tự chuyển image, cài lại APK sao lưu, khởi chạy lại một lần
        onLog('Phát hiện lớp dịch ARM bị crash, đang tự động chuyển sang image tương thích…');
        await this.ensureCompatImage(onLog ? (m) => onLog(m.message || '') : () => {});
        const rt2 = await this.switchToCompat((m) => onLog(m.message || ''));
        if (app && app.apkPath && fs.existsSync(app.apkPath)) {
          try { await rt2.client.install(app.apkPath); } catch (_) { /* giữ gói gốc */ }
        }
        await rt2.client.startApp(app ? app.package : pkg, app ? app.activity : null, {
          freeform: settings.freeform,
          bounds: app ? app.bounds : null,
        });
      } else {
        throw e;
      }
    }
    this.runtime.touch();
    if (app) {
      store.upsertApp({
        package: app.package,
        launchCount: (app.launchCount || 0) + 1,
        lastLaunchAt: Date.now(),
      });
    }
    return { ok: true, engine: rt.engine };
  }
}

module.exports = { Installer, accentOf, parseBundle };
