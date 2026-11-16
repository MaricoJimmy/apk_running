# Kiến trúc

## Phân lớp

```
┌──────────────────────────────────────────────────────────────────────┐
│ Lớp hiển thị  src/ui (HTML/CSS/JS)  ←→  preload (contextBridge)      │
├──────────────────────────────────────────────────────────────────────┤
│ Lớp điều phối  src/main.js (cửa sổ/khay hệ thống/phân phối CLI)      │
│                installer.js (pipeline cài đặt)                       │
├──────────────────────────────────────────────────────────────────────┤
│ Lớp miền  engine.js (vòng đời runtime/dò tìm/thu hồi khi rảnh)       │
│           adb.js (thao tác thiết bị)  sharer.js (trao đổi tệp)       │
├──────────────────────────────────────────────────────────────────────┤
│ Phân tích ngoại tuyến  zip.js → axml.js / arsc.js → apk.js           │
│                        png.js / shortcut.js (biểu tượng và lối tắt)  │
├──────────────────────────────────────────────────────────────────────┤
│ Lớp thích ứng engine  QEMU đi kèm (WHPX/TCG) │ Nhập ảnh hệ thống │   │
│                       Runtime có sẵn (tùy chọn)                      │
└──────────────────────────────────────────────────────────────────────┘
```

## Các luồng chính

### 1. Nhấp đúp APK để cài đặt

```
Nhấp đúp .apk trong Explorer
  → HKCU\Software\Classes\ApkStart.apk\shell\open\command
  → ApkStart.exe "C:\...\xxx.apk"
  → main.js parseArgs → runInstall
      1. apk.js: phân tích ngoại tuyến (zip → manifest AXML → arsc khôi phục label/icon)
      2. engine.ensure(): nếu runtime chưa sẵn sàng thì tự động khởi chạy/dò tìm
      3. adb install -r -g -t
      4. Biểu tượng → PNG (icons/) + ICO nhiều kích thước (icons/*.ico)
      5. shell.writeShortcutLink tạo .lnk trên desktop (--launch <pkg>)
      6. store.upsertApp ghi lại siêu dữ liệu
```

### 2. Khởi chạy từ biểu tượng desktop (trải nghiệm như ứng dụng gốc)

```
Nhấp đúp <tên ứng dụng>.lnk
  → ApkStart.exe --launch <pkg>
  → Khóa đơn phiên bản gộp vào phiên bản đang chạy (hoặc âm thầm khởi chạy phiên bản mới)
  → adb am start --windowingMode 5 -n <pkg>/<activity>
  → Cửa sổ freeform độc lập
  → Cửa sổ lớp vỏ tự động ẩn/thoát, không để lại giao diện thừa
```

### 3. Trao đổi dữ liệu

```
Máy tính %USERPROFILE%\ApkStartShared  ⇄  Android /sdcard/ApkStartShared
  Đồng bộ hai chiều tăng dần (so sánh mtime+size), thăm dò mỗi 8s + kích hoạt bởi các thao tác quan trọng
```

## Vì sao không dùng thư viện có sẵn

| Nhu cầu | Cách làm thông thường | Cách làm của ApkStart | Lý do |
|---|---|---|---|
| Đọc siêu dữ liệu APK | aapt2 / apk-parser | Tự viết zip+AXML+ARSC | Không phụ thuộc, không phải cài SDK, khởi động không cần tiến trình ngoài |
| Chuyển biểu tượng sang ICO | ImageMagick/sharp | Thu phóng bằng nativeImage + tự viết container ICO | Tránh phụ thuộc native 80MB |
| Liên kết tệp | Trình cài đặt ghi HKLM | HKCU + SHChangeNotify | Không cần quyền quản trị, có thể bật/tắt bất cứ lúc nào trong cài đặt |
| Trình giả lập | Đóng gói cả bộ VirtualBox | Lớp thích ứng engine | Tái sử dụng runtime có sẵn với chi phí bằng 0; nhánh QEMU giữ lại phương án ảnh hệ thống có thể kiểm soát |

## Thiết kế độ ổn định

- Mọi lệnh gọi adb đều có timeout và chuẩn hóa lỗi (AdbError).
- Việc dò tìm runtime chạy song song, timeout 4s, thất bại thì tự động hạ cấp.
- Watchdog nhàn rỗi của QEMU: chỉ thu hồi khi không có ứng dụng tiền cảnh và đã quá số phút cài đặt; có ứng dụng đang chạy thì không bao giờ thu hồi.
- Ghi cài đặt/danh sách ứng dụng dùng cách ghi nguyên tử tmp+rename.

## Mô hình container cấp ứng dụng (hiệu năng)

### Ranh giới với "container thật"

