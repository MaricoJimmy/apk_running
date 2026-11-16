'use strict';
/**
 * So sánh số phiên bản. Tách thành module riêng, tránh updater ↔ sources require lẫn nhau tạo phụ thuộc vòng.
 */

/** Chuẩn hóa v0.3.2 / 0.3.2-preview / 1.0.0+build thành mảng có thể so sánh */
function parseVer(v) {
  return String(v || '')
    .replace(/^v/i, '')
    .split(/[.+-]/)
    .map((x) => (/^\d+$/.test(x) ? Number(x) : x))
    .filter((x) => x !== '');
}

/** a>b trả 1, a<b trả -1, bằng nhau 0 */
function cmpVer(a, b) {
  const A = parseVer(a);
  const B = parseVer(b);
  const n = Math.max(A.length, B.length);
  for (let i = 0; i < n; i += 1) {
    const x = A[i];
    const y = B[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x < y ? -1 : 1;
    } else {
      const sx = String(x);
      const sy = String(y);
      if (sx !== sy) return sx < sy ? -1 : 1;
    }
  }
  return 0;
}

module.exports = { parseVer, cmpVer };
