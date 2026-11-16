#!/usr/bin/env node
'use strict';
/**
 * Công tắc dòng lệnh cho liên kết .apk (không cần mở giao diện)
 *   node scripts/assoc.js on   → đăng ký nhấp đúp APK để cài
 *   node scripts/assoc.js off  → hủy liên kết
 */
const path = require('path');
const fs = require('fs');
const { registerAssociation, unregisterAssociation } = require('../src/core/assoc');

const action = process.argv[2] || 'on';
const isDev = !process.env.APKSTART_PACKAGED;
const exe = isDev
  ? path.join(__dirname, '..', 'node_modules', 'electron', 'dist', 'electron.exe')
  : process.execPath;
const appDir = path.join(__dirname, '..');

if (action === 'on') {
  const iconPath = path.join(__dirname, '..', 'build', 'apkstart.ico');
  const r = registerAssociation(exe, fs.existsSync(iconPath) ? iconPath : undefined,
    isDev ? `"${appDir}"` : undefined);
  console.log('Đã đăng ký liên kết .apk:', r.progId);
  console.log('Giờ nhấp đúp tệp .apk trong File Explorer là cài vào ApkStart.');
} else if (action === 'off') {
  unregisterAssociation();
  console.log('Đã hủy liên kết .apk.');
} else {
  console.log('Cách dùng: node scripts/assoc.js [on|off]');
  process.exit(1);
}
