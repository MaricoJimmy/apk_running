# Ghi chú phát hành ApkStart v0.3.5

> Phiên bản này, trên nền v0.3.4, sửa một loạt lỗi đã được xác nhận khi rà soát mã, tất cả đều đã được kiểm thử thực tế trên máy.

## Phiên bản này giải quyết gì

### 1. Không cài được APK trên 2GB (#21)
Bản cũ đọc toàn bộ tệp vào bộ nhớ khi phân tích APK, trên 2GB sẽ đụng ngay giới hạn một Buffer của Node,
biểu hiện là "bấm cài, hiện một lỗi tiếng Anh, góc dưới bên phải cứ quay mãi".

- Phân tích chuyển sang **bộ đọc ZIP dạng tệp**: chỉ đọc central directory, manifest/bảng tài nguyên/biểu tượng đọc khi cần,
  bộ nhớ đỉnh giảm từ "bằng kích thước gói cài" xuống "vài MB";
- Gói tách `.apks` / `.xapk` cũng chuyển sang giải nén dạng luồng (mỗi mảnh vừa giải nén vừa ghi xuống đĩa),
  khi thất bại sẽ dọn thư mục tạm;
- Timeout của `adb install` chuyển từ cố định 4 phút sang **tăng theo kích thước gói** (gói 2GB khoảng 5 phút, tối đa 20 phút),
  tránh gói lớn trên ổ chậm bị đánh giá nhầm là thất bại;
- Thông báo cài đặt thất bại được phát thống nhất từ cổng sự kiện của tiến trình chính, đồng thời xóa vòng quay "Đang cài đặt…",
  sau khi báo lỗi không còn sót lại thanh tiến trình quay mãi.

### 2. Tương thích ZIP cho gói ảnh lớn / gói cập nhật lớn

- Thêm hỗ trợ **ZIP64** (EOCD locator + trường mở rộng id=0x0001):
  khi số mục vượt 65535 không còn lặng lẽ làm rơi mục, offset/kích thước của mục siêu lớn cũng được đọc từ trường mở rộng.

### 3. Giai đoạn triển khai "kẹt ở bước chuẩn bị runtime" / "dừng ở 99% rồi tải lại cả bộ ảnh"

- Đo tốc độ chọn nguồn chuyển từ "30 giây không có phản hồi nào" sang **báo tiến độ từng nguồn** (nguồn thứ i/n),
  mỗi nguồn chờ tối đa 6 giây; cổng không thông chỉ bị xếp xuống cuối, không ảnh hưởng việc tải;
- Trước khi tải gói runtime trọn sẽ hiện "Đang lấy thông tin phiên bản runtime…";
- Giải nén ảnh hệ thống thất bại **không còn bị nuốt lặng lẽ**: sẽ báo lỗi rõ ràng kèm tên tệp,
  không còn cảnh "tiến độ dừng ở 99% → lại nhảy về dùng nguồn chính thức tải lại 1.4GB";
- Giải nén ảnh chuyển sang **ghi `.part` trước rồi đổi tên nguyên tử**: mất điện/tắt chương trình giữa chừng sẽ không để lại
  một system.img dở dang "trông như đã xong";
- Phán định "đã giải nén" chuyển từ "lớn hơn 32MB" sang "ít nhất không nhỏ hơn kích thước gói nén",
  ảnh dở dang sẽ được giải nén lại;
- Bộ canh đĩa bổ sung ước tính cho gói runtime trọn (gói nén 1.5GB + sau giải nén 3.3GB, lúc đỉnh tồn tại đồng thời),
  thiếu dung lượng sẽ được báo trước kèm hướng xử lý, thay vì tải được nửa chừng mới thất bại.

### 4. Đã đổi "Thư mục dữ liệu runtime" trong Cài đặt mà vẫn tải vào thư mục cũ (#23)

Khi cạnh thư mục chương trình của bản portable có `runtime/`, bản cũ sẽ ghi đè `runtime.dir` do người dùng tự đặt
bằng runtime bundled đó lúc khởi động. Nay: **chỉ cần người dùng đã chỉ định thư mục rõ ràng và trong đó có emulator
thì luôn tôn trọng**; chỉ khi "chưa từng đặt" hoặc "thư mục đã đặt không còn dùng được" mới tự tiếp quản.

### 5. Cập nhật trực tuyến có thể coi gói runtime trọn 1.5GB là gói chương trình

