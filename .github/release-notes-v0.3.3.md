## Phiên bản này giải quyết gì

### 1. Tải chậm: nguyên nhân thật là "mọi luồng đều chen chúc vào một địa chỉ bị chặn"

Đo thực tế trên máy này: 8 luồng đều đánh vào GitHub chỉ được **0.23 MB/s**, gói cập nhật 113MB mất **493 giây**;
cùng lúc đó hai kết nối đi trực tiếp nhận được **0 byte** (TCP thông nhưng không có dữ liệu), chỉ có mirror là chạy.

- **Chia mảnh song song đa nguồn**: tệp được cắt thành khối, các khối khác nhau đồng thời kéo từ "GitHub trực tiếp / ghfast / gh-proxy", băng thông cộng dồn.
  Đo trên cùng máy: **113MB giảm từ 493 giây xuống 77 giây** (khoảng 1.5 MB/s, gồm cả đo tốc độ và giải nén).
- **Tốc độ thấp thì đổi nguồn**: khi một khối chỉ còn vài chục KB/s sẽ tự ngắt, đổi nguồn và tiếp tục từ điểm dừng — trước đây sẽ "kẹt ở 95% không nhúc nhích".
- **Tải tiếp theo khối**: gói runtime 1.4GB tải được một nửa thì lỗi, chạy lại chỉ bổ sung các khối còn thiếu, không phải tải lại từ đầu.
- **Watchdog chống đứng**: kết nối đã thiết lập nhưng 20 giây không có byte nào thì bỏ ngay kết nối đó và chuyển sang nguồn tiếp theo,
  không còn ngồi chờ 30 giây timeout socket làm kẹt cả gói.
- **Đo và chọn lại mỗi lần**: mỗi địa chỉ ứng viên tải thật 256KB để đo tốc độ, chỉ tính thông lượng "sau khi nhận byte đầu tiên"
  (tính cả vài trăm mili giây bắt tay sẽ đánh giá nhầm nguồn "độ trễ cao nhưng băng thông lớn" là chậm); đo tuần tự để tránh giành băng thông của nhau.

### 2. Hai nguồn: GitHub và Gitee tự chọn bên tốt hơn

- Cả hai kho nay đều công khai: GitHub `RoutineMiku/apkstart`, Gitee `daily-miku/apkstart`.
- Kiểm tra phiên bản hỏi đồng thời cả hai bên, lấy bên có số phiên bản cao hơn; một nguồn timeout/bị chặn không ảnh hưởng nguồn kia.
- Gitee giới hạn mỗi tệp đính kèm bản phát hành là 100MB, nên gói portable ở đó được phát hành dưới dạng `.part1/.part2`,
  client tự chọn nguồn cho từng mảnh để tải rồi ghép lại thành gói trọn (kiểm tra kích thước từng mảnh, thiếu mảnh là dừng).
- Gọi Gitee ẩn danh có giới hạn tần suất: thêm cache phiên bản 10 phút + ngắt mạch 15 phút khi gặp 403/429,
  khi cả hai nguồn đều hỏng thì quay về kết quả lần trước và đánh dấu `stale`, giao diện không báo lỗi ngay.

### 3. Không còn xóa nhầm dữ liệu người dùng

- **Đĩa đầy thì không còn tự xóa dữ liệu**: trước đây nấc cuối của ma trận thử lại có `-wipe-data`, khi đĩa đầy mọi nấc đều thất bại,
  thử lại liên tục sẽ xóa sạch cả ứng dụng lẫn dữ liệu lưu. Nay mọi lần thử lại tự động đều cấm xóa dữ liệu, thiếu dung lượng đĩa thì dừng hẳn và hướng dẫn bạn cách xử lý.
- **Đổi ổ đĩa chứa ảnh không bị coi là đổi ảnh**: sau khi chuyển thư mục runtime từ ổ C sang ổ D (trong Cài đặt cũng khuyên làm vậy),
  trước đây sẽ bị đánh giá là "ảnh đã thay đổi" → `-wipe-data` → mất hết ứng dụng đã cài. Nay so sánh theo danh tính của ảnh, đổi ổ không động đến dữ liệu.
- Sửa **thứ tự tham số của `qemu-img resize`**: trước đây xảy ra tình trạng "tệp phình lên 6GB nhưng hệ thống tệp vẫn là 64MB",
  Android vừa ghi đã đầy, mọi dịch vụ `setxattr` báo ENOSPC rồi sập. Nay khi khởi động còn tự đối chiếu và tự phục hồi.

### 4. Khác

- Cài đặt thất bại không còn spam thông báo: bấm liên tục cùng một APK chỉ chạy một lần; thông báo lỗi đưa ra kết luận có thể hành động theo loại
  (phân vùng không đủ / gói ARM / xung đột chữ ký / hạ cấp phiên bản).
- Tài nguyên và đĩa kiểm soát được: ba mức chính sách tài nguyên (tiết kiệm / cân bằng / mượt), ba mức chất lượng hình ảnh,
  phân vùng dữ liệu Android điều chỉnh được 4–24GB và hỗ trợ mở rộng tại chỗ (không mất ứng dụng đã cài), thư mục dữ liệu Android có thể trỏ riêng sang ổ khác.
- Dung lượng: bản portable 230MB (cắt bỏ 52 gói ngôn ngữ không dùng đến, tiết kiệm 39MB).
- Log cuộn theo kích thước, không còn phình vô hạn; đồng bộ thư mục chia sẻ không còn chuyển đi chuyển lại cùng một tệp.

## Kiểm chứng trên máy thật lần này (cùng một máy, Windows 11 + ảnh Android 14 Play)

| Hạng mục | Kết quả |
|---|---|
| Khởi động nguội đến khi mở được ứng dụng | **23–25 giây** (lần đầu kèm dò tìm khoảng 32 giây) |
| Trúng snapshot quickboot | **5 giây** |
| Cài APK và mở ứng dụng | Cửa sổ ứng dụng xuất hiện sau **1.5 giây** (snapshot nóng) |
| Cửa sổ trình giả lập/console hiện ra trong suốt 45 giây khởi động | **0 cái** |
| Cửa sổ sót lại trên màn hình sau khi thoát ApkStart | **0 cái** |

## Cài đặt

- **Bản đầy đủ** `ApkStart-*-Setup.exe`: kèm sẵn runtime, cài xong dùng ngay (khoảng 1.4GB).
- **Bản nhẹ** `ApkStart-*-win64-portable.zip`: giải nén là dùng, lần khởi động đầu tự tải runtime
  (nay sẽ chọn nguồn nhanh nhất và hỗ trợ tải tiếp khi gián đoạn).

Nội dung hai kho giống nhau, người dùng ở Trung Quốc nên dùng Gitee.
