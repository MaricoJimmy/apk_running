'use strict';
/**
 * Nén gói portable (Windows zip).
 *
 * Tại sao không dùng `Compress-Archive` của PowerShell:
 * nó dùng deflate có sẵn của .NET (tương đương zlib mức 6), cùng một thư mục 225MB nén ra được
 * 105,213,775 byte; deflate của 7-Zip (`-mx=9`) chỉ cần 99,616,541 byte —— chênh 5.6MB.
 * Mà giới hạn mỗi file đính kèm bản phát hành trên Gitee là 100MB (thực tế 104,800,000 byte tải lên được,
 * còn 105,213,775 thì bị tách thành part1/part2 khiến người dùng không giải nén trực tiếp được). Chênh 5MB này
 * dẫn tới kết quả là "gói người dùng trong nước nhận được hoặc không giải nén được, hoặc phải tải hai phần".
 *
 * Vì vậy ở đây cố định dùng 7-Zip để nén; chỉ khi không tìm thấy 7-Zip mới lùi về Compress-Archive (và cảnh báo rõ ràng).
 *
 * Cách dùng:
 *   node build/zip.js <thư-mục-nguồn> <đầu-ra.zip> [--limit-mb 100]
 * Mã thoát: 0 thành công / 1 thất bại / 2 vượt giới hạn dung lượng (CI coi là thất bại, đừng âm thầm phát hành gói chia phần nữa)
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const MIB = 1024 * 1024;

/** Tìm file thực thi độc lập của 7-Zip (7z.exe hoặc 7za.exe) ở các vị trí thường gặp */
function find7z() {
  const explicit = process.env.APKSTART_7Z;
  if (explicit && fs.existsSync(explicit)) return explicit;

  const direct = [
    'C:\\Program Files\\7-Zip\\7z.exe',
    'C:\\Program Files (x86)\\7-Zip\\7z.exe',
    path.join(__dirname, '..', 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe'),
  ];
  for (const p of direct) if (fs.existsSync(p)) return p;

  // Tìm trong PATH (windows-latest của GitHub Actions có sẵn 7-Zip và nằm trên PATH)
  const pathDirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean);
  for (const dir of pathDirs) {
    for (const exe of ['7z.exe', '7za.exe']) {
      const p = path.join(dir, exe);
      try { if (fs.existsSync(p)) return p; } catch (_) { /* ignore */ }
    }
  }

  // Bộ nhớ đệm 7zip do electron-builder tải về (thường gặp trên máy phát triển cục bộ)
  const cache = path.join(process.env.LOCALAPPDATA || '', 'electron-builder', 'Cache');
  try {
    for (const d of fs.readdirSync(cache)) {
      if (!/^7zip/i.test(d)) continue;
      const base = path.join(cache, d);
      for (const sub of fs.readdirSync(base)) {
        const p = path.join(base, sub, 'bin', '7za.exe');
        if (fs.existsSync(p)) return p;
      }
    }
  } catch (_) { /* không có thư mục cache */ }
  return '';
}

function dirStats(dir) {
  let files = 0;
  let bytes = 0;
  const walk = (d) => {
    for (const it of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, it.name);
      if (it.isDirectory()) walk(p);
      else { files += 1; bytes += fs.statSync(p).size; }
    }
  };
  walk(dir);
  return { files, bytes };
}

/** Nén zip bằng 7-Zip: đặt cwd là thư mục nguồn để đường dẫn trong gói là tương đối, không kèm tên thư mục cha */
function zipWith7z(exe, srcDir, outZip, level = 9) {
  const r = spawnSync(exe, ['a', '-tzip', '-mm=Deflate', `-mx=${level}`, '-bso0', '-bsp0', '-y', outZip, '*'], {
    cwd: srcDir,
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Nén bằng 7-Zip thất bại (${r.status}): ${String(r.stderr || r.stdout || '').slice(0, 400)}`);
  }
}

/** Dự phòng: PowerShell Compress-Archive (dung lượng lớn hơn 5%, chỉ dùng khi chưa cài 7-Zip) */
function zipWithPowershell(srcDir, outZip) {
  const ps = `Compress-Archive -Path '${path.join(srcDir, '*')}' -DestinationPath '${outZip}' -CompressionLevel Optimal -Force`;
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  if (r.status !== 0) {
    throw new Error(`Compress-Archive thất bại: ${String(r.stderr || '').slice(0, 400)}`);
  }
}

/** Tự kiểm tra kết quả nén: đọc lại bằng trình phân tích zip của chính ứng dụng, xác nhận số mục và tổng byte giải nén khớp nhau */
function verify(zipPath, expect) {
  const { ZipFile } = require('../src/core/zip');
  const zip = new ZipFile(zipPath);
  try {
    const names = zip.names().filter((n) => !n.endsWith('/'));
    let bytes = 0;
    for (const n of names) bytes += zip.entries.get(n).uncompSize;
    if (names.length !== expect.files) {
      throw new Error(`Số mục không khớp: trong gói ${names.length}, thư mục nguồn ${expect.files}`);
    }
    if (bytes !== expect.bytes) {
      throw new Error(`Tổng byte giải nén không khớp: trong gói ${bytes}, thư mục nguồn ${expect.bytes}`);
    }
    return names.length;
  } finally {
    zip.close();
  }
}

function main() {
  const srcDir = path.resolve(process.argv[2] || '');
  const outZip = path.resolve(process.argv[3] || '');
  const limArg = process.argv.indexOf('--limit-mb');
  const limitMiB = limArg > 0 ? Number(process.argv[limArg + 1]) : 100;
  if (!srcDir || !fs.existsSync(srcDir) || !outZip) {
    console.error('Cách dùng: node build/zip.js <thư-mục-nguồn> <đầu-ra.zip> [--limit-mb 100]');
    process.exit(1);
  }

  const stats = dirStats(srcDir);
  console.log(`Đang nén ${srcDir} (${stats.files} file, ${(stats.bytes / MIB).toFixed(1)} MB)`);
  fs.rmSync(outZip, { force: true });

  const exe = find7z();
  if (exe) {
    console.log('Trình nén:', exe);
    zipWith7z(exe, srcDir, outZip);
  } else {
    console.warn('⚠️  Không tìm thấy 7-Zip, lùi về Compress-Archive —— sản phẩm sẽ lớn hơn khoảng 5%, có thể vượt giới hạn mỗi file của Gitee');
    zipWithPowershell(srcDir, outZip);
  }

  const size = fs.statSync(outZip).size;
  const entries = verify(outZip, stats);
  console.log(`Hoàn tất: ${outZip}`);
  console.log(`  ${entries} mục, ${size} byte (${(size / MIB).toFixed(2)} MiB), tỷ lệ nén ${(size / stats.bytes * 100).toFixed(1)}%`);

  if (size > limitMiB * MIB) {
    console.error(`✗ Vượt giới hạn ${limitMiB} MiB (giới hạn mỗi file đính kèm trên Gitee là 100MB). Hãy giảm kích thước gói trước, đừng lách bằng cách chia nhỏ.`);
    process.exit(2);
  }
  console.log(`  ✓ Nằm trong ${limitMiB} MiB (còn dư ${((limitMiB * MIB - size) / MIB).toFixed(2)} MiB)`);
}

if (require.main === module) main();

module.exports = { find7z, dirStats, verify };
