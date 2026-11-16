# adb di động (portable)

Giải nén Android platform-tools vào thư mục này (phải xuất hiện `adb.exe`), ApkStart sẽ ưu tiên dùng nó:

```
tools/platform-tools/
└─ adb.exe
```

Địa chỉ tải: https://developer.android.com/tools/releases/platform-tools

Nếu thư mục này trống, ApkStart sẽ lần lượt thử:

1. Đường dẫn adb được chỉ định thủ công trong Cài đặt
2. Thư mục này
3. `%LOCALAPPDATA%\Android\Sdk\platform-tools\adb.exe`
4. adb đi kèm các trình giả lập phổ biến (LDPlayer / MuMu / BlueStacks)
5. PATH của hệ thống
