'use strict';
/**
 * Cập nhật trực tuyến: lấy bản mới nhất từ GitHub Releases (RoutineMiku/apkstart), tải về và thay thế tại chỗ.
 *
 * Phải lo cho cả ba dạng phát hành:
 *   - Bản cài đặt (NSIS): tải `ApkStart-x.y.z-Setup.exe`, cài im lặng (/S);
 *   - Bản nhẹ (zip portable, môi trường chạy tải khi cần): tải `ApkStart-vX-win64-portable.zip`,
 *     giải nén rồi ghi đè thư mục chương trình — thư mục môi trường chạy (%APPDATA%\apkstart\runtime), ứng dụng đã cài
 *     và snapshot đều nằm trong thư mục người dùng, thay file chương trình không đụng tới chúng;
 *   - Bản đầy đủ (portable kèm runtime): giống bản nhẹ, chỉ là thư mục có thêm resources\runtime.
 *
 * Không thể thay thế ngay trong tiến trình này (exe đang bị chiếm), nên tạo một đoạn script PowerShell,
 * giao cho tiến trình độc lập qua EncodedCommand: chờ tiến trình này thoát → chép file → khởi chạy lại.
 * Truyền script bằng base64 thay vì ghi file .ps1 là để né lỗi cũ "đường dẫn có tiếng Trung thì script bị giải mã theo GBK"
 * (PowerShell 5.1 đọc script không có BOM sẽ hiểu theo ANSI).
 */
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { downloadAnyParallel, downloadMulti } = require('./download');
const { ZipFile } = require('./zip');
const { cmpVer } = require('./version');
const { Sources } = require('./sources');

const OWNER = 'RoutineMiku';
const REPO = 'apkstart';

