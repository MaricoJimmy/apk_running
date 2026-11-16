'use strict';
/**
 * Sắp xếp engine/ thành runtime "có thể phân phối kèm gói": build/runtime/
 *
 * Bước then chốt là nén system.img. system.img của AOSP là ảnh thưa (sparse) 3.1GB,
 * phần lớn trong đó là số 0, sau khi gzip chỉ còn ~580MB. Dung lượng của bản phát hành một file gần như nằm hết ở đây.
 * Cộng thêm emulator (khoảng 340MB sau khi tinh gọn) + Electron + platform-tools, cả gói khoảng 1.0~1.1GB.
 * Nếu không nén thì bản phát hành sẽ lên tới hơn 1.4GB.
 * Cái giá là lần khởi động đầu mất 1~2 phút để giải nén nó vào thư mục người dùng (chỉ làm một lần),
 * logic giải nén nằm ở materializeImages() trong src/core/provision.js.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');

const ROOT = path.join(__dirname, '..');
const SRC = path.join(ROOT, 'engine');
const OUT = path.join(ROOT, 'build', 'runtime');
const MARK = path.join(OUT, '.prepared');
// Mẫu /data khởi tạo sẵn (ext4 đã định dạng, nén xz). Xem chú thích ở chỗ userdata.img bên dưới.
const SEED_USERDATA = path.join(__dirname, 'seed', 'userdata.img.gz');

function sizeOf(p) {
  try { return fs.statSync(p).size; } catch (_) { return 0; }
}

async function gzipFile(src, dest) {
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 6 }),
    fs.createWriteStream(dest),
  );
}

/** Ảnh lớn dùng XZ (LZMA2): tiết kiệm thêm ~25% so với gzip -6 (system.img 1.5GB→~1.1GB).
 *  Mặc định mức cực hạn 9e; CI hai nhân có thể dùng XZ_PRESET=6 để giảm thời gian xuống 1/3 (dung lượng +3%).
 *
 *  Ghi chú triển khai (những cái bẫy đã gặp):
 *   - Dùng lzma của python (đơn luồng, ổn định). createCompressStream của @napi-rs/lzma trong một số
 *     môi trường bị treo ở 0 byte (thực tế treo 18 phút không có đầu ra), chỉ dùng làm dự phòng cuối cùng và phải có timeout.
 *   - [Nguyên nhân thật khiến CI từng treo 3 tiếng] File nguồn phải được pipe vào stdin của tiến trình con và đóng lại sau khi đọc xong.
 *     Phía python là `shutil.copyfileobj(sys.stdin.buffer, z)`, không nhận được EOF thì chờ đầu vào mãi mãi,
 *     stdout không ghi một byte nào, tiến trình không bao giờ thoát. Lúc đó chỉ nối p.stdout, ở máy cục bộ vì đã có .xz
 *     nên được "bỏ qua nén lặp lại" che mất, còn CI với thư mục mới hoàn toàn thì chắc chắn dính.
 *   - Thêm watchdog: trình nén có gặp sự cố gì cũng bị kill rồi lùi về gzip dự phòng, tuyệt đối không để chuỗi đóng gói treo vô hạn.
 *   - Không tìm thấy python / nén thất bại → gzip -9 (dung lượng lớn hơn chút nhưng không bao giờ treo),
 *     lúc chạy materializeImages chọn trình giải nén theo phần mở rộng, nhận cả hai loại sản phẩm.
 */
function findPython() {
  const { spawnSync } = require('child_process');
  for (const cmd of ['python', 'python3', 'py']) {
    try {
      const r = spawnSync(cmd, ['-c', 'import lzma;print("ok")'], {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'],
      });
      if (r.status === 0 && /ok/.test(String(r.stdout))) return cmd;
    } catch (_) { /* thử cái tiếp theo */ }
  }
  return null;
}

