# ApkStart v0.3.7

> Tóm lại: sửa **nút đóng ở góc trên bên phải cửa sổ ứng dụng (đóng là phải thực sự kết thúc ứng dụng Android)**, và chuyển **mạng máy ảo** từ "trông vào may rủi" sang "tự phục hồi"; token đồng bộ Gitee cho CI cũng đã cấu hình xong.

## I. Sửa: nút cửa sổ góc trên bên phải, đóng giờ sẽ thực sự kết thúc ứng dụng

**Vấn đề**: bấm ⨯ trên thanh tiêu đề, cửa sổ biến mất nhưng ứng dụng Android vẫn chạy nền; mở lại ứng dụng đó thì trông như "chưa từng đóng".

**Nguyên nhân**: `shell:close` gọi thẳng `win.close()` của Electron, bỏ qua logic dọn dẹp của `AppWindow.close()`. Sự kiện `closed` của cửa sổ chỉ xóa trạng thái nội bộ, **vừa không `force-stop` ứng dụng Android, vừa không tháo cửa sổ trình giả lập khỏi cửa sổ chủ**. Đóng bằng Alt+F4 / thanh tác vụ cũng vậy.

**Cách sửa**:

- Nút ⨯ chuyển sang đi qua `appWin.close()`: trước tiên tháo cửa sổ trình giả lập ra và ẩn đi, rồi `am force-stop` dừng ứng dụng Android;
- Sự kiện `closed` cũng được bổ sung phần dọn dẹp tương tự (bao phủ các đường Alt+F4, đóng từ thanh tác vụ, tắt máy v.v.);
- Logic xoay / thu nhỏ / phóng to giữ nguyên, không thay đổi.

**Đo thực tế**: sau khi gửi `WM_CLOSE` tới cửa sổ ứng dụng, `pidof com.phoenix.read` từ `5152` thành **rỗng**, tiền cảnh quay về màn hình chính Android — ứng dụng đã thực sự thoát.

## II. Mạng: không còn trông vào may rủi, chuyển sang tự phục hồi

Bản trước đã xác định "Hongguo (红果) bấm đồng ý xong thì đen màn hình" = máy ảo không có mạng. Nhưng lúc đó chỉ là "chờ thêm một lúc", gặp lần khởi động mà Wi-Fi mãi không liên kết thì vẫn timeout.

Bản này chuyển xử lý mạng sang **tự nâng cấp theo chi phí từ nhỏ đến lớn**:

1. **Chờ mạng trước khi khởi động ứng dụng** (tối đa 60s, tiến độ hiển thị trong log);
2. Không chờ được thì **khởi động nguội máy ảo một lần** (`-no-snapshot-load`, tránh snapshot khởi động nhanh có thể đã được lưu lúc "không có mạng"), rồi chờ thêm tối đa 180s;
3. Mạng vừa thông là **lưu snapshot ngay**, lần khôi phục sau trạng thái card mạng được khôi phục theo;
4. "Cài đặt → Sửa mạng" dùng cùng quy trình, chỉ khi hai bước đầu đều thất bại mới **reset dữ liệu Android** (danh sách ứng dụng giữ lại, mở ra sẽ tự cài lại, nhưng trạng thái đăng nhập/lịch sử trong ứng dụng sẽ mất).

> Về "nâng phiên bản Android": lần này không đổi ảnh. Lý do là đổi ảnh thì mọi người dùng phải tải lại 1.5 GB,
> trong khi đo thực tế cho thấy gốc rễ vấn đề nằm ở **Wi-Fi của trình giả lập liên kết chậm/thỉnh thoảng không liên kết**, không phải bản thân phiên bản Android;
> dùng "chờ + khởi động nguội tự phục hồi" có thể bao phủ cùng tình huống mà không tăng dung lượng. Nếu sau này chứng minh được ảnh phiên bản nào ổn định hơn,
> sẽ phát hành riêng một bản để chuyển đổi.

## III. CI: token đồng bộ Gitee đã cấu hình xong

Secret Actions `GITEE_TOKEN` của kho GitHub đã được ghi, từ nay khi gắn tag `v*` để phát hành,
workflow Release sẽ tự đồng bộ bản portable lên Gitee, không cần chạy script thủ công nữa.

## IV. Đo thực tế

- `npm test`: **113 mục đều đạt** (8 + 25 + 80).
- Sau khi đóng cửa sổ, `pidof com.phoenix.read` rỗng (ứng dụng thực sự thoát).
- Log mạng sẵn sàng: `Mạng máy ảo đã sẵn sàng (10.0.2.16)`, sau đó trang chủ Hongguo kết xuất bình thường.

## V. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
