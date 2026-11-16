'use strict';
/**
 * Tự kiểm tra hai nguồn: một lệnh xem rõ «phiên bản mới nhất của từng nguồn» và «tốc độ đo thực tế của từng địa chỉ tải».
 *
 *   node tools/check-sources.js            # kiểm tra gói cập nhật
 *   node tools/check-sources.js runtime    # kiểm tra gói runtime trọn bộ
 *
 * Sẽ tải thật 256KB nên tốn một chút dung lượng mạng; mục đích là trước khi sửa mã, xác nhận trước
 * «máy này hiện tại nên dùng nguồn nào».
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'apk-sources-'));
process.env.APPDATA = TMP;

const { Sources } = require('../src/core/sources');
const store = require('../src/core/store');
const { Provisioner } = require('../src/core/provision');

const mb = (n) => (n / 1048576).toFixed(2);
const host = (u) => { try { return new URL(u).host; } catch (_) { return u.slice(0, 40); } };

(async () => {
  const which = (process.argv[2] || 'update').toLowerCase();
  const sources = new Sources(() => store.getSettings());

  console.log('=== 1) Thông tin phát hành của hai nguồn ===');
  const rels = await sources.fetchReleases();
  for (const r of rels) {
    if (r.rel) {
      const assets = (r.rel.assets || []).length;
      console.log(`  ${r.name.padEnd(7)} ${String(r.rel.tag_name || r.rel.name || '').padEnd(10)} ${assets} tệp đính kèm`);
    } else {
      console.log(`  ${r.name.padEnd(7)} không truy cập được: ${r.error}`);
    }
  }

  console.log('\n=== 2) Kết quả hợp nhất ===');
  const merged = await sources.latest();
  console.log(`  Phiên bản cao nhất ${merged.tag} (${merged.assets.length} tệp đính kèm)`);
  for (const a of merged.assets) {
    console.log(`    · ${a.name}  ${(a.size / 1048576).toFixed(0)}MB  [${a.source}]`);
  }

  console.log('\n=== 3) Đo tốc độ thực tế của từng địa chỉ tải ===');
  let target = null;
  if (which === 'runtime') {
    const p = new Provisioner(path.resolve(__dirname, '..'));
    const pack = await p.resolveRuntimePack().catch((e) => { console.log('  Phân giải thất bại:', e.message); return null; });
    if (pack) {
      console.log(`  Gói runtime trọn bộ ${pack.name} (${pack.tag} · ${pack.from || '?'})`);
      target = pack.url;
    }
  } else {
    const pick = merged.assets.find((a) => /portable.*\.zip$/i.test(a.name)) || merged.assets[0];
    if (pick) {
      console.log(`  Gói cập nhật ${pick.name}`);
      target = pick.url;
    }
  }
  if (!target) {
    console.log('  Không có tệp đính kèm nào để đo');
  } else {
    const cands = sources.candidates(target);
    for (const c of cands) console.log(`  ${host(c).padEnd(22)} ${c === target ? '(trực tiếp)' : '(mirror)'}`);
    const t0 = Date.now();
    const ranked = await sources.rank(cands, { onProgress: (p) => console.log('  ·', p.message) });
    console.log(`  Đo tốc độ mất ${Date.now() - t0}ms, thứ tự cuối cùng:`);
    ranked.forEach((u, i) => {
      const c = sources._rankCache.get(u) || {};
      console.log(`    ${i + 1}. ${host(u).padEnd(22)} ${c.ok ? `${mb(c.speed)} MB/s` : 'không dùng được'}`);
    });
  }

  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) { /* ignore */ }
})().catch((e) => {
  console.error('Thất bại:', e.message);
  process.exit(1);
});
