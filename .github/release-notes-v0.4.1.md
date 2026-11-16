# ApkStart v0.4.1

> Tóm lại: đã xác định và trị tận gốc nhóm triệu chứng "viền đen khi xoay / ứng dụng không phủ kín / bấm không ăn / không bấm được nút đồng ý" — thực ra chúng có **cùng một nguyên nhân**: cửa sổ trình giả lập được nhúng và lớp web của Electron là cửa sổ anh em, và lớp web luôn nằm trên cùng.

## I. Nguyên nhân gốc thực sự

Dùng `WindowFromPoint` kiểm tra va chạm ở tâm hình ảnh, phát hiện kết quả trả về **không phải cửa sổ trình giả lập**, mà là `Chrome_RenderWidgetHostHWND` (lớp kết xuất web của Electron).

Nghĩa là: khối nền đen của lớp web luôn phủ lên trên hình ảnh Android, và ăn hết sự kiện chuột. Thế là đồng thời xuất hiện:

| Người dùng thấy | Nguyên nhân thực tế |
|---|---|
| Hình có viền đen / không phủ kín | Nền đen của lớp web che hình ảnh được nhúng, hoặc chỉ để lộ một phần |
| Bấm không ăn, không khớp vị trí | Chuột bấm vào lớp web, hoàn toàn không vào Android |
| Không bấm được "Đồng ý và tiếp tục" | Như trên (`adb input tap` bấm được vì dùng tọa độ logic, bỏ qua cửa sổ chủ) |
| Sau khi xoay / toàn màn hình càng rõ | Đổi kích thước cửa sổ kích hoạt Chromium vẽ lại, lại tự đưa mình lên trên cùng |

Trước đó ở v0.3.9 tôi dùng `SetWindowRgn` cắt xén định đẩy dải 8px ở thanh tiêu đề ra khỏi hình, ngược lại **phá hỏng kiểm tra va chạm của cửa sổ con Qt/GL**, và khiến region sau khi resize không khớp với kích thước cửa sổ — đây chính là nguồn gốc trực tiếp của các vấn đề trong bản này.

## II. Cách sửa

1. **Bỏ cắt xén `SetWindowRgn`**, chuyển sang chủ động xóa region có thể còn sót từ bản cũ khi `Embed()`. Phần tràn ở thanh tiêu đề được thanh tiêu đề tự vẽ của cửa sổ chủ che tự nhiên.
2. **Gắn cửa sổ trình giả lập làm cửa sổ con của lớp kết xuất web** (thay vì cửa sổ con anh em của cửa sổ chủ). Thứ tự Z và kiểm tra va chạm chuột của cửa sổ con vốn được ưu tiên hơn cửa sổ cha, lớp web không bao giờ che hình ảnh, ăn mất cú bấm nữa.
   - Lúc embed, lớp web có thể chưa được tạo xong, nên trong `Fit()` và vòng quét thường trú đều có gắn bổ sung, bảo đảm chắc chắn có hiệu lực.
3. **Thu hẹp `HideStrayWindows`**: chỉ ẩn các lớp hộp thoại rõ ràng (cửa sổ công cụ Qt / console), tuyệt đối không đụng `QWindowIcon` / `subWin` (đó là LCD đang hiển thị), tránh ẩn nhầm hình ảnh thành đen hoàn toàn.
4. **Khởi động xong thì đưa cửa sổ lên trên cùng** (topmost tạm thời rồi gỡ): tránh cửa sổ khác (trình duyệt v.v.) đè lên gây "đen màn hình + không bấm được".
5. **Kích thước cửa sổ khi xoay**:
   - Ở trạng thái phóng to, `setContentSize` không có tác dụng, nay `unmaximize` trước rồi mới đổi kích thước, nếu không hình ngang bị nhét vào cửa sổ dọc = viền đen / không phủ kín;
   - Kích thước mục tiêu được giới hạn trong vùng khả dụng của màn hình;
   - Sau khi `wm size` thay đổi Qt sẽ sắp xếp lại nhiều lần, chuyển sang `Fit` liên tiếp 6 vòng để hội tụ, loại bỏ hoàn toàn viền đen còn sót.

## III. Đo thực tế (lần này là tương tác thật đầu cuối, không phải mô phỏng bằng adb)

- Dùng **chuột thật** bấm "Đồng ý và tiếp tục" → vào `MainFragmentActivity` → tiếp tục bấm vào trang phát `ShortSeriesActivity`;
- `PrintWindow` chụp cửa sổ chủ: hình ảnh Android **phủ kín toàn bộ vùng dưới thanh tiêu đề, xung quanh không có viền đen, không có khoảng trắng**, video / thích / bình luận / chọn tập / bốn nút thanh tiêu đề đều hoạt động bình thường;
- `WindowFromPoint` ở tâm hình ảnh trả về cửa sổ trình giả lập (trước khi sửa trả về lớp web);
- `npm test`: **115 mục đều đạt** (8 + 25 + 82), thêm hai kiểm thử hồi quy chốt chặt "cửa sổ nhúng phải gắn dưới lớp web và không được đặt region".

## IV. Gia cố kỹ thuật

- `agent.ps1` giữ UTF-8 BOM (mất BOM sẽ khiến PowerShell 5.1 đọc chú thích tiếng Trung theo ANSI, `Add-Type` biên dịch thất bại → proxy cửa sổ khởi động thất bại);
- Thêm kiểm thử hồi quy: xác minh `SetParent(emu, parent)` / `FindChromeRender` tồn tại, `CreateRectRgn(0, clipTop)` không tồn tại, khi embed có xóa region.

## V. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