Huawei Zhuoyitong (华为卓易通) / WSA / Anbox thuộc loại **container hoặc lớp tương thích**: nhân của máy chủ được dùng chung với guest,
dịch vụ hệ thống được khởi chạy theo nhu cầu, về lý thuyết có thể chỉ nạp vài dịch vụ mà một App cụ thể phụ thuộc.
Nền tảng của ApkStart là Google Android Emulator (ảo hóa toàn hệ thống bằng QEMU),
nhân Linux, zygote, system_server bắt buộc phải được khởi động trọn gói một lần, **không thể "chỉ nạp các dịch vụ hệ thống
mà một App cần"**, điều này không thể lách qua bằng mã ở tầng trên.

Nhưng cảm giác "nặng" của người dùng không đến từ các dịch vụ thường trú này, mà đến từ bốn việc khác.
Giải quyết được chúng, về trải nghiệm sẽ tương đương với "mỗi lần chỉ mở môi trường mà App cần":

| Gánh nặng thực sự | Cách xử lý | Vị trí cài đặt |
| --- | --- | --- |
| Mỗi lần mở một App lại khởi động lại toàn bộ Android (40~142s, CPU/đĩa chạy hết công suất) | Môi trường chỉ khởi động một lần rồi thường trú; qemu detached vẫn sống sau khi ApkStart thoát, lần sau `adoptExisting()` tiếp quản + snapshot quickboot, bấm mở chỉ cần `am start` + gắn cửa sổ | `engine.js` / `emulator.js` |
| Các App đã mở trước đó đều nằm lại ở nền ngốn bộ nhớ, dùng mạng | Khi mở App mới thì `am force-stop` các App người dùng khác; khi đóng cửa sổ cuối cùng thì `am kill-all` + `deviceidle force-idle` | `container.js` / `Runtime.beginApp()` / `endApp()` |
| qemu chạy ở mức ưu tiên Normal, tranh CPU với desktop Windows | Sau khi khởi động hạ xuống `BelowNormal`, khi container ở trạng thái đỗ thì hạ xuống `Idle`; vCPU thu gọn về 1/4 số nhân vật lý (2~3 nhân) | `win/priority.ps1` / `doctor.liteProfile()` |
| Khi không có App, đồng bộ, thông báo, tuần tra cửa sổ vẫn thăm dò hết tốc lực | Đồng bộ tệp và cầu nối thông báo chỉ bật khi có cửa sổ ứng dụng; tuần tra cửa sổ giới hạn trong 8 giây sau khi embed; vòng lặp chính của socket đổi sang thăm dò ngắn 50ms | `main.js` / `win/agent.ps1` |

### Về việc "dịch APK sang x86"

Bước này **không được thực hiện mỗi lần mở**, và cũng đã được tích hợp sẵn:
- Ảnh hệ thống là x86_64, APK x86 gốc chạy trực tiếp;
- APK chỉ có ARM dựa vào native bridge trong ảnh hệ thống (lớp dịch nhị phân ARM→x86
  đi kèm ảnh Google Play), hoàn tất **lúc cài đặt**, khi chạy thì gọi theo nhu cầu;
- Vì vậy ApkStart không cần, và cũng không nên "dịch" lại một lần mỗi khi khởi động.
  "Mỗi lần mở đều dịch" ngược lại là thiết kế chậm nhất.

### Nguyên nhân gốc của trôi chuột / cả máy giật lag (đã sửa)

`win/agent.ps1` từng dùng hook chuột cấp thấp toàn cục `WH_MOUSE_LL` để làm "nút bên để quay lại",
nhưng lại cài nó trên luồng dịch vụ cửa sổ đồng thời bị chặn ở `sock.Poll(4000)`.
Mỗi sự kiện chuột của Windows đều phải chờ đồng bộ luồng này trả về, lâu nhất 4 giây;
đóng cửa sổ cũng không gỡ, chỉ cần ApkStart còn sống là toàn hệ thống bị kéo chậm.
Cộng thêm đỉnh I/O khởi tạo lần đầu của giải nén `.xz` / `e2fsck` / `resize2fs`,
tiền cảnh gần như không giành được tài nguyên.

Cách sửa:
- Hook không còn thường trú vô điều kiện: chỉ cài trên **luồng thông điệp chuyên dụng** (vòng lặp `GetMessage`), và chỉ cài khi
  cửa sổ ứng dụng đang ở tiền cảnh và ít nhất một ánh xạ chuột được bật; mất tiêu điểm/đóng thì gỡ ngay; callback chỉ xử lý
  7 thông điệp mục tiêu, phần còn lại (gồm mọi sự kiện chuột trái) cho qua thẳng bằng một lần `CallNextHookEx`;
- Vòng lặp chính của dịch vụ `Poll(4000)` → `Poll(50)`;
- `EnumWindows` + `SetWindowPos(SWP_FRAMECHANGED)` đổi từ "mỗi 2 giây, vĩnh viễn" thành
  "trong 8 giây sau khi embed, và không còn ép tính lại vùng non-client";
