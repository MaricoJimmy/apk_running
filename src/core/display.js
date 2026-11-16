'use strict';
/**
 * Phần tính toán thuần của điều chỉnh hiển thị (unit test được, không phụ thuộc Electron / adb).
 *  - Toàn màn hình: độ phân giải Android căn theo vùng làm việc của màn hình, nội dung tự lấp đầy;
 *  - Cửa sổ: giữ preset màn hình dọc, khi người dùng kéo cửa sổ thì Qt tự co giãn, kích thước lưu trong metadata của app.
 */
function densityFor(w, h, manual) {
  if (manual > 0) return Math.max(120, Math.min(640, Math.round(manual)));
  return Math.max(200, Math.min(480, Math.round(Math.min(w, h) / 2.57)));
}

function portraitSize(str) {
  const m = /^(\d{3,4})x(\d{3,4})$/i.exec(String(str || ''));
  if (!m) return { w: 900, h: 1600 };
  const w = Number(m[1]);
  const h = Number(m[2]);
  return (h > w && w >= 320 && h >= 480) ? { w, h } : { w: 900, h: 1600 };
}

function defaultBounds(area) {
  const h = Math.round((area.h || 1080) * 0.84);
  const w = Math.round(h * 9 / 16);
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round((area.y || 0) + ((area.h || 1080) - h) / 2),
    w, h,
  };
}

/**
 * Toàn màn hình = lấp đầy chiều cao màn hình và căn giữa theo chiều ngang.
 * Tỉ lệ khung của cửa sổ emulator bị LCD khóa cứng lúc khởi động (9:16), SW_MAXIMIZE thẳng chỉ được
 * một cửa sổ dính bên trái, chiều rộng không đổi; tính chiều cao theo tỉ lệ để lấp đầy rồi căn giữa, về thị giác chính là
 *「app chiếm trọn màn hình」, và hình không bị méo.
 */
function fullscreenBounds(portrait, area) {
  const p = portraitSize(portrait);
  const ratio = p.w / p.h;
  const h = Math.max(320, Math.round(area.h || 1080));
  const w = Math.max(240, Math.round(h * ratio));
  return {
    x: Math.round((area.x || 0) + ((area.w || 1920) - w) / 2),
    y: Math.round(area.y || 0),
    w, h,
  };
}

/**
 * Độ phân giải phía Android: cả hai chế độ đều giữ preset màn hình dọc.
 * Lý do: tỉ lệ khung của cửa sổ emulator đã bị kích thước LCD khóa cứng lúc khởi động (thực tế đổi thành 1920x1080 rồi
 * cửa sổ vẫn chỉ nhận 9:16, hình bị nhét vào sẽ có viền đen hoặc bị méo). Vì vậy「toàn màn hình」= phóng to
 * cửa sổ lấp đầy màn hình,「cửa sổ」= màn hình dọc kéo giãn tự do, cả hai dùng chung một độ phân giải Android,
 * khi chuyển đổi không cần khởi động lại runtime, cũng không làm app bố cục lại.
 */
function sizeFor(mode, portrait, area) {
  return portraitSize(portrait);
}

module.exports = { densityFor, portraitSize, defaultBounds, fullscreenBounds, sizeFor };
