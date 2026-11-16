# ApkStart v0.3.9

> Tóm lại: chuyển **xoay ngang/dọc** từ "xoay hình ảnh" sang **chuyển bố cục điện thoại / máy tính bảng** thực sự, sửa lỗi toàn màn hình không xoay ngang, bấm không ăn, và viền đen xuất hiện khi bấm nút thanh tiêu đề; ngoài ra thêm **thu hồi dung lượng lưu trữ**.

## I. Ngang/dọc / toàn màn hình: chuyển thành chuyển bố cục thực sự

**Vấn đề trước đây**: bấm xoay (hoặc toàn màn hình) thì cả hình ảnh nằm nghiêng theo chiều kim đồng hồ/ngược chiều kim đồng hồ, ứng dụng không hề sắp xếp lại bố cục, cũng không dựng thẳng lại được; toàn màn hình cũng không tự xoay ngang.

**Nguyên nhân gốc**: cách làm cũ là "sửa `wm size`, rồi để proxy cửa sổ gửi Ctrl+← cho trình giả lập". Ctrl+← chỉ xoay **hình ảnh của trình giả lập** 90°, bố cục phía Android hoàn toàn không đổi — nên thứ nhìn thấy là "hình ảnh nằm nghiêng". Hơn nữa cấu hình AVD được tạo ra ghi cứng `hw.sensors.orientation=no`, Android hoàn toàn không cho xoay, chỉ có thể xoay hình ảnh cho có.

**Cách làm hiện nay**:

- Chỉ sửa **kích thước hiển thị logic** (`wm size`), để Android sắp xếp lại bố cục theo chiều rộng mới:
  - Dọc 720×1280 @320dpi ≈ **rộng 360dp → bố cục điện thoại**;
  - Ngang 1280×720 @320dpi ≈ **rộng 640dp → bố cục máy tính bảng/chia cột** (Android lấy 600dp làm ngưỡng máy tính bảng);
- Đồng thời `wm user-rotation lock 0`, bảo đảm hình ảnh luôn thẳng, không còn "nằm nghiêng";
- **Bỏ bước xoay hình ảnh**, hình ảnh và bố cục luôn nhất quán;
- Cửa sổ sẽ tính lại tỉ lệ khung hình theo độ phân giải mới và khớp lại, không để viền đen;
- **Nút toàn màn hình nay tự chuyển sang ngang (bố cục máy tính bảng)**, thoát toàn màn hình tự quay về bố cục điện thoại dọc; chuyển "Chế độ hiển thị" trong Cài đặt cũng có hiệu lực tương tự;
- Cấu hình AVD đổi thành `hw.sensors.orientation=yes` + `hw.sensors.accelerometer=yes`, máy mới sau này không bị khóa cứng chiều dọc nữa.

## II. Sửa: viền đen xuất hiện khi bấm bốn nút trên thanh tiêu đề

Cửa sổ Qt của trình giả lập lớn hơn LCD thật một vòng (mỗi cạnh có viền xám 8px). Để viền xám không xuất hiện trong hình, cách làm cũ là cho cửa sổ con tràn lên trên/sang trái 8px — 8px này đè đúng lên đáy thanh tiêu đề; mà khi bấm nút, proxy cửa sổ sẽ đưa cửa sổ trình giả lập lên trên cùng, thế là phần tràn ra vẽ thành một **viền đen** bên dưới thanh tiêu đề.

**Cách sửa**: thêm **cắt vùng cửa sổ** (`SetWindowRgn`) cho cửa sổ trình giả lập được nhúng, cắt thẳng 8px tràn lên thanh tiêu đề. Như vậy dù được đưa lên thế nào, nó cũng không vẽ được lên thanh tiêu đề.

## III. Sửa: bấm không ăn / không bấm được "Đồng ý và tiếp tục"

Vấn đề này cùng gốc với hai vấn đề trên: sau khi hình ảnh bị xoay 90°, ánh xạ tọa độ của proxy cửa sổ vẫn là "dọc", vị trí bấm bị lệch toàn bộ, trông như "bấm mà không phản hồi". Sửa đúng việc chuyển bố cục thì bấm trở lại bình thường.

Nhân tiện giảm chi phí "chờ kết nối mạng": thử lại khởi động nguội chuyển thành **mỗi tiến trình chỉ làm một lần**, lần chờ đầu giảm từ 60s xuống 25s — trước đây mở một lần có thể phải chờ thêm mấy phút, giờ bình thường vài giây là qua.

## IV. Tối ưu dung lượng lưu trữ

"Dọn tàn dư phiên bản cũ" nay còn thu hồi thêm **snapshot khởi động nhanh đã bỏ**:

- `default_boot` do bản cũ để lại (mỗi ram.img khoảng **3 GB**);
- Tàn dư `*.stale-*` do không xóa được nên đổi tên;
- Snapshot đang dùng (`apkstart`) không bao giờ bị động đến.

Đo thực tế trên máy phát triển, tổng dung lượng có thể thu hồi khoảng **4.65 GB** (6 thư mục chương trình phiên bản cũ + 1 snapshot đã bỏ).

## V. Đo thực tế

- `npm test`: **113 mục đều đạt** (8 + 25 + 80).
- Sau `wm size 1280x720`, framebuffer đo được thành **1280×720**, hình ảnh thẳng đứng (xác nhận bằng ảnh chụp).
- Cửa sổ ứng dụng được nhúng `embedded=true`; sau khi đóng cửa sổ `pidof` rỗng (bản sửa của bản trước vẫn có hiệu lực).

## VI. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