Bản phát hành đồng thời có gói portable và `ApkStart-runtime-*.zip`. So khớp `.zip` dự phòng của bản cũ
không loại trừ cái sau, nếu một lần phát hành quên tải lên gói portable, trình cập nhật sẽ giải nén gói runtime trọn vào thư mục chương trình.
Nay so khớp dự phòng loại trừ rõ tài sản `runtime`; không có tài sản phù hợp thì báo đúng sự thật "vui lòng tải thủ công từ trang phát hành".

### 6. Sau khi khởi động thất bại, báo cáo chẩn đoán không cho biết nguyên nhân (#20 / #25)

Bản cũ chỉ giữ "nhật ký các lần thử khởi động / kết luận chẩn đoán" trong bộ nhớ, người dùng khởi động lại ApkStart rồi xuất báo cáo
thì bên trong chỉ có `attempts: []`, `UNKNOWN`, đành nhờ tác giả lật log.

- Khi khởi động thất bại sẽ ghi **attempts / kết luận chẩn đoán / mã thoát** xuống đĩa tại
  `%APPDATA%\apkstart\logs\last-failure.json` (lần khởi động thành công sau sẽ xóa);
- Báo cáo chẩn đoán kèm theo bản ghi trên đĩa, ý nghĩa mã thoát và phần đuôi `emulator.log`
  (khi log trong bộ nhớ trống thì đọc thẳng 300 dòng cuối từ tệp);
- Thêm **quy tắc chẩn đoán `0xC0000005` (thập phân 3221225477)**: phán định là "backend kết xuất bị crash",
  gợi ý cập nhật driver card đồ họa / hạ chất lượng hình ảnh, thay vì câu mơ hồ "runtime chưa khởi động xong";
- Gặp loại crash này sẽ **tự chuyển sang backend kết xuất bảo thủ hơn để thử lại và ghi nhớ**
  (`engine.badGpu`, vô hiệu theo phiên bản emulator), lần khởi động sau không phải đụng lại lỗi đó trước;
- Bảng runtime trong trang Cài đặt hiển thị trực tiếp "Lần khởi động trước thất bại: …", không cần đợi xuất báo cáo.

### 7. Gỡ ApkStart xóa mất liên kết tệp .apk vốn có của người dùng

Bản cũ khi hủy liên kết thì vô điều kiện xóa chương trình mặc định của `.apk` (điều mà chú thích trong mã hứa "chỉ khi vẫn trỏ về chính chúng ta"
thực ra chưa được cài đặt). Nay:

- Khi đăng ký sẽ ghi lại chương trình mặc định cũ vào `HKCU\Software\ApkStart\assocPrev`;
- Khi hủy liên kết sẽ **ưu tiên khôi phục** nó; không có bản ghi và hiện vẫn trỏ về ApkStart mới xóa;
- Đo thực tế trên máy: liên kết gốc là `MuMuPlayer.apk`, đăng ký → hủy xong được khôi phục nguyên trạng.

### 8. Biểu tượng: các định dạng ngoài WebP và chuyện "dùng ảnh giữ chỗ mà không nói"

- Định dạng biểu tượng ứng viên thêm `jpg/jpeg`;
- XML của biểu tượng thích ứng / `layer-list` nay sẽ tìm bitmap đệ quy (tối đa 3 tầng),
  không còn mặc định rơi về ảnh giữ chỗ thương hiệu;
- Khi thật sự không giải được, thông báo hoàn tất cài đặt sẽ nói rõ "Không phân tích được biểu tượng, lối tắt tạm dùng biểu tượng giữ chỗ",
  thay vì để người dùng nhìn một hình tam giác xanh mà đoán.

### 9. Sau khi cài mới, bấm biểu tượng trên màn hình chỉ thấy màn hình chính Android

Lỗi thượng nguồn phát hiện khi đo thực tế (v0.3.4 cũng có): sau khi cài ứng dụng, điểm khởi động ghi trong `apps.json` là
"thành phần đầy đủ" (`com.foo.bar/com.foo.bar/.MainActivity`), mà khi khởi động lại ghép thêm tên gói một lần nữa,
`am start -n` nhận được `com.foo.bar/com.foo.bar/com.foo.bar/.MainActivity`,
hệ thống hủy khởi động luôn (log `result code=-92`) — trong cửa sổ chính là màn hình chính Android.

- Thêm `componentArg()`: thành phần đầy đủ dùng nguyên, chỉ tên lớp thuần mới thêm tên gói; tương thích cả hai kiểu dữ liệu cũ;
- `parseResolvedActivity()` chuyển sang quét mọi dòng (đầu ra `resolve-activity` cuối thường có dòng trống),
  không còn vì dòng cuối là chuỗi rỗng mà đánh giá nhầm là "không phân giải được";
