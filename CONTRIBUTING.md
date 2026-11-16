# Hướng dẫn đóng góp

Hoan nghênh mọi Issue và Pull Request. Nguyên tắc của dự án này là **lớp vỏ không phụ thuộc thư viện ngoài, hành vi có thể dự đoán được**, vì vậy hãy đọc qua các quy ước dưới đây trước.

## Môi trường phát triển

- Windows 10/11 x64
- Node.js ≥ 20
- `npm install && npm start`

## Tự kiểm tra trước khi gửi

```powershell
npm test          # Unit test thuần Node + test luồng engine (không cần mạng, không cần máy ảo)
```

Khi có thay đổi giao diện, nên chạy thêm một lần chụp ảnh smoke test để xác nhận bố cục không bị vỡ:

```powershell
electron . --smoke test\shot.png
```

## Quy ước mã nguồn

- **Lớp vỏ không đưa vào phụ thuộc runtime của bên thứ ba**. Các phần phân tích ZIP / AXML / ARSC / PNG / ICO trong `src/core/` đều được viết tay;
  khi thêm tính năng, hãy ưu tiên cân nhắc "có thể viết xong chỉ bằng module có sẵn của Node không", tránh kéo cả một gói lớn vào chỉ vì một tính năng nhỏ.
- Lớp render dùng HTML/CSS/JS thuần, không dùng framework front-end.
- Mọi tương tác với phía Android đều đi qua `src/core/adb.js`, không tự ghép lệnh adb rải rác ở nhiều nơi.
- Tiến trình chính và tiến trình render chỉ giao tiếp qua các kênh trong danh sách trắng do `preload.js` cung cấp, luôn bật `contextIsolation`.
- Chú thích và văn bản giao diện dùng tiếng Việt, định danh dùng tiếng Anh.

## Quy ước kiểm thử

- Khi không có APK thật, test sẽ tự bỏ qua phần phân tích APK; để bao phủ phần này, hãy đặt biến môi trường trỏ tới một APK bất kỳ:

```powershell
$env:APKSTART_TEST_APK="C:\path\to\any.apk"; npm test
```

- Không truy cập mạng ngoài trong test. Test nào cần hành vi mạng thì hãy dựng một dịch vụ `http` cục bộ (tham khảo `test/engine-test.js`).

## Thông điệp commit

Dùng phong cách Conventional Commits, ví dụ:

```
feat(engine): hỗ trợ nhập đĩa qcow2 từ đường dẫn tùy chỉnh
fix(axml): sửa offset địa chỉ cơ sở của bảng thuộc tính
docs: bổ sung hướng dẫn bật WHPX
```

## Pháp lý và phạm vi

- Dự án này không phân phối bất kỳ ảnh hệ thống Android, tệp nhị phân QEMU hay thành phần Google nào; tất cả đều do máy người dùng tự tải về khi cần.
- Vui lòng không commit APK thương mại, công cụ crack hay bất kỳ nội dung nào vi phạm bản quyền của bên thứ ba vào kho mã.