async function xzFile(src, dest) {
  const preset = Math.max(0, Math.min(9, Number(process.env.XZ_PRESET || 9)));
  const extreme = preset >= 9 && process.env.XZ_NO_EXTREME !== '1';
  const pyPreset = extreme ? '9|lzma.PRESET_EXTREME' : String(preset);
  const dictSize = preset >= 9 ? (1 << 27) : preset >= 6 ? (1 << 26) : (1 << 23);
  // Mặc định 2 giờ (3GB / 2 nhân / preset 6 thực tế ~40 phút); quá thời gian thì kill và lùi về gzip dự phòng.
  const timeoutMs = Math.max(5000, Number(process.env.XZ_TIMEOUT_MS || 2 * 60 * 60 * 1000));
  const py = findPython();
  if (py) {
    const { spawn } = require('child_process');
    const p = spawn(py, ['-c', [
      'import lzma,sys,shutil',
      `flt=[{"id":lzma.FILTER_LZMA2,"preset":${pyPreset},"dict_size":${dictSize}}]`,
      'z=lzma.LZMAFile(sys.stdout.buffer,mode="wb",format=lzma.FORMAT_XZ,filters=flt)',
      'shutil.copyfileobj(sys.stdin.buffer,z); z.close()',
    ].join(';')], { stdio: ['pipe', 'pipe', 'inherit'], windowsHide: true });

    // Gắn listener trước, tránh việc tiến trình con thoát trước khi ta await mà mất sự kiện close.
    const exited = new Promise((resolve) => {
      p.on('close', resolve);
      p.on('error', () => resolve(-1));
    });
    const watchdog = setTimeout(() => {
      console.log(`  (nén xz quá ${Math.round(timeoutMs / 60000)} phút, dừng lại và chuyển sang gzip -9)`);
      try { p.kill(); } catch (_) { /* đã thoát */ }
    }, timeoutMs);

    let ok = false;
    try {
      // Then chốt: stdin mới là đầu vào của trình nén. pipeline đọc xong src sẽ end(p.stdin),
      // python nhận được EOF mới flush khối cuối XZ và thoát bình thường.
      const streams = [
        pipeline(fs.createReadStream(src), p.stdin),
        pipeline(p.stdout, fs.createWriteStream(dest)),
      ];
      // Bất kỳ luồng nào lỗi (EPIPE / ghi đĩa thất bại) thì kết thúc tiến trình con ngay, không chờ watchdog.
      streams.forEach((s) => s.catch(() => { try { p.kill(); } catch (_) { /* noop */ } }));
      const settled = await Promise.allSettled(streams);
      const code = await exited;
      ok = code === 0 && settled.every((r) => r.status === 'fulfilled') && sizeOf(dest) > 0;
    } catch (_) {
      ok = false;
    } finally {
      clearTimeout(watchdog);
    }
    if (ok) return;
    // Để lại nửa file .xz sẽ làm bẩn sản phẩm, phải xóa trước rồi mới chạy dự phòng.
    try { fs.rmSync(dest, { force: true }); } catch (_) { /* ignore */ }
    console.log(`  (${py} nén thất bại, chuyển sang gzip -9)`);
  } else {
    console.log('  (không tìm thấy python, chuyển sang gzip -9 (dung lượng lớn hơn chút nhưng đáng tin cậy))');
  }
  // Dự phòng: gzip -9 (không phải xz, lúc chạy materializeImages chọn trình giải nén theo phần mở rộng)
  await pipeline(
    fs.createReadStream(src),
    zlib.createGzip({ level: 9 }),
    fs.createWriteStream(dest.replace(/\.xz$/i, '.gz')),
  );
}

