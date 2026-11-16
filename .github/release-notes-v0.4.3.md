# ApkStart v0.4.3

> Tóm lại: chuyển hẳn **xoay/toàn màn hình** từ "đổi độ phân giải lúc chạy" sang "đổi kích thước tấm nền vật lý", màn hình ngang cuối cùng đã **thẳng đứng và phủ kín**; đồng thời sửa tình trạng cả máy bị giật, và thêm **chế độ chơi game / độ trễ thấp** (chuẩn bị cho FPS).

## I. Xoay / toàn màn hình: giờ thực sự thẳng đứng và phủ kín

### Vì sao trước đây mãi không đúng

Hình ảnh của trình giả lập đến từ một "tấm nền LCD vật lý", Qt mở cửa sổ theo kích thước tấm nền và dán hình ảnh vào góc trên bên trái. Ba cách làm trước đây đều đi sai đường, và mỗi cách ứng với một hiện tượng trong ảnh chụp màn hình của bạn:

| Cách làm | Kết quả |
|---|---|
| Đổi `wm size` lúc chạy | Chỉ đổi độ phân giải logic của Android, tấm nền vật lý vẫn dọc → hình ảnh **nằm nghiêng 90°**, chỉ chiếm một dải ở góc trên bên trái, tọa độ bấm bị lệch |
| Đổi `wm density` lúc chạy | Kích thước framebuffer không đổi → hình ảnh **không phủ kín**, phóng to xong bên phải trống một mảng lớn |
| `adb emu rotate` | Chỉ xoay nội dung hình ảnh, trong hệ thống vẫn là màn hình dọc |

### Giờ làm thế nào

**Xoay = đổi `hw.lcd.width/height` và khởi động lại trình giả lập** (khoảng 30–60 giây, chỉ xảy ra một lần khi bấm xoay):

- Tấm nền dọc `720x1280`, tấm nền ngang `1280x720`;
- Đồng thời khóa `wm user-rotation` theo hướng (ngang khóa 1, dọc khóa 0) + tắt tự xoay theo cảm biến — khi tấm nền thành ngang mà rotation vẫn là 0 thì hình ảnh sẽ nằm nghiêng;
- Hướng được lưu bền trong Cài đặt, mở lại ApkStart vẫn khởi động theo hướng này;
- **Nút toàn màn hình = chuyển sang ngang**: phóng to cửa sổ + xoay tấm nền vật lý sang ngang, không còn là kéo giãn hình dọc.

### Nhân tiện sửa hai bug thật

1. **`-no-skin` ghi đè `-skin`**: tham số khởi động mang cả hai, `-no-skin` khiến kích thước tấm nền quay về giá trị cũ trong `config.ini` — đây là nguyên nhân trực tiếp của "trong Cài đặt đã chuyển sang ngang mà thực tế vẫn là dọc". Đã bỏ `-no-skin`.
2. **Phóng to xong không phủ kín**: khi Electron phóng to, cửa sổ chủ thành 1936×1048, nhưng lớp kết xuất Chrome bên trong vẫn ở kích thước cũ (đo được 532×984), mà cửa sổ trình giả lập gắn dưới lớp kết xuất nên bị cửa sổ cha cắt xén. Nay Fit sẽ **kéo lớp kết xuất phủ kín vùng client của cửa sổ chủ trước**, rồi mới dán trình giả lập theo kích thước đó; mỗi vòng quét cửa sổ cũng tự phục hồi một lần, kể cả khi mất sự kiện resize của JS cũng khôi phục được.

## II. Giật lag: ba chỗ tiêu tốn khiến cả máy chậm

1. **Tần suất quét cửa sổ**: trước đây trong 90 giây đầu khởi động cứ 120ms lại liệt kê cửa sổ toàn màn hình một lần (một vòng gồm 4 lần `EnumWindows` + truy vấn đường dẫn tiến trình), liên tục ngốn CPU. Nay chuyển thành 250ms trong 10 giây đầu, sau đó **1500ms**; chế độ chơi game giảm tiếp xuống **3000ms**.
2. **Độ ưu tiên của trình giả lập**: balanced mặc định sẽ dìm qemu xuống BelowNormal, đóng ứng dụng xong thậm chí hạ xuống **Idle** (thấp nhất) — Android vì thế rớt khung hình nghiêm trọng. Nay đóng ứng dụng xong không còn vô điều kiện hạ xuống Idle.
3. **Hook chuột toàn cục**: `WH_MOUSE_LL` gọi callback đồng bộ cho mọi sự kiện chuột trên màn hình, làm tăng rõ rệt độ trễ con trỏ. **Ở chế độ chơi game hoàn toàn không cài**.

## III. Mới: chế độ chơi game / độ trễ thấp

Cài đặt → Hiệu năng và tài nguyên → **Độ ưu tiên máy ảo → "Chơi game / độ trễ thấp"**:

- Tiến trình trình giả lập được nâng lên độ ưu tiên **High**, kết xuất và nhập liệu của Android được ưu tiên lấy CPU;
- Tắt hook chuột toàn cục, con trỏ đi theo đường nhập liệu gốc;
- Quét cửa sổ giảm xuống 3000ms, giảm làm phiền phía cửa sổ chủ;
- Chính sách tài nguyên "Mượt" nay cũng vào thẳng chế độ này (ưu tiên video/game).

Cái giá là các chương trình khác trên máy sẽ chậm hơn một chút, nên mặc định vẫn là "Cân bằng".

## IV. Gia cố thêm

- `settings.json` nay chịu được **UTF-8 BOM**. Trước đây tệp hễ có BOM là `JSON.parse` ném lỗi ngay, toàn bộ cấu hình lặng lẽ quay về mặc định — người dùng sẽ thấy "mất hết cài đặt" mà không tìm ra nguyên nhân (chính tôi khi kiểm thử cũng dính phải).
- Thêm kiểm thử hồi quy: màn hình ngang bắt buộc dùng `lcdFor({landscape})`, không được dùng lại `wm size` lúc chạy; chế độ cửa sổ bắt buộc dùng `-skin` và không được mang `-no-skin`; chế độ chơi game bắt buộc là High và không cài hook toàn cục.

## V. Đo thực tế

- `npm test`: **117 mục đều đạt** (8 + 25 + 84).
- Đo màn hình ngang: `wm size` = `Physical size: 1280x720`, `user_rotation=1`, hình ảnh guest **thẳng đứng, bố cục đúng, không viền đen**; phóng to xong vùng client cửa sổ chủ 1920×1032, lớp kết xuất được kéo phủ kín đồng bộ.
- Đo màn hình dọc: `720x1280`, `rotation=0`, hình ảnh thẳng đứng và phủ kín.

## VI. Cách nâng cấp

- Bản portable: giải nén ghi đè, thư mục dữ liệu (mặc định `%APPDATA%\apkstart`) giữ nguyên.
- Bản cài đặt: cài đè trực tiếp.
