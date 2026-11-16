'use strict';
/**
 * Đồng bộ một bản phát hành lên Gitee.
 *
 * Vì sao cần script này: tệp đính kèm bản phát hành trên Gitee giới hạn 100MB mỗi tệp (đo thực tế 104.857.600 byte,
 * tải lên 104.800.000 thì thành công). Gói portable nén bằng 7-Zip khoảng 99,6MB, giờ có thể đặt thẳng
 * một tệp zip hoàn chỉnh, người dùng mở ra là giải nén được — không còn cắt part1/part2 (loại gói đó phải ghép theo thứ tự,
 * người tải thủ công hoàn toàn không dùng được). Chỉ khi thực sự vượt giới hạn mới quay về chia mảnh, updater phía ứng dụng
 * nhận cả hai kiểu.
 * Bản cài đặt Setup (1,4GB) và gói runtime trọn bộ (1,4GB) vượt giới hạn quá nhiều, tiếp tục để trên GitHub —
 * phía ứng dụng xử lý «nguồn nào có tệp đính kèm» theo kiểu hợp, không ảnh hưởng việc cập nhật.
 *
 * Cách dùng:
 *   GITEE_TOKEN=xxxx node tools/publish-gitee.js v0.3.3 D:/dist
 *     v0.3.3   tag cần phát hành (phải là tag đã đẩy lên Gitee)
 *     D:/dist  thư mục chứa ApkStart-v0.3.3-win64-portable.zip (tùy chọn, cũng có thể chỉ định bằng --zip)
 *
 *   node tools/publish-gitee.js v0.3.3 --zip D:/x.zip --notes notes.md
 */
const fs = require('fs');
const path = require('path');

const OWNER = 'daily-miku';
const REPO = 'apkstart';
const API = `https://gitee.com/api/v5/repos/${OWNER}/${REPO}`;
const HARD_LIMIT = 100 * 1024 * 1024;  // Giới hạn mỗi tệp đính kèm của Gitee (100MiB, đã đo thực tế dùng được)
const PART_LIMIT = 99 * 1024 * 1024;   // Kích thước mỗi mảnh khi thực sự phải chia, chừa 1MB cho header multipart

function arg(name, def = '') {
  const i = process.argv.indexOf(name);
  return i > 0 ? process.argv[i + 1] : def;
}

async function api(method, p, body) {
  const token = process.env.GITEE_TOKEN;
  if (!token) throw new Error('Thiếu biến môi trường GITEE_TOKEN');
  const url = `${API}${p}${p.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`;
  const res = await fetch(url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* có thể là phản hồi rỗng */ }
  if (!res.ok) throw new Error(`${method} ${p} → ${res.status} ${text.slice(0, 300)}`);
  return json || {};
}

/** Chia nhỏ tệp lớn; trả về mảng đường dẫn sau khi chia */
function splitFile(file, limit) {
  const size = fs.statSync(file).size;
  if (size <= limit) return [];
  const fd = fs.openSync(file, 'r');
  const out = [];
  try {
    let index = 1;
    let offset = 0;
    while (offset < size) {
      const len = Math.min(limit, size - offset);
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, offset);
      const p = `${file}.part${index}`;
      fs.writeFileSync(p, buf);
      out.push(p);
      offset += len;
      index += 1;
    }
  } finally {
    fs.closeSync(fd);
  }
  return out;
}

/**
 * Tải lên một tệp đính kèm.
 * Gói trọn bộ 95MB được gửi hết trong một lần POST (Gitee không có API tải lên theo mảnh), trên đường truyền trong nước rất dễ
 * fetch failed giữa chừng — trước đây không có thử lại, chập chờn một lần là phải chạy lại cả lệnh,
 * mà chạy lại còn phải xóa sạch tệp đính kèm cũ trước, rất phiền. Nên ở đây có 3 lần thử lại + thời gian chờ tăng dần.
 */
async function upload(releaseId, file, attempts = 3) {
  const token = process.env.GITEE_TOKEN;
  const name = path.basename(file);
  const buf = fs.readFileSync(file);
  let lastErr = null;
  for (let i = 1; i <= attempts; i += 1) {
    try {
      const fd = new FormData();
      fd.append('access_token', token);
      fd.append('file', new Blob([buf]), name);
      // eslint-disable-next-line no-await-in-loop
      const res = await fetch(`${API}/releases/${releaseId}/attach_files`, { method: 'POST', body: fd });
      // eslint-disable-next-line no-await-in-loop
      const text = await res.text();
      if (res.ok) return JSON.parse(text);
      // 4xx (trừ 429) không đáng thử lại: token hết hạn, trùng tên tệp… gửi lại cũng vô ích
      if (res.status >= 400 && res.status < 500 && res.status !== 429) {
        throw new Error(`Tải lên ${name} thất bại: ${res.status} ${text.slice(0, 200)}`);
      }
      lastErr = new Error(`${res.status} ${text.slice(0, 120)}`);
    } catch (e) {
      lastErr = e;
      if (/^Tải lên .* thất bại/.test(e.message)) throw e;
    }
    if (i < attempts) {
      const wait = i * 8;
      console.warn(`   Lần tải lên thứ ${i} thất bại (${lastErr.message}), thử lại sau ${wait} giây…`);
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => setTimeout(r, wait * 1000));
    }
  }
  throw new Error(`Tải lên ${name} thất bại (đã thử ${attempts} lần): ${lastErr && lastErr.message}`);
}