- Đo thực tế: cài lại Hongguo (红果) rồi bấm biểu tượng trên màn hình, `mCurrentFocus` trỏ đúng vào
  `com.phoenix.read/...SplashActivity`, trong cửa sổ là giao diện của chính ứng dụng (không còn là màn hình chính).

### 10. Biên cuộn log

- Khi tên tệp log không kết thúc bằng `.log`, việc cuộn sẽ "xóa trước rồi đổi tên" dẫn đến mất log;
  nay bỏ qua cuộn luôn (thà log lớn hơn chút, cũng không mất).

### 11. Khác
- Thêm fixture kiểm thử "APK tổng hợp" (`test/lib/make-apk.js`): tự tạo manifest AXML nhị phân +
  biểu tượng PNG + thư mục ABI, khi thiếu fixture APK thật thì ngăn xếp phân tích vẫn được bao phủ;
- Thêm/mở rộng ca hồi quy: Zip64, gói tách .xapk, materializeImages,
  chọn tài sản cập nhật, chẩn đoán `0xC0000005`, biên log, ghi bản ghi thất bại xuống đĩa, hạ cấp biểu tượng WebP;
- `npm test` tăng từ 98 lên **113 mục, tất cả xanh**.

## Nhật ký kiểm chứng

| Hạng mục | Kết quả |
|---|---|
| `npm test` | 113 đạt / 0 lỗi (8 + 25 + 80) |
| `electron test/electron-integration.js` | ICO / .lnk / hạ cấp WebP đều đạt |
| Khởi động nguội thật | Sẵn sàng sau 25.0s (`sys.boot_completed=1`) |
| Trúng snapshot | 5~6s |
| Tắt máy êm | `code=0`, `hasSnapshot=true` |
| Phân tích APK thật | Hongguo Short Drama (红果短剧) 7.4.3.32 / `res/b/a3.webp` / arm64-v8a chính xác |
| Phân tích APK 2.15GB | Xong trong 18ms, RSS tiến trình 47MB (bản cũ phải đọc cả 2.2GB vào bộ nhớ) |
| Cài mới + khởi động từ biểu tượng | Cài lại Hongguo rồi bấm biểu tượng: `mCurrentFocus` = `com.phoenix.read/...SplashActivity`, trong cửa sổ là giao diện ứng dụng (trước khi sửa là màn hình chính Android) |
| Tự kiểm tra runtime `npm run selftest -- --apk` | **13 mục đều đạt**: adb / engine / ảnh / AEHD, Android 14 API34, freeform, đồng bộ hai chiều thư mục chia sẻ, phân tích→cài đặt→khởi động cửa sổ độc lập→chụp màn hình |
| `tools/check-launch-clean.js` | Suốt quá trình cài + mở: cửa sổ ứng dụng **xuất hiện sau 0.5 giây**, cửa sổ trình giả lập/console xuất hiện tổng cộng **0 lần** |
| Chuỗi cài đặt | Kéo APK 153MB vào bản đóng gói: phân tích/cài đặt/biểu tượng/lối tắt xong trong 22s; Target/Args/Icon của .lnk trên màn hình + menu Start đều đúng |
| Không rò rỉ cửa sổ | `check-quit-clean`: suốt quá trình khởi động + 8 giây sau khi thoát, cửa sổ trình giả lập/console hiển thị **0 cái** |
| Liên kết registry | Liên kết gốc trên máy `MuMuPlayer.apk`, đăng ký→hủy xong được khôi phục nguyên trạng |
| Bản đóng gói | Gói portable 226MB, smoke test giao diện đạt |

## Hạn chế đã biết

- **Nguyên nhân gốc** của `0xC0000005` vẫn nằm ở phía driver card đồ họa / backend Vulkan, phiên bản này làm được là
  "tự đổi backend + ghi rõ nguyên nhân"; nếu máy nào vẫn chắc chắn crash, chỉ cần gửi báo cáo chẩn đoán mới là định vị được.
- Phân tích biểu tượng vẫn chưa hỗ trợ drawable `shape`/vector (sẽ dùng ảnh giữ chỗ, và thông báo đúng sự thật).
- Liên kết `.apk` được ghi vào HKCU (không cần quản trị); nếu trong hệ thống có chương trình khác liên tục giành lại liên kết,
  thì lấy thiết lập "Ứng dụng mặc định" của hệ thống làm chuẩn.
