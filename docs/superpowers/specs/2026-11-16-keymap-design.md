# Thiết kế: Map phím tùy chỉnh + xoay camera bằng chuột

Ngày: 2026-11-16 · Trạng thái: đã duyệt

## Mục đích và lý do

Người dùng muốn chơi các game 3D trên điện thoại (kiểu điều khiển chuẩn lấy theo **PUBG Mobile** — các game 3D khác đều học theo bố cục này; người dùng không chơi PUBG) trong ApkStart bằng bàn phím + chuột như game PC, thay vì bấm chuột lên nút cảm ứng. Hiện ApkStart chỉ có ánh xạ chuột cơ bản (chuột trái = chạm, chuột phải = Quay lại, con lăn = vuốt — `src/core/pointer.js`), không đủ cho game hành động.

**Thành công (do người dùng đặt ra):** trong một game 3D có joystick + vùng xoay camera kiểu PUBG, **WASD chạy đúng hướng** (kể cả chéo) và **xoay camera bằng chuột mượt**.

## Mục tiêu

1. **Joystick 360° (WASD):** một vòng tròn đặt lên joystick ảo của game. Giữ W/A/S/D → giữ một "ngón tay" ở tâm vòng và kéo về hướng tương ứng; tổ hợp hai phím (W+D…) → hướng chéo; nhả hết → nhấc ngón.
2. **Phím tự do:** đặt một ô lên bất kỳ vị trí nào trên màn hình game, gán một phím bàn phím (hoặc nút chuột). Nhấn = chạm xuống, giữ = giữ ngón, nhả = nhấc ngón.
3. **Đa điểm:** nhiều phím/ngón hoạt động cùng lúc (chạy + nhảy + nạp đạn + xoay camera).
4. **Chế độ ngắm (khóa chuột):**
   - Con trỏ bị ẩn và khóa trong cửa sổ game.
   - Di chuột → một ngón ảo trong **vùng camera** (hình chữ nhật người dùng đặt) kéo theo hướng chuột, có **độ nhạy** chỉnh được.
   - Khi ngón chạm mép vùng camera thì tự nhấc lên và đặt lại giữa vùng, để xoay vô hạn không bị kẹt.
   - Chuột trái / chuột phải có thể gán như phím (ví dụ trái = Bắn, phải = Ngắm).
5. **Khóa / nhả chuột (người dùng đã duyệt):**
   - **Lúc mở game:** chuột **chưa khóa** (để bấm qua màn tải, sảnh chờ). Phím **`** (dấu huyền) = bắt đầu khóa; đồng thời là phím chuyển khóa/nhả bất cứ lúc nào.
   - **Phím bật/tắt "nhả chuột khi bật"** (tùy chọn cho từng phím, ví dụ **Tab** túi đồ): bấm lần 1 → chạm nút trong game + nhả chuột; bấm lần 2 → chạm nút + khóa lại.
   - **Esc** (cố định, cùng kiểu bật/tắt): lần 1 → gửi nút Quay lại Android (mở menu) + nhả chuột; lần 2 → gửi Quay lại (đóng menu) + khóa lại.
   - **Khi đang nhả:** click chuột = chạm bình thường (loot, bấm menu), **không** tự khóa lại. WASD và các phím khác **vẫn hoạt động**.
   - Lệch trạng thái (ví dụ đóng túi bằng nút X trong game) → bấm **`** để khóa lại.
   - **F12** (đổi được): tắt hẳn toàn bộ map phím, mọi phím đi thẳng vào game để chat; bấm lại để bật.
   - Mất focus / Alt+Tab / thu nhỏ / đóng cửa sổ → luôn nhả chuột ngay.
6. **Màn hình chỉnh (kiểu A — người dùng đã chọn):**
   - Nút hình bàn phím trên thanh tiêu đề cửa sổ app (`src/ui/shell.html`, cạnh nút Xoay).
   - Bấm vào → game mờ đi, hiện thanh công cụ trên cùng: **+ Phím**, **+ Joystick**, **+ Vùng camera**, **+ Nút bắn (chuột trái)**, **Độ nhạy chuột**, **Lưu**.
   - Kéo thả ô lên đúng nút trong game, bấm phím trên bàn phím để gán. Chuột phải lên ô = xóa.
   - Mockup tham chiếu: `.superpowers/brainstorm/*/content/keymap-editor.html` (phương án A).
7. **Khi chơi:** tên phím hiện mờ trên vị trí đã gán; có công tắc bật/tắt hiển thị này.
8. **Bố cục mẫu kiểu PUBG** *(quyết định của Claude)*: bộ phím mới cho một game có thể bắt đầu từ mẫu — joystick WASD góc dưới trái, vùng camera nửa phải, chuột trái = bắn, Space nhảy, C ngồi, Z nằm, R nạp đạn, F nhặt, Tab túi đồ (nhả chuột), M bản đồ, 1/2 đổi súng — đặt ở vị trí phổ biến; người dùng kéo cho khớp game của mình.
9. **Mỗi game một bộ phím**, lưu theo tên gói (package), tự nạp khi mở game đó.

## Không làm (lần này)

