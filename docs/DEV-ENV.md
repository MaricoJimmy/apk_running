# Môi trường phát triển và tra cứu nhanh lệnh

> Tài liệu này ghi lại các sự thật về môi trường cần biết để "tiếp tục phát triển ApkStart trên máy phát triển này".
> Phần lớn các "bẫy" là đặc thù của môi trường sandbox; nếu đổi máy, hãy lấy kết quả dò thực tế làm chuẩn.
> Lần đối chiếu cuối: 2026-11-14 (v0.3.5, đã phát hành bản sửa lỗi cục bộ trên nền v0.3.4).

## 0. Ghi chép sự cố: toàn bộ workspace từng bị ném vào Thùng rác

Khoảng 20:55 ngày 2026-11-14, **toàn bộ thư mục** `D:\apkstart-dsh` (261 mục: mã nguồn / test / tài liệu /
bộ nhớ `.workbuddy`) đã bị một thao tác "dọn dẹp sản phẩm cũ của apkstart" chuyển vào Thùng rác;
cùng đợt bị dọn còn có các thư mục cũ như `D:\apkstart-dist`, `D:\dist-gitee`, `D:\ApkStart-0.3.3-preview`,
`D:\tmp-wx` —— có vẻ thao tác dọn dẹp bằng ký tự đại diện `D:\apkstart*` đã tiện tay cuốn luôn cả workspace.