/** Chuỗi nháy đơn PowerShell: dấu ' bên trong phải viết thành '' */
function psq(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

class Updater {
  /**
   * @param {{currentVersion:string, exePath:string, isPackaged:boolean, dataDir:string,
   *          onProgress?:Function}} o
   */
  constructor(o) {
    this.current = o.currentVersion || '0.0.0';
    this.exePath = o.exePath;
    this.installDir = path.dirname(o.exePath || '');
    this.isPackaged = !!o.isPackaged;
    this.dataDir = o.dataDir;
    this.onProgress = o.onProgress || (() => {});
    this.settings = typeof o.settings === 'function' ? o.settings : () => (o.settings || {});
    // settings() dùng cho sources: quyết định "đi GitHub hay Gitee", "có tiền tố mirror hay không"
    this.sources = new Sources(this.settings);
    this.latest = null;
    this._last = null;
  }

  /** Dạng cài đặt: bản cài (có trình gỡ cài đặt) hay gói portable */
  get flavor() {
    try {
      const un = fs.readdirSync(this.installDir).find((n) => /^Uninstall .*\.exe$/i.test(n));
      if (un) return 'setup';
    } catch (_) { /* ignore */ }
    return 'portable';
  }

  get updateDir() {
    return path.join(this.dataDir, 'update');
  }

  /**
   * Kiểm tra cập nhật: hỏi đồng thời GitHub / Gitee, lấy số phiên bản cao hơn, tài nguyên lấy hợp của hai bên.
   * Địa chỉ tải cụ thể sẽ được đo tốc độ thực và sắp xếp lại trong prepare().
   */
  /**
   * @param {{force?:boolean}} [opts] force=true thì bỏ qua bộ nhớ đệm phiên bản 10 phút
   *        (người dùng chủ động bấm "Kiểm tra cập nhật" phải nhận kết quả mới nhất; kiểm tra im lặng lúc khởi động dùng cache)
   */
  async check(opts = {}) {
    const merged = await this.sources.latest({ force: !!opts.force });
    const pick = (re) => merged.assets.find((a) => re.test(String(a.name || '')));
    // Bản phát hành có cả "gói portable" lẫn "gói môi trường chạy trọn bộ" (ApkStart-runtime-*.zip).
    // Phép khớp .zip dự phòng phải loại gói môi trường chạy trọn bộ: nếu một lần phát hành chỉ có gói đó
    // mà không có gói portable, logic cũ sẽ coi nó là gói cập nhật và giải nén vào thư mục chương trình (thêm 1.5GB file, chương trình cũng bị hỏng).
    const isRuntimePack = (a) => /runtime/i.test(String((a && a.name) || ''));

    const wantSetup = this.flavor === 'setup';
    const asset = wantSetup
      ? (pick(/Setup\.exe$/i) || merged.assets.find((a) => /\.exe$/i.test(a.name) && !isRuntimePack(a)))
      : (pick(/portable.*\.zip$/i) || pick(/win64.*\.zip$/i)
        || merged.assets.find((a) => /\.zip$/i.test(a.name) && !isRuntimePack(a)));

    this.latest = {
      version: merged.version,
      tag: merged.tag,
      name: merged.name,
      notes: merged.notes,
      htmlUrl: merged.htmlUrl,
      publishedAt: merged.publishedAt,
      // Nhớ mang theo parts: gói chia mảnh của Gitee không có url duy nhất, bỏ parts thì thành "có tài nguyên mà không có địa chỉ"
      asset: asset
        ? {
          name: asset.name,
          size: asset.size,
          url: asset.url,
          // Tài nguyên cùng tên có trên cả GitHub / Gitee: giữ cả hai địa chỉ, prepare() đo tốc độ chọn bên nhanh.
          // sizes là "kích thước riêng của từng địa chỉ" — số byte hai nguồn nén ra không giống nhau.
          urls: asset.urls,
          sizes: asset.sizes,
          source: asset.source,
          parts: asset.parts,
          partial: asset.partial,
        }
        : null,
      assets: merged.assets,
      // Phiên bản mới nhất của từng nguồn / nguồn nào không truy cập được, để giao diện hiển thị đúng "lần này dùng nguồn nào"
      sources: merged.sources,
      unreachable: merged.unreachable,
      flavor: this.flavor,
      hasUpdate: cmpVer(merged.tag, this.current) > 0,
      current: this.current,
      canAutoApply: !!asset && (!!asset.url || !!(asset.parts && asset.parts.length)),
    };
    this._last = this.latest;
    return this.latest;
  }

  /**
   * Tải và chuẩn bị "payload": bản portable giải nén vào update/<ver>/payload, bản cài thì giữ nguyên Setup.exe.
   * @returns {Promise<{mode:'zip'|'setup', payload:string, version:string}>}
   */
  async prepare(info) {
    const it = info || this.latest;
    if (!it || !it.asset) throw new Error('Phiên bản này không có gói cài đặt tự động, vui lòng tải thủ công từ trang phát hành trên GitHub');
    const dir = path.join(this.updateDir, it.version);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, it.asset.name);
    let total = it.asset.size || 0;
    const conns = Math.max(1, Math.min(16, Number((this.settings().runtime || {}).downloadConnections) || 8));

    // Tệp đính kèm Gitee giới hạn 100MB mỗi file, nên khi phát hành gói được cắt thành .part1/.part2.
    // Mỗi mảnh được đo tốc độ chọn nguồn riêng (có thể một phần từ Gitee, một phần từ mirror GitHub),
    // tải xong ghép lại theo thứ tự thành gói đầy đủ — với người dùng vẫn chỉ là "tải + giải nén".
    if (it.asset.parts && it.asset.parts.length) {
      await this._downloadParts(it.asset, file, conns, total);
    } else {
      this.onProgress({ stage: 'download', percent: 1, message: `Đang tải ${it.asset.name}…` });
      // Địa chỉ ứng viên = nguồn gốc + tiền tố mirror; tải thử 256KB mỗi nơi để đo tốc độ, rồi tải chia khối từ nơi nhanh nhất.
      // Đây là cách chọn đường duy nhất đáng tin khi "GitHub trực tiếp vài chục KB/s, mirror chạy được vài MB/s":
      // đoán theo tên miền vô ích, cùng một ngày mà khác khung giờ đã chênh lệch rất nhiều.
      const cands = this.sources.candidates(it.asset);
      const ranked = await this.sources.rank(cands, { onProgress: (p) => this.onProgress(p) }).catch(() => cands);
      // Tổng kích thước cho tiến trình phải lấy của "nguồn đang thực sự tải": gói GitHub và Gitee không cùng một dãy byte
      // (khác trình nén, có thể lệch vài MB), lấy sai sẽ hiện mãi 92% rồi đột ngột nhảy sang hoàn tất.
      const sizes = it.asset.sizes || {};
      for (const u of ranked) {
        if (sizes[u]) { total = sizes[u]; break; }
      }
      // downloadMulti: tải chia khối đồng thời từ "GitHub trực tiếp" và "mirror", cộng dồn băng thông;
      // khi chỉ có một nguồn dùng được hoặc bên kia không hỗ trợ Range, nó tự lùi về chia khối một nguồn.
      await downloadMulti(ranked, file, {
        connections: conns,
        onProgress: (pr) => {
          const pct = pr.percent != null ? pr.percent : (total ? Math.round((pr.got / total) * 100) : 0);
          const mb = `${(pr.got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`;
          const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
          this.onProgress({
            stage: 'download',
            percent: Math.max(1, Math.min(99, pct)),
            message: `Đang tải ${mb}${sp}`,
            speed: pr.speed,
          });
        },
      });
    }

    if (/\.zip$/i.test(file)) {
      const out = path.join(dir, 'payload');
      fs.rmSync(out, { recursive: true, force: true });
      fs.mkdirSync(out, { recursive: true });
      await this._extract(file, out);
      this.onProgress({ stage: 'ready', percent: 100, message: 'Đã giải nén xong gói cập nhật' });
      return { mode: 'zip', payload: out, version: it.version };
    }
    this.onProgress({ stage: 'ready', percent: 100, message: 'Đã tải xong gói cài đặt' });
    return { mode: 'setup', payload: file, version: it.version };
  }

  /**
   * Tải và ghép gói chia mảnh.
   * @param {{name:string, size:number, parts:Array<{index:number,size:number,urls:string[]}>}} asset
   */
  async _downloadParts(asset, target, conns, total) {
    const dir = path.dirname(target);
    let doneBytes = 0;
    const fd = fs.openSync(target, 'w');
    try {
      for (const part of asset.parts) {
        const tmp = path.join(dir, `${asset.name}.${part.index}.tmp`);
        const cands = [];
        for (const u of part.urls) {
          for (const c of this.sources.candidates(u)) if (!cands.includes(c)) cands.push(c);
        }
        // eslint-disable-next-line no-await-in-loop
        const ranked = await this.sources.rank(cands, {
          onProgress: (p) => this.onProgress({ ...p, percent: Math.max(1, Math.min(99, Math.round((doneBytes / (total || 1)) * 100))) }),
        }).catch(() => cands);
        // eslint-disable-next-line no-await-in-loop
        await downloadAnyParallel(ranked, tmp, {
          connections: conns,
          onProgress: (pr) => {
            const got = doneBytes + (pr.got || 0);
            const pct = total ? Math.round((got / total) * 100) : 0;
            const sp = Number(pr.speed) > 0 ? ` · ${(pr.speed / 1048576).toFixed(2)} MB/s` : '';
            this.onProgress({
              stage: 'download',
              percent: Math.max(1, Math.min(99, pct)),
              message: `Đang tải ${(got / 1048576).toFixed(1)} MB${total ? ` / ${(total / 1048576).toFixed(1)} MB` : ''}`
                + ` (mảnh ${part.index}/${asset.parts.length})${sp}`,
              speed: pr.speed,
            });
          },
        });
        const buf = fs.readFileSync(tmp);
        if (part.size && buf.length !== part.size) {
          throw new Error(`Mảnh ${part.index} sai kích thước (${buf.length} ≠ ${part.size}), đã dừng, có thể thử lại`);
        }
        fs.writeSync(fd, buf, 0, buf.length, doneBytes);
        doneBytes += buf.length;
        fs.rmSync(tmp, { force: true });
      }
    } finally {
      fs.closeSync(fd);
    }
    if (total && doneBytes !== total) {
      throw new Error(`Gói cập nhật sau khi ghép sai kích thước (${doneBytes} ≠ ${total}), đã dừng, có thể thử lại`);
    }
  }

  async _extract(zipPath, dest) {
    const zf = new ZipFile(zipPath);
    try {
      const names = zf.names().filter((n) => !n.endsWith('/'));
      let i = 0;
      for (const n of names) {
        i += 1;
        const target = path.join(dest, n.replace(/\\/g, '/'));
        if (!target.startsWith(path.resolve(dest))) continue;   // chống zip-slip
        fs.mkdirSync(path.dirname(target), { recursive: true });
        await zf.pipeTo(n, fs.createWriteStream(target));
        if (i % 20 === 0) {
          this.onProgress({
            stage: 'extract',
            percent: Math.min(99, Math.round((i / names.length) * 100)),
            message: `Đang giải nén ${i}/${names.length}`,
          });
        }
      }
    } finally {
      try { zf.close(); } catch (_) { /* ignore */ }
    }
  }

  /**
   * Tạo và chạy script "thay thế + khởi động lại", sau đó bên gọi chịu trách nhiệm thoát ứng dụng.
   * @param {{mode:'zip'|'setup', payload:string, version:string}} job
   * @param {{waitPid?:number, spawn?:boolean}} [opts] khi test có thể chỉ định pid khác / không chạy thật
   */
  apply(job, opts = {}) {
    const exe = this.exePath;
    const dir = this.installDir;
    const logFile = path.join(this.updateDir, 'update.log');
    fs.mkdirSync(this.updateDir, { recursive: true });
    const waitPid = opts.waitPid || process.pid;

    const lines = [
      `$ErrorActionPreference = 'SilentlyContinue'`,
      `$log = ${psq(logFile)}`,
      `function Note($m) { Add-Content -Path $log -Value ("[{0}] {1}" -f (Get-Date -Format 'HH:mm:ss'), $m) }`,
      `Note 'updater start'`,
      // Chờ tiến trình này thoát hẳn (tối đa 90 giây), nếu không exe/dll vẫn bị chiếm
      `try { Wait-Process -Id ${waitPid} -Timeout 90 } catch { }`,
      `Start-Sleep -Milliseconds 700`,
    ];

    if (job.mode === 'zip') {
      lines.push(
        `$src = ${psq(job.payload)}`,
        `$dst = ${psq(dir)}`,
        `$ok = $false`,
        `for ($i = 1; $i -le 12; $i++) {`,
        `  Copy-Item -Path (Join-Path $src '*') -Destination $dst -Recurse -Force`,
        `  $probe = Join-Path $dst ${psq(path.basename(exe))}`,
        `  if (Test-Path $probe) { $ok = $true; Note "copy pass $i ok"; break }`,
        `  Note "copy pass $i failed, retry"; Start-Sleep -Milliseconds 600`,
        `}`,
        `if (-not $ok) { Note 'copy failed' }`,
        // File đã bị xóa trong bản mới sẽ không biến mất khi ghi đè, nhưng giữ lại cũng vô hại;
        // chỉ dọn thư mục giải nén lần này, tránh chiếm không vài trăm MB.
        `Remove-Item -Path $src -Recurse -Force`,
      );
    } else {
      lines.push(
        `Note 'run installer'`,
        `$p = Start-Process -FilePath ${psq(job.payload)} -ArgumentList '/S' -PassThru -Wait`,
        `Note ("installer exit " + $p.ExitCode)`,
        `Start-Sleep -Milliseconds 800`,
      );
    }

    lines.push(
      `if (Test-Path ${psq(exe)}) { Start-Process -FilePath ${psq(exe)}; Note 'relaunched' }`,
      `Note 'updater done'`,
      `Start-Sleep -Milliseconds 400`,
      `Remove-Item -Path ${psq(path.join(this.updateDir, job.version))} -Recurse -Force`,
      // Lệnh dọn dẹp cuối thất bại (thư mục đã bị xóa / bị phần mềm diệt virus chiếm) không nên khiến bên gọi tưởng cập nhật thất bại
      `exit 0`,
    );

    const script = lines.join('\r\n');
    fs.writeFileSync(path.join(this.updateDir, 'apply.log.ps1'), script, 'utf8');
    if (opts.spawn === false) return script;
    // -EncodedCommand dùng base64 UTF-16LE: đường dẫn tiếng Trung (hay Unicode) trong script cũng không bị giải mã GBK làm hỏng
    const b64 = Buffer.from(script, 'utf16le').toString('base64');
    const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    // Ở đây **không được** dùng detached: một số phần mềm bảo mật / chính sách sandbox chặn thẳng "tiến trình console tách rời",
    // biểu hiện là script lặng lẽ không chạy gì cả (giao diện cập nhật kẹt ở "Đang thay thế chương trình và khởi động lại").
    // Trên Windows tiến trình cha thoát không giết tiến trình con thường, nên dùng "tiến trình con thường + unref" vẫn tiếp tục
    // chạy sau khi ta thoát, lại tương thích tốt hơn.
    const child = spawn(ps, [
      '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
      '-WindowStyle', 'Hidden', '-EncodedCommand', b64,
    ], { stdio: 'ignore', windowsHide: true });
    child.unref();
    return true;
  }

  /** Khi không mở được UI (hoặc không có tài nguyên cài tự động), mở trang phát hành bằng trình duyệt */
  static repoUrl() {
    return `https://github.com/${OWNER}/${REPO}/releases`;
  }
}

module.exports = { Updater, cmpVer, OWNER, REPO };
