## Phiên bản này giải quyết gì

### 1. Mở ApkStart làm mất cửa sổ của WeChat (微信) (và các ứng dụng Qt khác)

Đây là lỗi nghiêm trọng nhất của bản trước. Proxy cửa sổ trước đây nhận diện cửa sổ của mình dựa vào **tên lớp cửa sổ**:

- `FindEmulator()` nhận cửa sổ "có tên lớp chứa `QWindowIcon`" — đây là tên lớp của **mọi cửa sổ cấp cao nhất của Qt**;
- `HideToolWindows()` nhận cửa sổ "có tên lớp chứa `QWindowTool`" — mà menu, bảng biểu tượng cảm xúc,
  cửa sổ nổi nhỏ của Qt dùng chính `QWindowToolSaveBits`;
- Bộ chặn thường trú quét mỗi 120ms, thấy là `ShowWindow(h, 0)`; `embed` / `park` còn `SetParent` lên nó.

WeChat 4.x lại đúng là Qt 6 (trong `Weixin.dll` có chuỗi `QWindowToolSaveBits` / `Qt6`),
tên lớp cửa sổ chính là `Qt51514QWindowIcon` — giống hệt trình giả lập. Thế là xảy ra chuyện "mở ApkStart,
cửa sổ WeChat biến mất / bị nhúng vào ApkStart thành một khối đen".

**So sánh đo thực tế trên cùng một máy** (WeChat 4.1.7.59, cửa sổ chính 296×388):

| Phiên bản | Trạng thái cửa sổ WeChat |
|---|---|
| 0.3.3 | `hidden` sau 3.7 giây khởi động, 74 lần lấy mẫu sau đó đều bị ẩn |
| 0.3.4 | Hai lượt 45 giây / 280 giây đều `visible` suốt, ẩn 0 lần |

**Cách sửa: tên lớp không phải danh tính, đường dẫn tiến trình mới là.**

- Thêm lệnh `scope`: trước khi chặn/nhúng, tiến trình chính gửi xuống "thư mục của chúng ta" (thư mục gốc runtime + thư mục
  `engine` đi kèm gói) và pid của tiến trình chính;
- Mọi phán định cửa sổ đều phải qua `IsOurs(pid)` trước: tệp thực thi của tiến trình phải nằm trong các thư mục này;
- **Không có scope thì không động vào cửa sổ nào** — thà sót một cửa sổ đen, tuyệt đối không giấu cửa sổ của người khác;
- Cửa sổ console đen không còn dùng so khớp mơ hồ kiểu "tiêu đề chứa emulator/qemu/netsim", mà chuyển sang: chuỗi tiến trình cha của conhost
  dẫn được tới thư mục runtime, hoặc tiêu đề có chứa đường dẫn tuyệt đối của thư mục runtime;
- `embed` kiểm tra pid của cửa sổ chủ phải bằng pid tiến trình chính, nếu không thì từ chối (tránh việc handle được tái sử dụng rồi nhúng cửa sổ vào ứng dụng của người khác);
- Trong hook chuột thêm kiểm tra `IsWindow(_host)` và pid cửa sổ chủ, handle hết hiệu lực thì cho qua toàn bộ;
- Xoay màn hình (Ctrl+←/→) chỉ gửi phím toàn cục khi cửa sổ của mình đang ở tiền cảnh, nếu không thì không gửi;
- Sau khi tiến trình proxy được dựng lại sẽ gửi lại scope, nếu không proxy mới sẽ không dám đụng vào gì.

### 2. Trên Gitee cũng có một gói trọn nhấp đúp giải nén được (không còn part1/part2)

- Đổi trình nén: `Compress-Archive` (deflate của .NET) → 7-Zip `-mx=9`, cùng thư mục **105.2MB → 99.8MB**;
- Xóa `d3dcompiler_47.dll` trong gói (từ Windows 8.1, `System32` đã có sẵn DLL cùng tên, đo thực tế kết xuất không khác biệt),
  tiết kiệm thêm 2.1MB; giữ lại `vk_swiftshader` / `vulkan-1` — dự phòng khi driver GPU không dùng được;