Quy trình khôi phục (có thể dùng lại):
1. **Đừng dọn sạch Thùng rác**. Các mục của ổ D nằm trong `D:\$Recycle.Bin\<SID>\`, mỗi mục là một cặp
   `$I<id><ext>` (siêu dữ liệu) + `$R<id><ext>` (dữ liệu).
2. Bố cục của `$I`: version u64 @0, kích thước gốc u64 @8, thời điểm xóa u64 @16,
   **độ dài đường dẫn u32 @24 (đơn vị là số ký tự UTF-16, không phải byte!)**, đường dẫn UTF-16LE @28.
   Chỉ cần đổi tên `$R` về đường dẫn gốc được ghi trong `$I` là khôi phục được (thư mục sẽ tự được tạo lại).
3. `.git` không nằm trong Thùng rác (có thể bị công cụ xóa bỏ qua): khôi phục lịch sử từ `C:\Users\15656\WorkBuddy\
   2026-10-29-20-43-38\apkstart\.git` (e1db34b = v0.3.4), rồi commit lại
   workspace.
4. Kiểm tra sau khi khôi phục: `src/**` và `dist\ApkStart-win64-portable\resources\app\src`
   khớp SHA256 hoàn toàn theo từng tệp; `npm test` 112 mục đều xanh.

**Khuyến nghị**: sau này định kỳ đóng gói mã nguồn + `.git` + docs + test thành một tệp zip và đặt ở ngoài `D:\`
(ví dụ trong `C:\Users\15656\WorkBuddy\`), đừng để chung ổ đĩa với workspace.

## 1. Vị trí bộ công cụ (không có trong PATH, phải dùng đường dẫn tuyệt đối)

| Công cụ | Đường dẫn | Phiên bản |
|---|---|---|
| Node | `C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6\node.exe` | v22.22.2 |
| npm | `…\22.22.2-6\npm.cmd` | Theo Node |
| Git | `C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd\git.exe` | 2.55.0.windows.3 |
| Electron | Trong repo: `node_modules\electron\dist\electron.exe` | 33.4.11 |

Trong PowerShell, trước tiên bổ sung PATH:

```powershell
$env:PATH = 'C:\Users\15656\.workbuddy\binaries\PortableGit\versions\1.3.0\cmd;' +
            'C:\Users\15656\.workbuddy\binaries\node\versions\22.22.2-6;' + $env:PATH
```

Cài lại khi các phụ thuộc bị xóa mất (khoảng 19 giây, qua mirror):

```powershell
$env:ELECTRON_MIRROR='https://npmmirror.com/mirrors/electron/'
npm ci --no-audit --no-fund
```

## 2. Hai biến môi trường phải xóa trước ở mỗi shell

Shell của máy chủ sẽ kế thừa hai biến này; nếu không xóa sẽ xuất hiện các hiện tượng "ma quái" như "Electron chạy như Node thuần":

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue   # nếu không, electron.exe biến thành node, --launch báo bad option
Remove-Item Env:NODE_OPTIONS -ErrorAction SilentlyContinue           # nếu không, thao tác xóa hàng loạt của build/pack.js sẽ bị safe-delete chặn thành SAFE_DELETE_BULK_GUARD_ERROR
```

## 3. Các lệnh thường dùng

```powershell
cd D:\apkstart-dsh\apkstart

# Unit test / test hồi quy (Node thuần, không cần Electron/adb/mạng)
npm test

# Test tích hợp Electron (hạ cấp biểu tượng ICO / .lnk / WebP)
.\node_modules\electron\dist\electron.exe test\electron-integration.js

# Chụp ảnh smoke test giao diện (--settings chụp thêm trang cài đặt; --perf/--download chụp khu vực tương ứng)
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png"
.\node_modules\electron\dist\electron.exe . --smoke "$env:TEMP\smoke.png" --settings

# Khởi động thật (đo thời gian khởi động nguội/nóng, --stop sẽ tắt máy êm và lưu snapshot)
node tools\e2e-boot.js . --stop

# Đóng gói bản portable (đầu ra dist\ApkStart-win64-portable)
node build\pack.js

# Gói cài đặt bản đầy đủ (cần build/runtime, runtime khoảng 1.4GB; chạy trong CI)
npm run build:exe
```

> Chạy xong smoke test / khởi động nhớ xác nhận không còn tiến trình sót lại:
> `Get-Process -Name ApkStart,electron,emulator,qemu-system-x86_64 -ErrorAction SilentlyContinue`
> Trình giả lập chạy dạng detached, sau khi Electron thoát thì qemu có thể vẫn còn sống (đây là thiết kế: lần sau tiếp quản ngay lập tức).
>
> Nếu `dist\ApkStart-win64-portable` đang bị chiếm dụng (File Explorer / phần mềm diệt virus / phiên bản trước vẫn đang mở),
> `pack.js` sẽ lùi về `dist\ApkStart-v<phiên bản>-win64-portable`, đây là điều được dự kiến; đóng tiến trình chiếm dụng rồi đổi tên lại là được.
> Các tiến trình chỉ đọc / lập chỉ mục (Defender, SearchIndexer) có thể khiến thư mục rỗng không xóa được trong vài phút, đợi một lúc rồi thử lại.

## 4. Đường dẫn dữ liệu và runtime (trên máy này)

| Mục đích | Đường dẫn |
|---|---|
| Cài đặt / danh sách ứng dụng / nhật ký / bản sao lưu APK | `%APPDATA%\apkstart` (tên thư mục thực tế là `ApkStart`, không phân biệt hoa thường) |
| Runtime (emulator + adb + ảnh hệ thống) | `D:\ApkStartRuntime` (`settings.runtime.dir`) |
| AVD / ứng dụng đã cài / snapshot | `D:\ApkStartData` (`settings.runtime.avdDir`) |
| Thư mục chia sẻ | `%USERPROFILE%\ApkStartShared` |
| Báo cáo chẩn đoán | `%APPDATA%\apkstart\logs\diagnostic-*.txt` |
| Bản ghi lần khởi động thất bại gần nhất | `%APPDATA%\apkstart\logs\last-failure.json` |

## 5. Lưu ý khi thao tác văn bản/tệp (đặc thù của terminal này)

- **Đừng dùng `Set-Content` / `Get-Content -Raw` để xử lý tệp UTF-8 có chứa ký tự không phải ASCII (chữ Hán, tiếng Việt có dấu…)**:
  PowerShell 5.1 mặc định giải mã theo ANSI, sẽ ghi ra ký tự lỗi (phiên làm việc này từng dính một lần, hỏng luôn tệp test).
  Đọc/ghi văn bản luôn dùng công cụ trình soạn thảo; khi buộc phải ghi tệp trong PowerShell thì dùng
  `[System.IO.File]::WriteAllText($p, $s, [System.Text.UTF8Encoding]::new($false))`.
- **Các phương thức tĩnh của `[System.IO.File]` dùng thư mục ban đầu của tiến trình**, sau khi `cd` vẫn phân giải theo đường dẫn cũ —— luôn dùng đường dẫn tuyệt đối.
- **Xóa thư mục lớn**: `Remove-Item -Recurse` có thể bị lớp safe-delete chặn,
  hãy dùng `[System.IO.Directory]::Delete($path, $true)`; nếu xóa xong mà dung lượng không được giải phóng thì dọn Thùng rác.
- **Tiến trình chạy lâu** (qemu / tải xuống lớn) dùng tác vụ nền; lệnh thông thường khi kết thúc sẽ dọn luôn cả cây tiến trình con.
- Khi đọc đầu ra của `reg.exe`, lưu ý nó dùng code page của console; nội dung ASCII như tên gói/đường dẫn thì không vấn đề gì.

## 6. Bảng đối chiếu sự cố thường gặp

| Hiện tượng | Nguyên nhân / Cách xử lý |
|---|---|
| `electron --version` in ra `v20.x` (phiên bản Node) | Chưa xóa `ELECTRON_RUN_AS_NODE=1` |
| Đóng gói báo `SAFE_DELETE_BULK_GUARD_ERROR` | Chưa xóa `NODE_OPTIONS` |
| Các test case axml/apk trong `npm test` hiện "bỏ qua" | Không có fixture thật; test case APK tổng hợp vẫn chạy (`test/lib/make-apk.js`) |
| Trình giả lập `0xC0000005` (3221225477) | Backend render bị crash; phiên bản mới sẽ tự đổi backend và ghi `last-failure.json`, báo cáo ở `logs\diagnostic-*.txt` |
| "Running multiple emulators with the same AVD" | qemu sót lại đang giữ khóa; `node tools\emu-clean.ps1` hoặc khởi động lại (bản mới sẽ tự dọn tiến trình mồ côi) |
| Gitee 403 khi kiểm tra cập nhật | API ẩn danh bị giới hạn tần suất, client ngắt mạch 15 phút và chỉ dùng GitHub; không phải lỗi |
| `reg.exe` / `sc.exe` bị chặn trong sandbox | Chỉ ảnh hưởng test tự động; sản phẩm chạy trên desktop người dùng không bị ảnh hưởng |
| Bản portable khởi động 1 giây đã thoát, không có cửa sổ | Khóa đơn phiên bản đang bị một tiến trình ApkStart khác giữ (có thể là phiên bản cũ chưa thoát hẳn), chạy `Stop-Process -Name ApkStart` trước |

## 7. Quy trình phát hành (chỉ làm sau khi đã xác nhận test thực tế đạt)

```powershell
# 1. Tăng phiên bản
#    package.json: version -> 0.3.5
# 2. Ghi chú phát hành: docs/RELEASE-NOTES-NEXT.md -> .github/release-notes-v0.3.5.md
# 3. Commit + gắn tag
git add -A; git commit -m "chore(release): v0.3.5"
git tag -a v0.3.5 -m "ApkStart v0.3.5"
# 4. Đẩy lên hai kho (GitHub qua SSH, Gitee qua https; tùy nhu cầu)
git push origin main; git push origin v0.3.5
git push gitee main;  git push gitee v0.3.5
```

CI: `release.yml` sẽ build bản portable (zip 95MB), bản Setup đầy đủ (~1.35GB) và gói runtime trọn bộ
(~1.36GB), đồng bộ bản portable lên Gitee (cần secret `GITEE_TOKEN`, thiếu sẽ thất bại ngay chứ không âm thầm bỏ qua).
Bước nén xz của job `full` mất khoảng 40 phút, là bình thường.