- Bộ phím chính xác dựng sẵn cho từng game cụ thể.
- Xuất/nhập file bộ phím, chia sẻ bộ phím *(Claude quyết: để sau)*.
- Macro, phím lặp tự động (auto-fire), bất cứ thứ gì giống công cụ gian lận.
- Tay cầm (gamepad).
- Nhiều bộ phím cho cùng một game.

## Phản mục tiêu (dù chạy được vẫn coi là hỏng)

- Map phím vẫn chặn bàn phím/chuột khi cửa sổ game **không** ở tiền cảnh, hoặc làm chậm desktop.
- Con trỏ bị kẹt khóa không thoát được (Esc, mất focus, Alt+Tab, đóng cửa sổ đều phải nhả chuột ngay).
- Phím gõ vào ô chat của game bị nuốt mất khi đã tắt map phím.
- Độ trễ đủ lớn để thấy rõ "ngón tay chạy sau chuột" — xoay camera phải mượt.

## Ràng buộc và hiện trạng

- **Cấu trúc cửa sổ:** cửa sổ app là Electron, thanh tiêu đề HTML 38px; phần hình bên dưới là **cửa sổ Qt của Android Emulator được nhúng bằng `SetParent`** (`src/core/appwin.js`). HTML trong Electron **không vẽ đè lên được** cửa sổ con native này → lớp chỉnh sửa và lớp hiển thị tên phím phải là một cửa sổ riêng trong suốt, đặt khớp trên vùng hình (hoặc giải pháp tương đương).
- **Bắt input:** `src/core/win/agent.ps1` (C# nhúng, chạy qua PowerShell, giao tiếp với `src/core/agent.js` bằng JSON qua cổng TCP) đã có hook chuột `WH_MOUSE_LL` chỉ cài khi cửa sổ app ở tiền cảnh. Cần mở rộng cùng cơ chế cho bàn phím (`WH_KEYBOARD_LL`) và chuyển động chuột tương đối cho chế độ ngắm (ẩn/khóa con trỏ, ví dụ `ClipCursor` + Raw Input). `agent.ps1` phải giữ UTF-8 BOM (test kiểm tra).
- **Gửi chạm:** `adb shell input` (mỗi lần một tiến trình) **quá chậm** và không hỗ trợ đa điểm. Cần một kênh liên tục, đa điểm, độ trễ thấp. Ứng viên chính: **gRPC của Android Emulator** (cờ `-grpc <port>`, `EmulatorController.sendTouch` hỗ trợ nhiều ngón theo `identifier`). Chưa kiểm chứng trên bản emulator mà runtime đang đóng gói → **việc đầu tiên là spike xác nhận** (bật gRPC, gửi một touch đa điểm, đo độ trễ). Phương án dự phòng: một `adb shell` giữ mở liên tục ghi `sendevent` vào thiết bị cảm ứng đa điểm của emulator.
- **Tọa độ:** vị trí phím lưu theo **tỉ lệ (0–1) của màn hình Android**, để không lệch khi đổi kích thước cửa sổ; phải tính đúng khi xoay ngang/dọc (`src/core/display.js`, lề `EMU_PAD` trong `appwin.js`).
- **Cài đặt:** lưu qua `src/core/store.js` như các cài đặt khác.
- **Ngôn ngữ:** giao diện tiếng Việt (dự án đã Việt hóa).
- **Rủi ro cần biết:** game online 3D thường có chống gian lận / phát hiện giả lập, hoặc chạy chậm qua lớp dịch ARM. Map phím không giải quyết việc này; kiểm thử trên game 3D nào vào được.

## Quyết định của Claude (người dùng chưa xác nhận từng điểm)

- Lưu tọa độ theo tỉ lệ màn hình Android.
- gRPC emulator là kênh gửi chạm ưu tiên, `sendevent` (adb shell giữ mở) là dự phòng.
- **Ngưỡng spike:** từ lúc chuột di chuyển tới lúc chạm được gửi vào Android **≤ ~30 ms** với luồng sự kiện đều (đo trên máy dev). Nếu cả gRPC lẫn `sendevent` đều không đạt → **dừng, báo người dùng** trước khi làm phần camera (không tự ý giảm phạm vi).
- **Hướng màn hình:** bộ phím lưu kèm hướng (ngang/dọc) lúc tạo. Mở game mà hướng hiện tại không khớp → tạm tắt map phím và hiện thông báo; **không** tự xoay/khởi động lại máy ảo.

## Để lại cho người làm

- Cách cụ thể dựng lớp phủ trong suốt (cửa sổ Electron trong suốt luôn trên cửa sổ app, hay cách khác) và đồng bộ vị trí khi di chuyển/đổi cỡ/xoay.
- Thuật toán chi tiết của joystick (bán kính kéo, có làm mượt hay không) và của camera (cách đặt lại ngón khi chạm mép, ngưỡng).
- Cấu trúc dữ liệu bộ phím trong store.
- Cách test: phần tính toán thuần (joystick, camera, quy đổi tọa độ) nên tách module không phụ thuộc Electron như `pointer.js` để unit test, thêm vào `test/auto-test.js`.
