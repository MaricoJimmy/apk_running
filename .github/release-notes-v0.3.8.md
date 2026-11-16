# ApkStart v0.3.8

> Tóm lại: thêm một **thẻ chào mừng khởi động đẹp mắt** (nhắc bạn mọi thứ đã sẵn sàng khi tự khởi động cùng máy), sửa lỗi **một số người dùng không kiểm tra được cập nhật**, thêm tính năng **dọn tàn dư phiên bản cũ**, và làm đẹp lại toàn bộ giao diện một lượt.

## I. Mới: thẻ chào mừng khi khởi động

Khi tự khởi động cùng máy hoặc mở ApkStart, sẽ bật một thẻ chào mừng gọn nhẹ:

- Phía trên là ảnh đầu trang gradient thương hiệu + lời chào động (Chào buổi sáng / Chào buổi chiều / Khuya rồi…);
- Ba chỉ số nhìn là thấy ngay: **ứng dụng đã cài / trạng thái runtime Android / cổng thiết bị**;
- Hai gợi ý hữu ích nhất lúc đó (chưa cài ứng dụng thì hướng dẫn cách cài; đã cài thì hướng dẫn thao tác cửa sổ);
- Khi có phiên bản mới sẽ báo ngay tại đây, không bật thêm bong bóng ở góc dưới bên phải nữa;
- Phía dưới có thể tích **"Lần khởi động sau không tự bật nữa"**, hoặc bấm thẳng "Mở Cài đặt".

Quy tắc hiển thị: tự khởi động cùng máy thì luôn hiện; mở thủ công thì tối đa mỗi ngày một lần; đã tích thì vĩnh viễn không hiện.

## II. Sửa: một số người dùng không kiểm tra được cập nhật

**Nguyên nhân**: thông tin phiên bản phụ thuộc API của hai bên. API ẩn danh của GitHub chỉ cho 60 lần mỗi IP mỗi giờ; API ẩn danh của Gitee còn chặt hơn, đo thực tế gọi liên tiếp vài lần là trả về `403 Rate Limit Exceeded`. Ở mạng công ty / mạng trường học / sau NAT của nhà mạng, người dùng rất dễ bị giới hạn tần suất ở cả hai nguồn, giao diện chỉ hiện "Kiểm tra cập nhật thất bại".

**Cách sửa**:

- Thêm **phương án dự phòng không phụ thuộc API**: đi theo chuyển hướng 302 của `releases/latest` để lấy số phiên bản (qua CDN, không tốn hạn mức API), rồi ghép địa chỉ tải theo quy ước phát hành;
- Hỗ trợ ghép địa chỉ chuẩn `/releases/download/<tag>/<tên tệp>` cho cả GitHub và Gitee (đo thực tế Gitee sẽ 302 tới link trực tiếp của tệp đính kèm, tải được đủ byte);
- Khi kiểm tra thất bại, giao diện không còn trống trơn mà có nút **"Mở trang tải về"**; `app:updateOpen` nay cũng cho phép `gitee.com`, người dùng ở Trung Quốc không bị chặn.

## III. Mới: dọn tàn dư phiên bản cũ

Cài đặt → Tích hợp hệ thống → **"Dọn tàn dư phiên bản cũ"**:

- Quét **thư mục chương trình phiên bản cũ** (`ApkStart-vX.Y.Z-win64-portable` v.v. trong cùng thư mục, và bắt buộc phải thực sự chứa `ApkStart.exe`, tuyệt đối không đụng vào phiên bản đang chạy);
- Quét **mục gỡ cài đặt registry đã hết hiệu lực** (mục chết mà `InstallLocation` hoặc trình gỡ cài đặt không còn tồn tại);
- Quét **gói tạm do việc tải cập nhật để lại** (`%APPDATA%\apkstart\update` và `ApkStart-*.zip` v.v. trong thư mục tạm);
- Liệt kê danh sách và dung lượng có thể giải phóng trước, xác nhận rồi mới xóa, và báo cáo đúng sự thật "có mấy mục đang bị chiếm dụng nên chưa xóa được".

Chỉ dọn những gì chứng minh được là an toàn, **không động đến dữ liệu người dùng, không động đến phiên bản hiện tại**.

## IV. Ẩn các hộp thoại lặt vặt khi khởi động

- Thông báo hệ thống "Có phiên bản mới" khi khởi động đã bỏ, gom hết vào thẻ chào mừng;
- Các thông báo khởi động trước đây rải rác trong nhiều toast / bong bóng, nay chỉ còn một thẻ này;
- Logic chặn cửa sổ console đen giữ nguyên (cửa sổ console của trình giả lập / netsimd / adb vẫn bị ẩn).

## V. Làm đẹp giao diện

- Bảng màu hoàn toàn mới: màu thương hiệu xanh ngọc lục bảo + nền trung tính dịu, nền có một lớp quầng sáng thương hiệu rất nhạt;
- Thanh tiêu đề chuyển sang chất liệu **kính mờ**, biểu tượng cửa sổ thay bằng dấu thương hiệu dạng vector (ở kích thước nhỏ vẫn nhận ra là "nút phát", không còn là một khối tối nhòe nhoẹt);
- Thẻ ứng dụng: bo góc lớn hơn, nổi lên khi rê chuột + viền màu thương hiệu, biểu tượng có đổ bóng;
- Nút: nút chính dùng gradient + highlight bên trong, nút phụ nhẹ hơn;
- Hộp thoại modal, tiêu đề nhóm, thanh cuộn, thanh trạng thái được làm lại đồng bộ;
- Thẻ chào mừng dùng cùng một ngôn ngữ thiết kế (ảnh đầu trang gradient + quầng sáng + họa tiết chấm).

## VI. Đo thực tế

- `npm test`: **113 mục đều đạt** (8 + 25 + 80).
- Kiểm chứng bằng ảnh chụp smoke test: giao diện chính và thẻ chào mừng đều kết xuất bình thường (xem ảnh chụp trên trang phát hành).
- "Dọn tàn dư phiên bản cũ" trên máy phát triển quét ra 6 thư mục phiên bản cũ, khoảng 1.3 GB, phiên bản đang chạy được loại trừ chính xác.

## VII. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