- Cuối cùng còn **95.0 MiB**, trong giới hạn mỗi tệp của Gitee (100MB), tải về giải nén trực tiếp là xong;
- Thêm `build/zip.js`: nén xong dùng chính bộ phân tích zip của ứng dụng để đối chiếu số mục và tổng byte giải nén,
  **vượt 100MiB thì cho CI thất bại luôn** — sau này gói phình ra sẽ nổ ngay tại chỗ, chứ không lặng lẽ quay về gói chia mảnh.

### 3. "Tự chọn nguồn tốt hơn giữa hai nguồn" trước đây thực ra không có tác dụng

Tài sản cùng tên bị loại trùng theo tên, ai đến trước dùng người đó, GitHub xếp trước, **địa chỉ cùng tên của Gitee bị bỏ thẳng**.
Sau khi gói trọn không còn chia mảnh, coi như lúc nào cũng chỉ đi GitHub.

- Tài sản cùng tên chuyển sang gộp `urls`, và ghi `size` riêng theo từng địa chỉ (số byte nén ra ở hai nguồn vốn đã khác nhau);
- Đo tốc độ chọn nguồn tốt nhất trước khi tải; quy tắc "chỉ trộn các nguồn có kích thước khai báo bằng nhau" của `downloadMulti` chuyển sang lấy tổng kích thước
  của **nguồn nhanh nhất** làm chuẩn (trước đây cố định lấy `Math.max`, tức là luôn đi tải nguồn có dung lượng lớn hơn);
- Đo thực tế trên máy này, trong bốn ứng viên (GitHub trực tiếp / ghfast / gh-proxy / Gitee) nhanh nhất là Gitee,
  95.2MB / 48 giây (khoảng 2 MB/s).

### 4. Khác

- Phán định "canh cửa sổ" của proxy chỉ nhận tiến trình trong runtime của chính mình, trình giả lập khác (emulator.exe đi kèm MuMu / LDPlayer (雷电))
  không còn khiến proxy canh thêm 3 phút;
- Các script công cụ (`check-agent` / `check-console` / `check-windows` / `check-launch-clean` /
  `check-quit-clean`) cũng được bổ sung scope tương ứng.

## Nhật ký kiểm chứng

| Hạng mục | Kết quả |
|---|---|
| Kiểm thử đơn vị + tích hợp | run-tests 3 / auto-test **70 đạt, 0 lỗi** |
| Đầu cuối (runtime thật + AVD thật + APK Hongguo (红果)) | Cài → mở → nhúng đều đạt; cửa sổ ứng dụng xuất hiện sau 0.5 giây; tổng số cửa sổ rò rỉ **0** |
| Chạy cùng WeChat (4.1.7.59) | Trong suốt quá trình khởi động trình giả lập / cài ứng dụng / nhúng, cửa sổ WeChat bị hidden **0** lần |
| Gói trọn trên Gitee | 95.18 MiB, `Expand-Archive` giải nén 5.2 giây, md5 của 69 tệp khớp với thư mục nguồn |
| Tải thật từ Gitee | 95.2MB / 48 giây, cấu trúc zip nguyên vẹn |

## Tải về

- Bản nhẹ `ApkStart-v0.3.4-win64-portable.zip` (**95 MB**, giải nén là dùng, lần khởi động đầu mới tải runtime):
  cả GitHub và Gitee đều là **một tệp zip hoàn chỉnh**, không cần ghép mảnh nữa.
- Bản đầy đủ `ApkStart-0.3.4-Setup.exe` (khoảng 1.35 GB, tích hợp adb / trình giả lập / ảnh hệ thống, cài xong dùng ngoại tuyến được):
  dung lượng vượt giới hạn mỗi tệp của Gitee, chỉ có trên GitHub.
