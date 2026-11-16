'use strict';
/**
 * Spike kênh chạm map phím: nối gRPC emulator đang chạy, vẽ chạm 2 ngón, đo độ trễ.
 * Chạy: node tools/check-touch.js [cổng gRPC, mặc định 8554] [rộng] [cao]
 * Bật "Hiển thị vị trí chạm" trong Tùy chọn nhà phát triển Android để nhìn thấy ngón tay.
 */
const { TouchChannel } = require('../src/core/touch');

const port = Number(process.argv[2] || 8554);
const W = Number(process.argv[3] || 1280);
const H = Number(process.argv[4] || 720);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const ch = new TouchChannel({ port });
  await ch.connect();
  console.log(`Đã nối gRPC 127.0.0.1:${port} (luồng streamInputEvent: ${ch.hasStream ? 'có' : 'không'})`);

  // 2 ngón: ngón 1 kéo sang trái, ngón 2 kéo sang phải
  const cx = W / 2; const cy = H / 2;
  ch.send([{ id: 1, x: cx - 50, y: cy }, { id: 2, x: cx + 50, y: cy }]);
  for (let i = 1; i <= 20; i += 1) {
    ch.send([{ id: 1, x: cx - 50 - i * 10, y: cy }, { id: 2, x: cx + 50 + i * 10, y: cy }]);
    // eslint-disable-next-line no-await-in-loop
    await sleep(16);
  }
  ch.send([{ id: 1, x: cx - 250, y: cy, up: true }, { id: 2, x: cx + 250, y: cy, up: true }]);

  // Độ trễ: đo vòng request/response của sendTouch (unary) — chặn trên cho độ trễ một sự kiện qua luồng
  const times = [];
  for (let i = 0; i < 200; i += 1) {
    const t0 = process.hrtime.bigint();
    // eslint-disable-next-line no-await-in-loop
    await new Promise((res, rej) => ch.client.sendTouch(
      ch.toTouchEvent([{ id: 9, x: 5, y: 5, up: true }]), (e) => (e ? rej(e) : res()),
    ));
    times.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  times.sort((a, b) => a - b);
  const median = times[100]; const p95 = times[190];
  console.log(`sendTouch: median ${median.toFixed(2)} ms, p95 ${p95.toFixed(2)} ms`);
  console.log(p95 <= 30 ? 'ĐẠT (p95 <= 30 ms)' : 'KHÔNG ĐẠT (p95 > 30 ms)');
  ch.close();
  process.exit(p95 <= 30 ? 0 : 2);
})().catch((e) => { console.error('Lỗi:', e.message); process.exit(1); });
