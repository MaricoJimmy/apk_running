; Script NSIS tùy chỉnh của ApkStart
; Tác dụng: trước khi bắt đầu gỡ cài đặt, kết thúc các tiến trình runtime có thể vẫn còn chạy ngầm,
; nếu không chúng sẽ khóa các file trong thư mục cài đặt, khiến gỡ không sạch và công cụ hủy file bên thứ ba cũng không xóa được.
;
; Sau khi ApkStart thoát vẫn có thể để lại qemu ở chế độ detached (để lần sau mở tức thì),
; nên bước gỡ cài đặt phải tự dọn dẹp thêm một lượt.

; Kết thúc cài đặt: tạo lại biểu tượng desktop thêm một lớp dự phòng.
; createDesktopShortcut của electron-builder chạy theo quy trình CreateShortcuts riêng của nó,
; trong một số môi trường (desktop bị OneDrive chuyển hướng, shortcut bị phần mềm bảo mật khôi phục) sẽ tạo thất bại,
; người dùng cài xong thấy desktop trống trơn. Ở đây dùng CreateShortcut gốc của NSIS để ghi lại một lần nữa:
; $DESKTOP đi qua SHGetFolderPath, theo đúng đường dẫn đã chuyển hướng của desktop; thao tác mang tính lũy đẳng,
; chạy trùng với electron-builder cũng chỉ ghi đè cùng một file .lnk.
!macro customInstall
  DetailPrint "Đang tạo shortcut trên desktop…"
  CreateShortcut "$DESKTOP\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — Chạy ứng dụng Android trực tiếp trên máy tính"
  CreateDirectory "$SMPROGRAMS\ApkStart"
  CreateShortcut "$SMPROGRAMS\ApkStart\ApkStart.lnk" "$INSTDIR\ApkStart.exe" "" "$INSTDIR\ApkStart.exe" 0 \
    SW_SHOWNORMAL "" "ApkStart — Chạy ứng dụng Android trực tiếp trên máy tính"
!macroend

!macro customUnInstall
  ; Xóa trước các shortcut do chính script này tạo (khi ApkStart chưa được cài cũng không được để sót)
  Delete "$DESKTOP\ApkStart.lnk"
  Delete "$SMPROGRAMS\ApkStart\ApkStart.lnk"
  RMDir "$SMPROGRAMS\ApkStart"

  DetailPrint "Đang kết thúc các tiến trình ApkStart còn sót lại…"
  ; /F buộc dừng, /T kèm cả tiến trình con. Khi tiến trình không tồn tại, taskkill trả về 128, bỏ qua là được.
  nsExec::Exec 'taskkill.exe /F /T /IM ApkStart.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-x86_64.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM qemu-system-i386.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM emulator-check.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM adb.exe'
  nsExec::Exec 'taskkill.exe /F /T /IM netsimd.exe'
  ; Chờ một chút để tiến trình thực sự thoát và giải phóng handle file
  Sleep 1500
!macroend