- Lần triển khai đầu tiên được hoãn 20 giây, tránh tranh I/O với khởi động nguội.

### Phím chuột (chuột trái xác nhận / chuột phải quay lại / con lăn cuộn)

Bên trong cửa sổ ứng dụng là cửa sổ con Qt của trình giả lập, ánh xạ gốc như sau:

| Đầu vào | Hành vi gốc của Qt | Cách xử lý của ApkStart |
| --- | --- | --- |
| Chuột trái | Chạm ngón tay / giữ kéo = vuốt | **Hoàn toàn không chặn**, cho qua trực tiếp; đây chính là "xác nhận" |
| Chuột phải | Cũng bị coi là một lần chạm, dễ bấm nhầm | Chặn `WM_RBUTTONDOWN/UP/DBLCLK`, gửi `input keyevent 4` (quay lại) |
| Con lăn | Mỗi nấc gửi riêng một sự kiện chạm, hình ảnh giật cục | Chặn `WM_MOUSEWHEEL/MOUSEHWHEEL`, gộp theo cửa sổ 60~90ms thành một lệnh `input swipe` |
| Nút bên | Không có | Tùy chọn: ánh xạ thành quay lại / tiến tới (mặc định tắt) |

Việc gộp con lăn diễn ra trong `win/agent.ps1` (`PushWheel` / `FlushWheel`), việc chuyển đổi diễn ra trong
`core/pointer.js` (`WheelRouter` → `wheelToSwipe`). Việc chèn sự kiện đi qua **`adb shell` thường trú** của `AdbClient.input()`,
dùng `echo __APKSTART_<id>__` để làm gói phản hồi và back-pressure,
không phải mỗi nấc cuộn lại `execFile` một tiến trình adb, cũng không để lệnh vuốt xếp hàng dài trong shell.
Tọa độ được ánh xạ theo vị trí chuẩn hóa của con trỏ trong LCD, cuộn ngang tạo thao tác vuốt ngang, sau khi xoay màn hình tự động làm mới độ phân giải.

Hook chỉ được cài khi cửa sổ ứng dụng ở tiền cảnh, chuyển về desktop hoặc đóng cửa sổ là gỡ; tắt cả ba mục chuột phải quay lại, con lăn mượt,
nút bên thì không cài bất kỳ hook toàn cục nào.

### Các mục có thể cấu hình (Cài đặt → Phím chuột / Hiệu năng và container nhẹ)

| Mục | Mặc định | Mô tả |
| --- | --- | --- |
| `engine.mouseRightBack` | `true` | Chuột phải = nút quay lại của Android; tắt thì khôi phục hành vi "chuột phải cũng là chạm" của Qt |
| `engine.mouseWheelMode` | `smooth` | `smooth` gộp rồi chèn / `native` giao cho Qt xử lý từng nấc / `off` không chặn |
| `engine.mouseSideButtons` | `false` | Nút bên quay lại / tiến tới; khi cả ba mục đều tắt thì không cài hook toàn cục |
| `engine.liteMode` | `true` | Thu gọn hạn mức vCPU; tắt đi thì tự động phân bổ nhiều nhân hơn theo cấu hình máy |
| `engine.priorityMode` | `balanced` | Khi là `performance`, qemu dùng mức ưu tiên Normal |
| `engine.deepTrim` | `false` | `pm disable-user` thêm một loạt gói nền của hệ thống; khi tắt sẽ tự động `pm enable` để khôi phục |

Cắt tỉa sâu cố ý không đụng tới các thành phần thiết yếu như `gms` / `systemui` / webview / bộ gõ
(xem `container.NEVER_TRIM`), tránh việc các App phụ thuộc thông báo đẩy và đăng nhập liên tục báo lỗi.

### Vòng đời của một phiên

```
Khởi động nguội (chỉ lần đầu, hoặc sau khi AVD bị xóa)
  materializeImages → e2fsck/resize2fs → boot_completed → saveSnapshot
        ↓
Mở App A: ensure() tiếp quản môi trường thường trú → am start A → gắn cửa sổ
            → beginApp(A): dừng các App người dùng khác, nâng mức ưu tiên, bật đồng bộ/thông báo
        ↓
Chuyển sang App B: beginApp(B) → am start B (không khởi động lại Android)
        ↓
Đóng cửa sổ cuối cùng: endApp() → force-stop → am kill-all → deviceidle
            → qemu hạ xuống Idle → dừng đồng bộ/thông báo (container ở trạng thái đỗ, không tắt máy)
        ↓
Nhàn rỗi quá idleShutdownMinutes: watchdog tắt runtime
(trước đây phiên bản được tiếp quản không thể thu hồi vì không có handle proc cục bộ, đã sửa)
```