async function main() {
  const force = process.argv.includes('--force');
  if (fs.existsSync(MARK) && !force) {
    console.log('build/runtime đã là mới nhất (thêm --force để build lại)');
    return;
  }
  if (!fs.existsSync(SRC)) {
    console.error('Thiếu thư mục engine/, không thể chuẩn bị runtime');
    process.exit(1);
  }
  fs.mkdirSync(OUT, { recursive: true });

  // 1. Sao chép trực tiếp emulator / platform-tools (không gồm sản phẩm cũ)
  for (const dir of ['emulator', 'platform-tools']) {
    const s = path.join(SRC, dir);
    if (!fs.existsSync(s)) continue;
    console.log(`Đang sao chép ${dir}…`);
    fs.cpSync(s, path.join(OUT, dir), { recursive: true });
  }

  // 1.5 Tinh gọn: xóa các file không bao giờ được nạp với tham số khởi động cố định (khoảng -400MB)
  if (!process.argv.includes('--no-slim')) {
    console.log('Đang tinh gọn runtime…');
    const { slim } = require('./slim-runtime');
    slim(OUT, { aggressive: !process.argv.includes('--safe-slim') });
  }

  // 2. Ảnh hệ thống: ảnh lớn nén thành .xz (lúc chạy materializeImages giải nén dạng luồng), phần còn lại giữ nguyên
  const imgRoot = path.join(SRC, 'system-images');
  let compressed = 0;
  if (fs.existsSync(imgRoot)) {
    for (const api of fs.readdirSync(imgRoot)) {
      for (const tag of fs.readdirSync(path.join(imgRoot, api))) {
        for (const abi of fs.readdirSync(path.join(imgRoot, api, tag))) {
          const from = path.join(imgRoot, api, tag, abi);
          const to = path.join(OUT, 'system-images', api, tag, abi);
          fs.mkdirSync(to, { recursive: true });
          for (const f of fs.readdirSync(from)) {
            const src = path.join(from, f);
            if (!fs.statSync(src).isFile()) continue;
            // NOTICE.txt là văn bản giấy phép GMS (~20MB), không cần để chạy
            if (/^NOTICE\.txt$/i.test(f)) continue;
            // userdata.img dùng mẫu ext4 dựng sẵn trong kho (seed):
            // bản trong sys-img chính thức là 1MB toàn số 0, khi emulator mở rộng thì e2fsck chắc chắn trả code=8,
            // phân vùng dừng ở 1MB → guest invalid magic → /data chỉ đọc → cài mới hoàn toàn không bao giờ khởi động được.
            // Mẫu chỉ được tạo một lần lúc build (mke2fs), sau đó đi kèm mã nguồn, CI không cần thêm toolchain.
            if (/^userdata\.img$/i.test(f) && fs.existsSync(SEED_USERDATA)) {
              fs.copyFileSync(SEED_USERDATA, path.join(to, 'userdata.img.gz'));
              console.log('userdata.img dùng mẫu ext4 dựng sẵn (build/seed)');
              compressed += 1;
              continue;
            }
            if (/^(system|vendor|cache|userdata)\.img$/i.test(f) && sizeOf(src) > 32 * 1024 * 1024) {
              // Ảnh lớn được nén một bản, ảnh gốc không vào gói; đã có sản phẩm nén (với kích thước hợp lý) thì bỏ qua nén lặp lại
              const xz = path.join(to, `${f}.xz`);
              const gz = path.join(to, `${f}.gz`);
              // Đường dự phòng gzip tạo ra .gz, cũng phải nhận, nếu không mỗi lần build lại sẽ nén lại 3GB.
              // Ngưỡng dùng >1MB chứ không dùng tỷ lệ nén: vendor.img.gz chỉ ~21MB, userdata.img gần như toàn số 0,
              // dùng ngưỡng lớn cố định hay "tỷ lệ nén" đều sẽ đánh giá nhầm các sản phẩm hợp lệ này là không hợp lệ rồi nén lại.
              const existing = [xz, gz].find((p) => sizeOf(p) > 1024 * 1024);
              if (existing) {
                console.log(`Bỏ qua ${f} (đã có ${path.extname(existing)} ${(sizeOf(existing) / 1048576).toFixed(1)} MB)`);
                compressed += 1;
                continue;
              }
              console.log(`Đang nén ${f} (${(sizeOf(src) / 1073741824).toFixed(2)} GB) → XZ 9e (khá chậm, chỉ một lần)…`);
              // eslint-disable-next-line no-await-in-loop
              await xzFile(src, xz);
              compressed += 1;
            } else {
              fs.copyFileSync(src, path.join(to, f));
            }
          }
        }
      }
    }
  }

  fs.writeFileSync(MARK, new Date().toISOString());
  const gzCount = compressed;
  let total = 0;
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p); else total += sizeOf(p);
    }
  };
  walk(OUT);
  console.log(`Hoàn tất: build/runtime (${(total / 1073741824).toFixed(2)} GB, đã nén ${gzCount} ảnh lớn)`);
}

if (require.main === module) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
// Dành cho kiểm thử hồi quy gọi trực tiếp (không kích hoạt quy trình chuẩn bị cả gói của main)
module.exports = { xzFile, gzipFile, findPython };
