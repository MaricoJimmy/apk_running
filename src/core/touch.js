'use strict';
/**
 * Kênh gửi chạm đa điểm vào Android qua gRPC của Android Emulator (cờ `-grpc <port>`, xem emulator.js).
 *
 * `adb shell input` mỗi lần một tiến trình, chậm vài trăm ms và không hỗ trợ đa điểm — không dùng được cho game.
 * gRPC của emulator nhận TouchEvent nhiều ngón (theo identifier). Có `streamInputEvent` (luồng một chiều,
 * bản emulator mới) thì dùng luồng để mỗi sự kiện không phải chờ một vòng request/response; không có thì
 * quay về `sendTouch` (unary).
 */
const path = require('path');
const grpc = require('@grpc/grpc-js');
const protoLoader = require('@grpc/proto-loader');

const PROTO = path.join(__dirname, 'proto', 'emulator_controller.proto');
let cachedService = null;

function loadService(protoPath) {
  if (!protoPath && cachedService) return cachedService;
  const def = protoLoader.loadSync(protoPath || PROTO, {
    keepCase: true, longs: Number, enums: String, defaults: true, oneofs: true,
  });
  const pkg = grpc.loadPackageDefinition(def);
  const svc = pkg.android.emulation.control.EmulatorController;
  if (!protoPath) cachedService = svc;
  return svc;
}

class TouchChannel {
  constructor({ port, protoPath } = {}) {
    this.port = port;
    const Svc = loadService(protoPath);
    this.client = new Svc(`127.0.0.1:${port}`, grpc.credentials.createInsecure(), {
      'grpc.max_reconnect_backoff_ms': 2000,
    });
    this.hasStream = typeof this.client.streamInputEvent === 'function';
    this.stream = null;
    this.closed = false;
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.client.waitForReady(Date.now() + 3000, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** [{id,x,y,up?}] (pixel Android) -> TouchEvent của proto */
  toTouchEvent(touches) {
    return {
      touches: touches.map((t) => ({
        x: Math.round(t.x),
        y: Math.round(t.y),
        identifier: t.id,
        pressure: t.up ? 0 : 1,
        // Giữ ngón lâu (giữ W chạy) không được tự hết hạn
        expiration: 'NEVER_EXPIRE',
      })),
      display: 0,
    };
  }

  /** Gửi một nhóm chạm, không chờ phản hồi; lỗi chỉ làm rơi sự kiện này (lần sau tự mở lại luồng) */
  send(touches) {
    if (this.closed || !touches || !touches.length) return;
    const ev = this.toTouchEvent(touches);
    if (this.hasStream) {
      if (!this.stream) {
        this.stream = this.client.streamInputEvent((err) => { if (err) this.stream = null; });
        this.stream.on('error', () => { this.stream = null; });
      }
      try { this.stream.write({ touch_event: ev }); } catch (_) { this.stream = null; }
      return;
    }
    this.client.sendTouch(ev, () => {});
  }

  close() {
    this.closed = true;
    try { if (this.stream) this.stream.end(); } catch (_) { /* ignore */ }
    this.stream = null;
    try { this.client.close(); } catch (_) { /* ignore */ }
  }
}

module.exports = { TouchChannel };
