# Thư mục engine runtime (đặt thủ công, tùy chọn)

**Từ bản 0.2, ApkStart mặc định hoàn toàn tự chủ**: adb, QEMU và ảnh hệ thống được ứng dụng tự động tải về và triển khai vào
`%APPDATA%\apkstart\runtime\`, không cần chuẩn bị thủ công bất cứ thứ gì.

Thư mục này chỉ dùng cho hai trường hợp sau:

## 1. Đặt QEMU thủ công (nguồn tải bị chặn / muốn dùng phiên bản cụ thể)

```
engine/qemu/
├─ qemu-system-x86_64.exe
├─ qemu-img.exe
└─ …(các tệp QEMU còn lại)
```

Địa chỉ bản build Windows chính thức của QEMU: https://qemu.weilnetz.de/w64/
(`qemu-w64-setup-*.exe` là gói cài đặt NSIS, ApkStart sẽ dùng `/S /D=` để cài im lặng vào thư mục runtime;
bạn cũng có thể dùng 7-Zip giải nén trực tiếp gói cài đặt rồi đặt vào vị trí ở trên)

## 2. Đặt adb thủ công

```
tools/platform-tools/
└─ adb.exe
```

Địa chỉ tải: https://developer.android.com/tools/releases/platform-tools

## Ảnh hệ thống

- Khuyến nghị: Android-x86 9.0-r2 (x86_64), có thể tải trực tiếp trong ứng dụng (nhiều ảnh, hỗ trợ tải tiếp khi bị ngắt)
- Hoặc nhập: bất kỳ ảnh đĩa nào đã cài sẵn Android (qcow2 / raw / vmdk), chọn ở "Runtime → Nhập"
- Sau khi nhập, ApkStart khởi động trực tiếp từ đĩa, không cần bước cài đặt

## Tăng tốc phần cứng

QEMU dùng tăng tốc WHPX: Control Panel → "Turn Windows features on or off" (Bật hoặc tắt tính năng Windows) → tích chọn "Virtual Machine Platform" (Nền tảng máy ảo) → khởi động lại.
Khi chưa bật, ApkStart tự động chuyển về giả lập thuần phần mềm (TCG), lần khởi động đầu sẽ khá chậm.