(async () => {
  const tag = process.argv[2];
  if (!tag || !/^v\d/.test(tag)) {
    console.error('Cách dùng: GITEE_TOKEN=xxx node tools/publish-gitee.js v0.3.3 [--zip đường_dẫn] [--notes tệp]');
    process.exit(1);
  }
  const dir = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : '';
  let zip = arg('--zip', '');
  if (!zip && dir) {
    const hit = fs.existsSync(dir)
      ? fs.readdirSync(dir).find((n) => /portable\.zip$/i.test(n))
      : '';
    if (hit) zip = path.join(dir, hit);
  }
  if (!zip || !fs.existsSync(zip)) {
    console.error(`Không tìm thấy gói portable: ${zip || '(chưa chỉ định)'}. Dùng --zip để chỉ định, hoặc đặt zip vào ${dir}`);
    process.exit(1);
  }
  const notesFile = arg('--notes', '');
  const body = notesFile && fs.existsSync(notesFile)
    ? fs.readFileSync(notesFile, 'utf8')
    : `Gói cài đặt bản portable (một tệp zip, giải nén là dùng; trong ứng dụng cũng tự cập nhật được). Bản cài đặt đầy đủ và gói runtime trọn bộ có trên GitHub Releases.`;

  console.log('1) Tìm/tạo bản phát hành', tag);
  const list = await api('GET', `/releases?per_page=50`);
  let rel = (Array.isArray(list) ? list : []).find((r) => r.tag_name === tag);
  if (!rel) {
    rel = await api('POST', '/releases', {
      tag_name: tag,
      name: tag,
      target_commitish: 'main',
      body,
    });
    console.log('   Đã tạo id =', rel.id);
  } else {
    console.log('   Đã tồn tại id =', rel.id);
  }

  // Khi phát hành lại cùng một phiên bản (sửa mã rồi đóng gói lại), phải xóa tệp đính kèm cũ trước, nếu không trang sẽ treo cùng lúc
  // hai bộ part1/part2 mới và cũ, client lấy theo tên trúng bản nào hoàn toàn nhờ may rủi.
  if (process.argv.includes('--replace')) {
    console.log('2) Dọn tệp đính kèm cũ cùng tên');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    const olds = (Array.isArray(list) ? list : []).filter((a) => /^ApkStart-.*\.zip(\.part\d+)?$/i.test(a.name || ''));
    for (const a of olds) {
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   Xóa', a.name);
    }
  }

  const zipSize = fs.statSync(zip).size;
  if (zipSize > HARD_LIMIT) {
    console.warn(`⚠️  Gói portable ${(zipSize / 1048576).toFixed(1)} MB vượt giới hạn mỗi tệp của Gitee, chỉ có thể chia mảnh; `
      + 'người tải thủ công phải ghép theo thứ tự mới giải nén được, nên nén chặt bằng `node build/zip.js` trước, hoặc giảm dung lượng gói.');
  }
  console.log('3) Chuẩn bị tải lên (ưu tiên gói trọn, vượt giới hạn mới chia)');
  const parts = splitFile(zip, PART_LIMIT);
  const files = parts.length ? parts : [zip];

  // Cùng một phiên bản có thể đã đổi cách đóng gói (gói trọn ↔ chia mảnh): xóa tệp đính kèm cùng tên ở dạng còn lại,
  // nếu không bản phát hành sẽ treo cùng lúc `x.zip` và `x.zip.part1/part2`, client lấy cái nào hoàn toàn nhờ may rủi.
  // --replace sẽ dọn cả các số phiên bản khác, ở đây chỉ dọn dạng còn lại của «tên gói hiện tại».
  {
    const base = path.basename(zip).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const other = parts.length ? new RegExp(`^${base}$`, 'i') : new RegExp(`^${base}\\.part\\d+$`, 'i');
    const list = await api('GET', `/releases/${rel.id}/attach_files`);
    for (const a of Array.isArray(list) ? list : []) {
      if (!other.test(a.name || '')) continue;
      // eslint-disable-next-line no-await-in-loop
      await api('DELETE', `/releases/${rel.id}/attach_files/${a.id}`);
      console.log('   Xóa tệp đính kèm cũ theo kiểu đóng gói trước', a.name);
    }
  }

  for (const f of files) {
    console.log(`   Tải lên ${path.basename(f)} (${(fs.statSync(f).size / 1048576).toFixed(1)} MB)`);
    // eslint-disable-next-line no-await-in-loop
    await upload(rel.id, f);
  }
  for (const p of parts) fs.rmSync(p, { force: true });
  console.log(`\nHoàn tất: https://gitee.com/${OWNER}/${REPO}/releases/tag/${tag}`);
})().catch((e) => {
  console.error('Thất bại:', e.message);
  process.exit(1);
});
