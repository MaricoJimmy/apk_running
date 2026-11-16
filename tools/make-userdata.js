'use strict';
/**
 * Tạo ảnh hạt giống userdata (dùng để gỡ lỗi).
 * Cách dùng: node tools/make-userdata.js <tệp đầu ra> [kích thước MB]
 */
const fs = require('fs');
const { buildEmptyExt4 } = require('../src/core/userdata');

const out = process.argv[2];
if (!out) {
  console.error('Cách dùng: node tools/make-userdata.js <tệp đầu ra> [kích thước MB]');
  process.exit(2);
}
const sizeMB = Number(process.argv[3] || 64);
const img = buildEmptyExt4({ sizeMB });
fs.writeFileSync(out, img);
console.log(`Đã tạo ${out} (${(img.length / 1024 / 1024).toFixed(0)}MB, ext4/4KB block)`);
