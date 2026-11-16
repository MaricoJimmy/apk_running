# ApkStart v0.3.6

> Tóm lại: **đã sửa lỗi "Hongguo (红果) bấm 'Đồng ý và tiếp tục' xong thì màn hình đen mãi"**. Nguyên nhân thật là Wi-Fi của máy ảo Android mãi không kết nối được, ứng dụng tải trang chủ khi chưa có mạng nên trang chỉ còn một nền đen — không liên quan đến card đồ họa hay backend kết xuất.

## I. Hongguo bấm "Đồng ý" xong thì màn hình đen — nguyên nhân thật và cách sửa

### Đánh giá sai ở bản trước

v0.3.5 quy lỗi màn hình đen cho backend GPU (swangle / software), điều đó là **sai**. Đổi backend đương nhiên vô ích.

### Nguyên nhân thật xác định được qua đo thực tế lần này

Dùng adb kiểm tra từng lớp:

- `cmd wifi status`: `Wifi is not connected`; `ip -o addr show wlan0`: **không có IP nào**;
- Nghĩa là **lúc đó máy ảo không có mạng**;
- Hộp thoại quyền riêng tư của Hongguo là trang cục bộ nên vẫn hiển thị bình thường; bấm "Đồng ý và tiếp tục" xong thì cần kéo dữ liệu trang chủ,
  không lấy được dữ liệu thì kết xuất thành một khối nền đen — người dùng thấy chính là "bấm đồng ý xong thì màn hình đen";
- Còn `sys.boot_completed` chỉ cho biết hệ thống đã lên, **liên kết Wi-Fi + DHCP thường còn phải chờ thêm vài chục giây đến hơn hai phút**.
  Ứng dụng khởi động sớm hơn lúc mạng sẵn sàng, mọi yêu cầu trang chủ đều thất bại, trang cứ đen mãi.

Bằng chứng đo thực tế: cùng một máy ảo, kiểm tra ngay sau khi khởi động là "không có IP", đợi một hai phút kiểm tra lại thì thành
`wlan0 inet 10.0.2.16/24` + `Wifi is connected to "AndroidWifi"`, lúc này trang chủ Hongguo hoàn toàn bình thường.

### Sửa trong bản này

1. **Chờ mạng sẵn sàng trước khi khởi chạy ứng dụng**: `installer.launch` sẽ chờ tối đa 150 giây trước `am start`,
   log sẽ in `Đang chờ máy ảo Android kết nối mạng… Ns`, sẵn sàng rồi mới thực sự khởi động ứng dụng — tránh tận gốc
   màn hình đen do "ứng dụng chạy trước khi có mạng".
2. **Kiểm tra mạng sau khi khởi động**: khởi động thành công thì kiểm tra máy ảo đã có IP chưa, không có mạng thì ghi rõ nguyên nhân vào log,
   không để người dùng nhìn màn hình đen mà đoán.
3. **Cài đặt → Sửa mạng** (nút mới): sửa một chạm. Cách làm là reset dữ liệu người dùng Android rồi khởi động lại,
   sau đó chờ đến khi mạng sẵn sàng (tối đa 4 phút), thành công thì lưu trạng thái "mạng bình thường" thành snapshot khởi động nhanh.
   - **Danh sách ứng dụng được giữ lại**, mở ứng dụng sẽ tự cài lại, không cần cài lại APK thủ công;
   - Dữ liệu runtime trong ứng dụng như trạng thái đăng nhập, lịch sử xem phim sẽ mất, cần đăng nhập lại;
   - Chỉ ảnh hưởng AVD hiện tại, ảnh hệ thống và cache APK trên máy đều không bị động đến.

> Nếu Hongguo giờ vẫn đen màn hình: trước tiên cứ mở Hongguo thử (bản này sẽ tự chờ mạng); vẫn đen thì bấm "Cài đặt → Sửa mạng".

## II. Bản sửa "Dọn cache" của bản trước tiếp tục có hiệu lực

`includeSnapshots` + "Reset dữ liệu Android" của v0.3.5 không thay đổi, vẫn dùng được.

## III. Hạn chế đã biết

- Ảnh Android 14 (`google_apis_playstore`) này có lỗi thượng nguồn: khi khởi động nguội trên **dữ liệu người dùng đã có**,
  Wi-Fi thường cứ `NO-CARRIER`, không lấy được IP; lần khởi động ngay sau khi reset dữ liệu thì kết nối bình thường.
  Vì vậy "Sửa mạng" sẽ reset dữ liệu và lưu snapshot ngay để giữ trạng thái dùng được.
- Ảnh Play Store không cho phép `adb root`, không thể xóa riêng cấu hình Wi-Fi bị hỏng.

## IV. Nhật ký đo thực tế

- Sau khi sửa: bấm "Đồng ý và tiếp tục" → vào `MainFragmentActivity`, trang chủ hiển thị bình thường danh sách phim và luồng đề xuất
  (xác nhận bằng ảnh chụp, không đen màn hình).
- Cùng máy ảo sau khi chờ mạng sẵn sàng: `wlan0 inet 10.0.2.16/24`, `Wifi is connected to "AndroidWifi"`.
- `npm test`: **113 mục đều đạt** (8 + 25 + 80).

## V. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
