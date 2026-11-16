# ApkStart v0.4.0

> Tóm lại: sửa lỗi hồi quy "Hongguo (红果) không mở được / đen màn hình mãi", bấm một lần vào khay hệ thống là mở được giao diện chính, tăng tốc khởi động thêm một lượt, và chặn đồng loạt các cửa sổ lặt vặt lúc chạy.

## I. Sửa: Hongguo không mở được / đen màn hình mãi (lỗi hồi quy của v0.3.9)

**Nguyên nhân**: bản trước, để "chờ mạng sẵn sàng rồi mới khởi động ứng dụng", đã gọi logic chờ có **thử lại khởi động nguội** trong quy trình khởi động. Khi mạng chậm nó sẽ "dừng máy ảo → khởi động nguội", trong khi ứng dụng đang `adb install` / `am start` — thiết bị biến mất giữa chừng, thế là:

```
adb.exe: device 'emulator-5554' not found
launch failed com.phoenix.read
```

**Cách sửa**:

- **Trên đường khởi động chỉ chờ, không bao giờ khởi động lại**: chờ tối đa 20 giây, không chờ được thì cứ khởi động ứng dụng trước (trang chậm một chút không sao, không được thất bại luôn);
- Những việc nặng như khởi động nguội/reset chỉ làm khi người dùng chủ động bấm "Sửa mạng";
- `waitForNetwork` không còn bỏ cuộc ngay khi thấy `device-offline` — máy ảo vừa khởi động lại có vài chục giây adb chưa lên, nay cho 45 giây ân hạn (các bản trước vì vậy mà đánh giá nhầm "sửa thất bại").

**Đồng thời sửa đúng "Sửa mạng"**: đo thực tế cho thấy ảnh này chỉ có lần khởi động ngay sau `-wipe-data` là kết nối mạng ổn định, nên giờ reset dữ liệu luôn (giữ danh sách ứng dụng, mở ra tự cài lại), kết nối mạng thành công thì **lưu snapshot ngay** — lần sau khôi phục từ snapshot thì trạng thái card mạng được khôi phục theo.

Đo thực tế: sau khi sửa, log khởi động xuất hiện `Mạng máy ảo đã sẵn sàng (10.0.2.16)`, bấm "Đồng ý và tiếp tục" vào `MainFragmentActivity`, trang chủ tải bình thường danh sách phim và luồng đề xuất.

## II. Khay hệ thống: bấm một lần là mở giao diện chính

Trước đây chỉ gắn nhấp đúp, người dùng bấm một lần không thấy phản hồi sẽ tưởng biểu tượng khay bị hỏng. Nay bấm một lần là mở cửa sổ chính (nhấp phải vẫn là menu, nhấp đúp như cũ).

## III. Tốc độ khởi động

- Đường khởi động không còn thử lại khởi động nguội, bỏ được những lần chờ thường mất 3~5 phút;
- Thời gian chờ mạng giảm từ 60 giây xuống **20 giây**, và khi thiết bị mất kết nối thì trả về ngay thay vì quay vô ích;
- Sau khi sửa mạng sẽ lưu một snapshot "mạng bình thường", sau đó mỗi lần đều khôi phục từ snapshot: đo thực tế khởi động hoàn chỉnh (bật máy→kết nối mạng→cài đặt→nhúng) khoảng **48 giây**, trong đó bật máy khoảng 20 giây.

## IV. Cửa sổ lặt vặt lúc chạy

Proxy cửa sổ thêm một lớp dự phòng: ẩn đồng loạt mọi cửa sổ cấp cao nhất hiển thị thừa do **tiến trình thuộc thư mục runtime của chúng ta** tạo ra (hộp thông báo Qt, hộp thoại crash, thanh âm lượng, cửa sổ log v.v.), chỉ giữ lại một cửa sổ chính của trình giả lập cần nhúng vào cửa sổ chủ. Cách làm trước đây là điểm danh từng tên lớp, sót một cái là nháy một lần.

## V. Gia cố kỹ thuật

- `agent.ps1` mang lại **UTF-8 BOM**. Trước đây lưu theo cách thông thường sẽ mất BOM, PowerShell 5.1 đọc chú thích tiếng Trung theo ANSI, có thể gộp chú thích và dòng mã kế tiếp thành một dòng khiến `Add-Type` biên dịch thất bại (biểu hiện là "proxy cửa sổ khởi động thất bại / cửa sổ ứng dụng không được nhúng").
- Thêm kiểm thử hồi quy: **script proxy cửa sổ bắt buộc phải có UTF-8 BOM**, sau này mất nữa sẽ làm kiểm thử thất bại ngay.

## VI. Đo thực tế

- `npm test`: **114 mục đều đạt** (8 + 25 + 81).
- Hongguo: khởi động → đồng ý → trang chủ hiển thị bình thường luồng video (xác nhận bằng ảnh chụp).
- Bấm một lần vào khay hệ thống mở được giao diện chính.

## VII. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
