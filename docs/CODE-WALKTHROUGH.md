# Duyệt mã ApkStart (dành cho người tiếp quản phát triển)

> Dành cho kỹ sư **sẽ tiếp tục viết code trên dự án này**. Mục tiêu không phải nhắc lại README mà là trả lời ba câu hỏi:
> **mã được chia thành mấy tầng, mỗi thao tác then chốt thực sự đi qua chuỗi gọi nào, sửa ở đâu dễ dính bẫy nhất**.
>
> Thời điểm tạo: 2026-11-14 · Tương ứng phiên bản **v0.3.5** (phát triển tiếp từ v0.3.4 tại commit `e1db34b`) · Kho mã `RoutineMiku/apkstart`
> Mốc duyệt: `src/**` tổng 41 tệp, khoảng 14.845 dòng (js/html/css/ps1), `npm test` = **70 đạt / 0 lỗi**.
>
> **Cách đọc bộ tài liệu này**
> - Đọc tài liệu này trước (tổng quan + chuỗi gọi then chốt + bản đồ vấn đề, khoảng 360 dòng);
> - Muốn sửa "cài gói / phân tích / biểu tượng / lối tắt" → `CODE-WALKTHROUGH-PARSE.md`;
> - Muốn sửa "tải xuống / triển khai / đổi nguồn / cập nhật trực tuyến / quy tắc đường dẫn" → `CODE-WALKTHROUGH-RUNTIME.md`;
> - Muốn sửa "khởi động máy / nhúng cửa sổ / phím chuột" → mục 2.3~2.6 của tài liệu này + `docs/ARCHITECTURE.md`.

---

## 0. Tóm tắt một trang

| Câu hỏi | Trả lời |
|---|---|
| Đây là gì | "Trình chạy ứng dụng Android" trên Windows: vỏ Electron + runtime Android đi kèm (Google Android Emulator / ảo hóa toàn hệ thống QEMU), cài mỗi ứng dụng Android thành một biểu tượng desktop và mở thành một cửa sổ Windows độc lập |
| Kiến trúc trong một câu | **Tiến trình chính Electron lo điều phối, `core/*` lo năng lực nghiệp vụ, tác tử cửa sổ PowerShell lo việc bẩn Win32, tầng render chỉ làm UI** |
| Không làm gì | Không tự viết hypervisor, không chuyển dịch nhân Linux/GPU, không mount NTFS (thư mục chia sẻ dùng đồng bộ thay thế), không phụ thuộc trình giả lập bên thứ ba |
| Phụ thuộc then chốt | Runtime không có phụ thuộc bên thứ ba, tự viết bộ phân tích (zip/AXML/ARSC/PNG/ICO); chỉ có `@napi-rs/lzma` (giải nén ảnh .xz) + Electron |
| Dữ liệu ở đâu | Dữ liệu mã `%APPDATA%\apkstart` (settings.json / apps.json / icons / apks / logs), runtime `runtime.dir` (đổi ổ được), AVD `runtime.avdDir` (đổi ổ được) |
| Phiên bản lấy từ đâu | `package.json:version`, `app.getVersion()` đọc nó; CI phát hành khi có tag `v*` |

---

## 1. Cấu trúc kho mã

```
apkstart/
├─ src/
│  ├─ main.js                1790 dòng  Tiến trình chính Electron: cửa sổ/khay/đơn thực thể/CLI/IPC/vòng đời
│  ├─ preload.js              130 dòng  Cầu nối an toàn contextBridge (lối vào duy nhất của tầng render)
│  ├─ ui/                            Tầng render (HTML/CSS/JS thuần, không framework)
│  │  ├─ index.html / app.js         Giao diện chính (danh sách ứng dụng + hộp thoại cài đặt), app.js 1490 dòng
│  │  ├─ shell.html / shell.js/css   Vỏ cửa sổ ứng dụng (thanh tiêu đề 38px + lớp phủ khởi động)
│  │  └─ assets/                     logo / appicon.ico / mã QR
│  └─ core/                          Tầng nghiệp vụ (cố gắng là Node thuần, không phụ thuộc Electron)
│     ├─ Điều phối      installer.js engine.js container.js
│     ├─ Runtime        emulator.js provision.js userdata.js doctor.js layers.js
│     ├─ Thiết bị       adb.js android.js sharer.js notify.js display.js
│     ├─ Cửa sổ         appwin.js agent.js win/agent.ps1 win/priority.ps1 windowctl.js pointer.js
│     ├─ Phân tích      zip.js axml.js arsc.js apk.js png.js shortcut.js assoc.js
│     └─ Tải/Cập nhật   download.js sources.js updater.js store.js logfile.js
├─ build/                    Dây chuyền đóng gói (pack.js / prepare-runtime.js / slim-runtime.js / zip.js / seed/)
├─ test/                     run-tests.js(8) + engine-test.js(11) + auto-test.js(53) + nhiều script dò trên máy thật
├─ tools/                    Script phát hành và kiểm tra trên máy thật (publish-gitee.js, check-*.js, e2e-boot.js)
├─ docs/                     ARCHITECTURE.md, images/, promo/, tài liệu này
├─ engine/                   Bộ đệm tải runtime (gitignored, chỉ có README)
└─ .github/workflows/        ci.yml (kiểm thử trên hai bản Node), release.yml (bản portable + bản đầy đủ + đồng bộ Gitee)
```

**Hướng gọi giữa các tầng** (chỉ cho phép tầng trên phụ thuộc tầng dưới):

```
ui/*  ──preload(contextBridge)──▶  main.js
main.js ──▶ installer.js / engine.js / appwin.js / updater.js / sharer.js …
installer.js ──▶ apk.js ──▶ zip.js / axml.js / arsc.js / png.js / shortcut.js
engine.js ──▶ emulator.js ──▶ provision.js(đường dẫn/bảo vệ đĩa) + userdata.js(ext4) + adb.js
appwin.js ──▶ agent.js ──TCP JSON──▶ win/agent.ps1(C# P/Invoke)
Mọi tầng ──▶ store.js (lưu trữ cài đặt/danh sách)
```

---

## 2. Chuỗi gọi then chốt (xem mấy chuỗi này trước khi sửa code)

### 2.1 Nhấp đúp APK → cài xong và tạo biểu tượng desktop

```
Nhấp đúp .apk trong Explorer
 → HKCU\Software\Classes\ApkStart.apk (assoc.js đăng ký, không cần quyền quản trị)
 → ApkStart.exe "C:\x\a.apk"
 → main.js parseArgs() → runInstall(filePath)              main.js:537
     ├ Chống gọi lại: installBusy (nhấp liên tục/kéo nhiều lần chỉ chạy một lần)  main.js:540
     ├ installer.install()                                 installer.js:141
     │   ├ /\.(apks|xapk)$/ → parseBundle() (giải các phần tách ra thư mục tạm) installer.js:26
     │   ├ parseApk()  →  zip.js → axml.js → arsc.js        apk.js:75
     │   ├ isArmOnly(meta) && không có ảnh Play →
     │   │     ensureCompatImage() + switchToCompat()        installer.js:159
     │   └ runtime.ensure()  → xem 2.3
     ├ installer.finishInstall()                            installer.js:179
     │   ├ emulator.invalidateSnapshot() (cài xong thì snapshot cũ vô hiệu)
     │   ├ adb install -r -g -t (lỗi NO_MATCHING_ABIS thì tự chuyển ảnh tương thích rồi thử lại)
     │   ├ Ghi biểu tượng PNG ra đĩa + iconToIco() (WebP giao cho tiến trình render giải mã) main.js:213 decodeIcon
     │   ├ Sao lưu APK vào apks/ (để tự cài lại sau này)
     │   ├ resolveLauncher(): lấy LAUNCHER do hệ thống phân giải làm chuẩn    adb.js
     │   ├ store.upsertApp()
     │   └ createShortcut(): hai tệp .lnk ở desktop + Start Menu        installer.js:286
     └ Thông báo / làm mới bộ đệm biểu tượng của Explorer
```

**Vì sao `resolveLauncher` phải chạy sau khi cài**: "Activity chính" phân tích từ APK thường không phải LAUNCHER thật (Hongguo (红果短剧) là `SplashActivity` chứ không phải `MainFragmentActivity`); dùng sai lối vào sẽ bỏ qua bước khởi tạo → crash sau 3~8 giây. Xem `docs/ARCHITECTURE.md`.

### 2.2 Nhấp đúp biểu tượng desktop → cửa sổ ứng dụng xuất hiện

```
<tên ứng dụng>.lnk → ApkStart.exe --launch <pkg> (lnk do shortcut.js ghi, kèm AppUserModelId)
 → main.js parseArgs() chỉ nhận dạng com.foo.bar              main.js:201
 → Đã có thực thể? second-instance → runLaunch()                 main.js:1477
 → runLaunch(pkg)                                          main.js:606
     ├ openAppWindow(): lập tức mở một cửa sổ chỉ có thanh tiêu đề + lớp phủ khởi động main.js:286
     ├ armAgent(): gửi scope cho tác tử cửa sổ trước và bật "ẩn thường trực"  main.js:1547
     ├ installer.launch()                                  installer.js:385
     │   ├ runtime.ensure() (xem 2.3)
     │   ├ beforeStart → prepareForeground() (toàn màn hình/tắt hiệu ứng/thu màn hình khóa)
     │   ├ Ứng dụng không có trong runtime hiện tại? Tự cài lại từ APK sao lưu        installer.js:404
     │   ├ grantRuntimePermissions()
     │   └ startApp() + staysAlive() (cửa sổ 25s / sống liên tục 4s)
     │        Thất bại thì thử lại 3 lần → pm clear + cấp bù quyền → khởi chạy lại lần nữa
     │        Crash kèm evidence(APP_CRASHED) → tự chuyển ảnh tương thích và làm lại
     ├ appWin.embed(): SetParent nhúng cửa sổ trình giả lập vào        appwin.js:213
     └ runtime.beginApp(pkg): dừng App khác, nâng ưu tiên, bật đồng bộ/thông báo  engine.js:901
```

**Nhúng không phải "chiếu màn hình"**, mà là `SetParent` cửa sổ con Qt của chính trình giả lập vào cửa sổ chủ Electron, rồi `SetWindowPos` theo hình chữ nhật vùng client. Do đó:
- Hình ảnh render gốc, 60fps gốc, chuột bàn phím đi thẳng vào guest;
- Bắt buộc `app.disableHardwareAcceleration()`, nếu không lớp DirectComposition của Chromium sẽ đè lên cửa sổ con (`main.js:72`);
- Khi đóng cửa sổ phải **park trước (SetParent(NULL)+SW_HIDE) rồi mới destroy cửa sổ chủ**, nếu không Windows sẽ gắn lại cửa sổ con lên desktop (`appwin.js:318` / `agent.ps1:990`).

### 2.3 `runtime.ensure()`: một lần khởi động máy thực sự làm gì

`engine.js:796 _ensureInner()`, thử theo thứ tự, **bước nào thành công thì trả về ngay**:

1. `client.isOnline()` → đã có thiết bị trực tuyến: `prepare()` và dùng lại luôn;
2. `adoptExisting()` (`engine.js:708`) → quét cổng các trình giả lập còn sống (`tasklist` + `netstat` tìm cổng lắng nghe của qemu, không đoán 5554), sau `adb kill-server` thì lần lượt `connect` + `getprop sys.boot_completed`, cái nào tiếp quản được thì dùng lại;
3. `adb devices` đã có `emulator-NNNN` → dùng lại;
4. Tiến trình còn nhưng thiết bị offline → `emulator.stop()` rồi làm lại;
5. `engine.mode === 'attach'` → dò các cổng thường dùng của WSA/MuMu/LDPlayer/Nox/MEmu (đường nâng cao);
6. Đường mặc định:
   - `provisioner.materializeImages()` bung ảnh hệ thống `.xz/.gz` (đã bung thì qua ngay);
   - `checkEnv()` kiểm tra adb/emulator/sysimg đã đủ chưa;
   - `killOrphanEmulators()` dọn qemu còn sót (nếu không sẽ FATAL vì khóa AVD);
   - `bootEmulator()` → `emulator.start()` (xem 2.4) → thành công thì `prepare()` (ensureFreeform + watchdog) → sau 20s rảnh thì lưu snapshot.

Lớp ngoài của `ensure()` là **Promise lũy đẳng** (`engine.js:787`): khi khởi động nóng trước và người dùng nhấp xảy ra cùng lúc thì chỉ bật một máy, tránh tranh khóa AVD.

### 2.4 `emulator.start()`: vòng khởi động tự hạ cấp

Lõi của `emulator.js` là "`doctor.planVariants()` sinh tối đa 4 bộ tham số → thử từng bộ → mỗi bộ dùng probe để phán định → tiến trình crash/log chí mạng thì đổi sang bộ tiếp theo":

- Tham số do `doctor.chooseProfile()` suy ra (bộ nhớ/số nhân/LCD/GPU/phân vùng data/cổng); `liteMode` thu vCPU về 1/4 số nhân vật lý (2~3);
- `gpuMode=auto` chọn backend theo phiên bản emulator (37.x dùng `host`, bản cũ `swiftshader_indirect`), dự phòng cuối là `software`;
- `badGpu` ghi nhớ backend "lần trước vừa bật đã crash" (key kèm phiên bản emulator, nâng cấp thì tự mất hiệu lực);
- Mỗi vòng probe chỉ gửi **một** lệnh adb (`getprop sys.boot_completed; pm path android`), lỗi liên tiếp 6 vòng thì tự `resetAdbServer()` để tự phục hồi;
- **Phân vùng `/data` do chính ApkStart tạo** (`userdata.js` + `ensureDataPartition()`, `emulator.js:348`): `userdata.img` trong ảnh chính thức chỉ là chỗ giữ chỗ 1MB toàn số 0; chạy thẳng `emulator.exe` sẽ bỏ qua định dạng → guest rơi vào vòng lặp khởi động lại recovery. Vì vậy lần khởi động đầu sẽ tự viết ext4 block 4KB (kèm `FILETYPE|ENCRYPT`, `ext_attr`), rồi dùng `qemu-img resize` + `resize2fs` đi kèm để nới tới dung lượng cấu hình.

### 2.5 Quy tắc lưu trữ/đường dẫn (issue liên quan đổi ổ đều ở đây)

| Khái niệm | Vị trí mã | Mặc định | Đổi ổ được |
|---|---|---|---|
| Thư mục dữ liệu mã `DATA_DIR` | `store.js:10` | `%APPDATA%\apkstart` | Không (bộ đệm sẽ bị `relocateUserDataIfCrowded()` dời sang ổ AVD khi ổ C chật, `main.js:50`) |
| Gốc runtime `paths().root` | `provision.js` | `DATA_DIR\runtime` | Có: `runtime.dir` |
| Thư mục AVD `paths().avdHome` | `provision.js` | `DATA_DIR\avd` | Có: `runtime.avdDir` |
| Thư mục bung ảnh hệ thống `paths().sysImgRoot` | `provision.js` | `DATA_DIR\system-images` | Theo gốc runtime (**bắt buộc dùng cùng quy tắc với destRoot của `materializeImages`**, từng vì thế mà ổ C chứa hai bản) |
| Thư mục chia sẻ | `store.js:99` | `%USERPROFILE%\ApkStartShared` | Có: `sharedDir` |

### 2.6 Tác tử cửa sổ (`agent.ps1`): vì sao cần nó

`windowsHide` của Node không quản được cửa sổ console `qemu` / `netsimd` do emulator tự tách ra (detached) (cửa sổ thuộc `conhost.exe`, pid không khớp). Vì vậy có một **tiến trình PowerShell thường trực** nhúng C# + P/Invoke, nhận lệnh qua TCP nội bộ, mỗi dòng một JSON:

| Lệnh | Tác dụng |
|---|---|
| `scope {dirs, pid}` | Khai báo "tiến trình trong những thư mục nào mới tính là của chúng ta" + pid tiến trình chính. **Không có scope thì không đụng vào cửa sổ nào** |
| `embed {host,x,y,w,h}` | `SetParent` + `SetWindowPos` nhúng vào cửa sổ chủ; pid cửa sổ chủ không phải tiến trình chính thì từ chối (`host-not-ours`) |
| `fit` | Sắp xếp lại cửa sổ con theo resize/move của cửa sổ chủ |
| `park` | Gỡ ra + giấu đi (bắt buộc làm trước khi hủy cửa sổ chủ) |
| `boothide on/off` | Ẩn thường trực: định kỳ `ShowWindow(0)` cửa sổ chính/thanh công cụ/cửa sổ console đen của trình giả lập, bỏ qua cái đã được nhúng |
| `hook on/off {right,wheel,side}` | Hook chuột toàn cục (chuột phải = quay lại / gộp cuộn / phím bên), **chỉ cài khi cửa sổ ứng dụng ở tiền cảnh, mất focus là gỡ** |
| `rotate` / `hide` / `show` / `probe` / `windows` / `consoles` / `quit` | Các lệnh còn lại |

**Bài học cốt lõi của v0.3.4: tên lớp không phải danh tính, đường dẫn tiến trình mới là.** Bản cũ nhận diện cửa sổ bằng `QWindowIcon`, mà WeChat (微信) 4.x chính là Qt6, tên lớp giống hệt → "mở ApkStart thì cửa sổ WeChat biến mất". Giờ mọi phán định đều qua `IsOurs(pid)` trước (`agent.ps1:168`), cửa sổ console đen đi theo chuỗi tiến trình cha conhost + tiêu đề chứa thư mục scope (`agent.ps1:219`).

---

## 3. Trách nhiệm từng tầng và giao diện then chốt

### 3.1 `main.js` (điều phối ở tiến trình chính)

| Khối | Dòng | Mô tả |
|---|---|---|
| Quyết định trước khi khởi động | 40-72 | `relocateUserDataIfCrowded()` (ổ C chật thì dời bộ đệm), `disableHardwareAcceleration()` |
| Bản đầy đủ tự tiếp quản | 97-171 | Cạnh exe có `runtime/` + bất kỳ ảnh đầy đủ nào → tự ghi `runtime.dir`, bật chế độ tương thích; yêu cầu `sameTree` (chỉ nhận trong cây thư mục EXE lần này), tránh bản portable bị di chuyển rồi vẫn dùng gói cũ |
| Đơn thực thể + tham số | 196-209, 1473-1482 | `--launch <pkg>` / `<path.apk>` / `--autostart`; second-instance chuyển cho thực thể đang chạy |
| Khay hệ thống | 468-530 | Truy cập nhanh 8 ứng dụng đầu, chuyển toàn màn hình, tạo lại lối tắt, kiểm tra cập nhật, thoát |
| Cài đặt gói | 537-573 | `runInstall()`: chống gọi lại + lỗi chỉ hiện thông báo hệ thống một lần |
| Khởi chạy | 606-662 | `runLaunch()`: xem 2.2 |
| Cập nhật | 579-604 | `runUpdate()`: `updater.prepare()` → `apply()` → thoát để script tiếp quản |
| IPC | 702-1469 | Khoảng 120 channel, nhóm theo miền (apps/apk/settings/display/runtime/provision/doctor/android/update/window/shell) |
| Vòng đời | 1484-1790 | Lắp ráp mọi đối tượng trong `whenReady`; `before-quit` thoát hai giai đoạn (park cửa sổ trước rồi mới thoát thật) |

**Quy ước đặt tên IPC**: `miền:hành_động`; tầng render chỉ được gọi qua `window.apkstart.*` do `preload.js` phơi ra, sự kiện đẩy nằm trong danh sách trắng (`preload.js:120`).

### 3.2 `core/engine.js` (vòng đời runtime)

Xuất `class Runtime`: `ensure / prewarm / boot / stop / adoptExisting / beginApp / endApp / status / diagnostics / cleanup / dispose`.
Bất biến then chốt:

- `ensure()` và `prewarm()` đều là Promise lũy đẳng;
- `dispose()` **tuyệt đối không giết cưỡng bức qemu** (giết cưỡng bức sẽ cắt cụt snapshot quickboot đang ghi → lần sau chỉ khởi động nguội được);
- Thực thể tiếp quản không có handle proc cục bộ, `vmRunning` phải xem đồng thời `adb isOnline()`, nếu không watchdog sẽ không bao giờ thu hồi được;
- Watchdog thu hồi khi rảnh chạy mỗi vòng 60s: chỉ dừng khi `idleShutdownMinutes` hết hạn và không có App hoạt động.

### 3.3 `core/emulator.js` (thích ứng trình giả lập)

Trách nhiệm: tạo AVD/sinh tham số/khởi chạy tiến trình/probe/snapshot/ưu tiên/cổng/dọn mồ côi/phân vùng dữ liệu. Giao diện ngoài: `start/stop/running/scheduleSnapshotSave/saveSnapshotNow/cancelSnapshotSave/invalidateSnapshot/ensureDataPartition/resizeDataPartition/dataInfo/setPriority/killOrphanProcesses/resetAdbServer/versions`.
Các bẫy tập trung ở chú thích đầu tệp (`emulator.js:330-347`): block size phải là 4096, bit `encrypt` phải bổ sung sau cùng, `ram.bin` vs `ram.img`, `emulator.exe` chỉ là trình khởi chạy.

### 3.4 `core/adb.js` (thao tác thiết bị)

`class AdbClient`: `isOnline/shell/exec/install/installMultiple/uninstall/startApp/forceStop/clearData/runningPackages/wmSize/setOrientation/keyBack/keyForward/input/prepareForeground/grantRuntimePermissions/dismissPermissionDialog/resolveLauncher/ensureFreeform/devices/connect/killServer`.
Then chốt về hiệu năng: **kênh nhập liệu `adb shell` thường trực** (`input()` dùng `echo __APKSTART_<id>__` làm gói phản hồi/áp lực ngược), chuột phải quay lại và cuộn không còn mỗi nấc spawn một tiến trình adb.

### 3.5 `core/installer.js`

Xem 2.1. Thêm hai đường "tự sửa chữa" đáng nhớ: `switchToCompat()` (sau khi đổi ảnh thì cài lại các ứng dụng đã cài từ APK sao lưu) và `ensureShortcuts()` (khi khởi động thì bổ sung biểu tượng/lối tắt mà bản cũ quên tạo).

### 3.6 `src/ui/`

- `app.js`: máy trạng thái một tệp (đối tượng `state` + một loạt hàm render), không framework; mọi lời gọi backend đều `await window.apkstart.xxx()`;
- Tiến trình cài đặt: trong `installFiles()` có sticky toast + sự kiện `install:progress`, **khi lỗi phải `off()` trước rồi mới `dismiss()`** (lỗi "thông báo thất bại lặp mãi" trước đây chính là do cái này);
- `shell.html/js`: vỏ cửa sổ ứng dụng, chỉ có bốn nút xoay/thu nhỏ/phóng to/đóng + lớp phủ khởi động.

### 3.7 Lưu trữ `core/store.js`

`getSettings()` mỗi lần đều `deepMerge(DEFAULT_SETTINGS, giá trị trên đĩa)` và **cưỡng bức di trú** ba cấu hình lịch sử (`headless=false` / `hideAfterLaunch=false` / `freeform=false`);
`saveSettings()` ghi tmp + rename (ghi nguyên tử), và xử lý việc chuyển `resourceMode` → `liteMode/priorityMode/renderSize`.
`apps.json` là mảng `{ apps: [...] }`, `upsertApp` gộp theo `package`.

---

## 4. Dây chuyền build / phát hành

| Lệnh | Script | Sản phẩm |
|---|---|---|
| `npm run pack` | `build/pack.js` | `dist/ApkStart-win64-portable/` (~226MB sau giải nén, lần khởi động đầu mới tải runtime) |
| `node build/zip.js <dir> <zip>` | `build/zip.js` | Nén bằng 7-Zip `-mx=9` + tự kiểm bằng bộ phân tích zip của dự án; **vượt 100MiB là thất bại luôn** (giới hạn một tệp của Gitee) |
| `npm run runtime` | `build/prepare-runtime.js` | `build/runtime/` (emulator đã cắt gọn + ảnh xz/gz + `build/seed/userdata.img.gz`) |
| `npm run build:exe` | Hai bước trên + `electron-builder --win nsis` | `dist/release/ApkStart-<ver>-Setup.exe` (~1,32GB, có sẵn runtime) |
| `npm test` | `run-tests.js` + `engine-test.js` + `auto-test.js` | 70 bài kiểm thử Node thuần |
| `npm run test:boot` | `test/boot-test.js` | Khởi động thật guest Alpine, kiểm chứng tham số QEMU/tạo đĩa/tắt máy êm |
| `npm run selftest` | `scripts/selftest.js` | Nghiệm thu đầu-cuối trên thiết bị đã cài (adb/phiên bản/freeform/thư mục chia sẻ, `--apk` chạy trọn cài→khởi chạy→chụp màn hình) |

`.github/workflows/ci.yml`: Windows × Node 20/22 chạy `npm test` + `test/pointer-hook-logic.ps1` (tránh phím chuột bị sửa hỏng).
`.github/workflows/release.yml`: tag `v*` → job `build` (zip bản portable → GitHub Release → đồng bộ Gitee, thiếu `GITEE_TOKEN` thì thất bại luôn chứ không lặng lẽ bỏ qua) + job `full` (lắp runtime → xz → NSIS Setup → tải lên Release + zip runtime trọn gói).

**Danh sách kiểm tra khi phát hành** (tổng kết từ các lần dính bẫy):
1. Bắt buộc tăng số phiên bản trong `package.json` (nếu không client sẽ cho là "đã mới nhất");
2. Có viết `.github/release-notes-<tag>.md` thì dùng nó, nếu không thì `--generate-notes`;
3. Job `full` mất ~40 phút (nén xz 1,1GB);
4. Gitee dùng `tools/publish-gitee.js`, ưu tiên trọn gói, vượt giới hạn mới chia phần;
5. Phát hành xong xác minh "gói phát hành == mã nguồn": kiểm tra `agent.ps1` trong zip có chứa `SetScope`/`IsOurs` không, và phiên bản trong `package.json`.

---

## 5. Kiểm thử và công cụ kiểm chứng trên máy thật

- **Hồi quy Node thuần** (CI bắt buộc chạy): `test/auto-test.js` bao gồm ma trận tham số doctor, máy trạng thái container, trình tải/hai nguồn, logic pointer, cuộn log, v.v.;
- **Đầu dò máy thật** (chạy tay trên máy, không chạy được trong sandbox): `tools/check-windows.js` (rò rỉ cửa sổ khi khởi động), `check-console.js` (cửa sổ đen), `check-launch-clean.js` (cài+mở+nhúng), `check-quit-clean.js` (sót lại khi thoát), `check-update.js` (GitHub API thật), `e2e-boot.js` (đo giờ khởi động nguội/nóng);
- **Smoke test giao diện**: `electron . --smoke out.png`, kết hợp `--settings` / `--perf` / `--download` để chụp từng vùng của trang cài đặt;
- **Kiểm thử logic PS**: `test/pointer-hook-logic.ps1` dùng reflection gọi callback của hook; `agent-compile.ps1` chỉ kiểm chứng C# biên dịch được.

> Môi trường đo thực tế trên máy này (máy phát triển): **Node 22.22.2 / npm (`.workbuddy/binaries/node`)**, **PortableGit 2.55**, Electron 33.4.11 (`node_modules/electron/dist`), runtime `D:\ApkStartRuntime` (emulator 37.3.9.0 + AEHD Operational), AVD `D:\ApkStartData`, dữ liệu `%APPDATA%\apkstart`.

---

## 6. Bản đồ vấn đề hiện tại (đáng xem nhất khi tiếp quản)

### 6.1 Bug điểm nóng đã biết (tương ứng GitHub issue)

| Issue | Hiện tượng | Vị trí mã đã xác định |
|---|---|---|
| #21 Cài gói 2GB+ bị treo | APK lớn báo lỗi và "góc dưới phải xoay mãi" | `apk.js:78` `fs.readFileSync(filePath)` đọc nguyên gói, chạm giới hạn một Buffer của Node; nên đổi sang `ZipFile` đã có trong `zip.js` (đọc thư mục trung tâm theo luồng qua fd) |
| #20 / #25 Không khởi động được (0xC0000005) | emulator in xong Userspace boot properties thì `exit 3221225477` | Cả hai ca đều là NVIDIA + emulator 37.3.9.0 + `-gpu host`; runtime trên máy này cùng phiên bản, có thể tái hiện tại chỗ |
| #26 Cài quá chậm/kẹt ở chuẩn bị runtime | Triển khai lần đầu dừng ở bước tải | `provision.installRuntimePack()` / đường tải từng phần từ nguồn chính thức; Gitee giới hạn tần suất và ngắt mạch |
| #23 Bản portable đã đặt thư mục runtime mà vẫn tải vào AppData | Quy tắc đường dẫn không nhất quán | Liên động giữa `paths().root` với `materializeImages` / `sysImgRoot` (xem 2.5) |
| #27 / #28 Cửa sổ WeChat, UU Remote (UU 远程) bị giấu | Đã sửa ở v0.3.4 (scope/IsOurs) | `agent.ps1:168`, người dùng chỉ cần nâng cấp |
| PR #18 / #22 | Trùng với phần đã merge | #18 bị `b3fc7c2` thay thế; thứ tự tham số `_qemuImg` của #22 đã được sửa ở `emulator.js:403` |

### 6.2 Khiếm khuyết triển khai đã xác nhận (đối chiếu từng dòng khi duyệt, chưa sửa)

| # | Vị trí | Khiếm khuyết | Ảnh hưởng |
|---|---|---|---|
| 1 | `apk.js:78` / `installer.js:27` | `fs.readFileSync` đọc nguyên gói APK | 2GB+ chắc chắn nổ (issue #21); máy ít RAM phân tích gói lớn cũng nguy hiểm |
| 2 | Toàn bộ `zip.js` | **Không có Zip64** (`zip.js:29-30,37,161-162,180`) | Số mục >65535 thì lặng lẽ mất mục; một mục >4GiB thì `RangeError` ngay (ảnh hệ thống/gói cập nhật sớm muộn cũng chạm) |
| 3 | `assoc.js:62-63` | "Giữ lại liên kết gốc của người dùng" mà chú thích hứa hẹn không hề tồn tại, khi gỡ thì xóa vô điều kiện giá trị mặc định của `.apk` | Liên kết APK ban đầu của người dùng bị xóa; mô-đun không có kiểm thử nào |
| 4 | `logfile.js:19-21` | Khi `bak === file` thì xóa trước rồi rename | Tên tệp không phải `*.log` sẽ mất log (`appLog` tình cờ là `app.log` nên chưa nổ) |
| 5 | `provision.js:531` + `sources.js:412` | Lúc mới bắt đầu triển khai cố định `percent:1`, sau đó **tuần tự** đo tốc độ từng địa chỉ tối đa 9s | 4 ứng viên = 30s+ không có tiến độ → người dùng tưởng "kẹt ở chuẩn bị runtime" (issue #26) |
| 6 | `provision.js:575-576` / `:790` | Bung `.xz` thất bại bị hai lớp `catch` nuốt mất | Tiến độ dừng ở 99% rồi lại nhảy về "chuyển sang nguồn chính thức để bổ sung", tải phí thêm một bộ 1,4GB |
| 7 | `provision.js:262-277` | Bảng `need` của `guardDisk` thiếu mục `'runtime'`, chỉ ước tính 1536MB | Trọn gói + bung thực tế khoảng 5GB, qua được bảo vệ rồi vẫn có thể làm đầy ổ |
| 8 | `updater.js:80` | Bản portable dùng dự phòng `/\.zip$/i` | Khi một phiên bản chỉ có `ApkStart-runtime-*.zip` sẽ bị nhầm là gói cập nhật và giải nén vào thư mục chương trình |
| 9 | `main.js:165-168` | `bootstrapBundledRuntime()` khi "thư mục bản portable có kèm runtime" thì ghi đè thẳng `runtime.dir` người dùng đã đặt | "Đã đặt thư mục runtime mà vẫn tải vào AppData" (issue #23) |
| 10 | `main.js:213` / `shortcut.js:120` | Biểu tượng WebP phụ thuộc BrowserWindow ẩn để giải mã | Trong kịch bản Node thuần / không GUI sẽ lặng lẽ hạ xuống ảnh giữ chỗ thương hiệu, và không phân biệt được "giải mã thất bại" với "không có biểu tượng" |
| 11 | `apk.js:29,67` | Danh sách trắng định dạng biểu tượng chỉ có `.png`/`.webp`, không đệ quy `<bitmap>` trong XML | Biểu tượng `.jpg`, tổ hợp adaptive-icon sẽ lấy sai ảnh |
| 12 | `arsc.js:65-77` | Chấm điểm config dùng hằng số đặt cảm tính (`anydpi` phạt 500, `language` phạt 40) | Ứng dụng tiếng Trung có thể lấy tên tiếng Anh; ba kiểu mã hóa entry không có kiểm thử, lỗi thì lặng lẽ quay về giá trị mặc định |

### 6.3 Vấn đề mang tính cấu trúc (có thể làm ở giai đoạn sau)

1. **Thống nhất đường xử lý tệp lớn**: `apk.js` / `installer.parseBundle()` đổi sang `ZipFile` có sẵn (luồng qua fd, từ `zip.js:128`) — bộ nhớ đỉnh giảm từ "kích thước tệp" xuống "vài MB", tiện giải quyết luôn giới hạn 2GB. Lưu ý ngữ nghĩa `read()` của hai lớp khác nhau (`ZipArchive` trả về null / `ZipFile` ném lỗi), khi thay phải bổ sung kiểm tra `has()`;
2. **Bổ sung Zip64**: khi EOCD có `0xffff/0xffffffff` thì định vị Zip64 EOCD (`0x06064b50`) và locator (`0x07064b50`), đổi 4 trường sang u64;
3. **Tách tệp lớn**: phần đăng ký IPC trong `main.js` 1790 dòng tách theo miền ra `src/main/ipc/*.js`; `emulator.js` 1064 dòng tách thành ba khối "ma trận tham số / snapshot / phân vùng dữ liệu";
4. **Năng lực chẩn đoán yếu** (báo cáo của #20/#25 có `attempts: []`, `bootLog: []`): khi thất bại ghi `emulator.attempts` và đuôi emulator.log vào báo cáo chẩn đoán, và dịch mã thoát sang ngôn ngữ người dùng (`3221225477` = 0xC0000005 vi phạm truy cập);
5. **Lớp tương thích GPU**: `-gpu host` crash trên một số driver NVIDIA + emulator 37.3.9, có thể mở rộng cơ chế `badGpu` thêm một quy tắc "mã thoát 0xC0000005 → tự hạ cấp và ghi nhớ";
6. **Lỗ hổng kiểm thử** (xếp theo rủi ro): AXML/ARSC không có ca kiểm thử byte tổng hợp (thiếu fixture APK thật thì bỏ qua cả đoạn → CI không phủ gì), `arsc.resolve()` không có assert nào, `.apks/.xapk` không có ca kiểm thử, `assoc.js` không được phủ, `pngToIco`/`writeShortcut` không nằm trong `npm test`;
7. **Tài sản Gitee không khớp GitHub** (v0.3.4 trên Gitee chỉ có gói portable): quy trình phát hành đã có `publish-gitee.js`, nhưng CI cần secret `GITEE_TOKEN` thì mới không thất bại.

### 6.4 Các khâu dễ hỏng nhất trên chuỗi triển khai (tra nhanh 11 mục)

| Hiện tượng (góc nhìn người dùng) | Vị trí mã | Cơ chế |
|---|---|---|
| Kẹt ở "chuẩn bị runtime" 1~3% | `provision.js:531` + `sources.js:412` | Đo tốc độ tuần tự, không có tiến độ theo byte |
| Dừng ở 99% rồi nhảy về "chuyển sang nguồn chính thức" | `provision.js:575-576,790` | Bung `.xz` thất bại bị nuốt |
| "Đã đặt thư mục runtime mà vẫn tải vào AppData" | `provision.js:217-224,726` + `main.js:165-168` | Ba nhánh `sysImgRoot` dùng tiếp thư mục cũ + bản đầy đủ tiếp quản ghi đè cài đặt |
| Đĩa đủ mà vẫn báo thiếu dung lượng | `provision.js:262-277` | guard chỉ ước tính 1,5GB |
| Tiến độ kẹt ở 95% | `download.js:446-503` | Khối đuôi kéo dài do nguồn chậm; đã thêm đổi nguồn khi chậm + đảm bảo settle |
| Kết nối bị ngắt thì cả lượt tải bị hủy | `download.js:155,188-191` | Thấy tệp dở dang thì hạ xuống đơn luồng |
| Cập nhật kẹt ở "đang thay thế chương trình" | `updater.js:271,280-285,315-323` | Script ghi đè **không được detached**, phần mềm bảo mật sẽ chặn |
| Thư mục chương trình dư ra tệp 1,5GB | `updater.js:80` | Gói runtime trọn gói bị coi là gói cập nhật |
| Một phiên bản trên Gitee không có gói cài | `release.yml` + `sources.js:172-204` | Thiếu token thì thất bại luôn; các phần phải liên tục part1..N |
| Đổi nguồn mà vẫn dùng địa chỉ cũ | `main.js:819-825` | `provision._cache.*` không có lối vô hiệu hóa, cần khởi động lại |
| AVD bị phán định "đang bị chiếm" | `layers.js:87-90` + `engine.js:856` | Còn sót `*.lock`, bảng dọn dẹp có thể thu hồi |

> **Ba điều "xem ở đây trước" cho người tiếp quản**
> 1. Chỉ cần xem một hàm là giải thích được tám phần vấn đề triển khai: `Provisioner.checkEnv()` (`provision.js:367`);
> 2. Quy tắc đường dẫn chỉ có một chỗ: `Provisioner.paths()` (`provision.js:197`), code mới ghi tệp runtime phải lấy đường dẫn từ đây;
> 3. Chiến lược tải đều quy về `Sources` + `downloadMulti`, đừng viết thêm một bộ khác trong `provision.js`.

### 6.5 Nhật ký sửa lỗi cục bộ (v0.3.5-dev, chưa phát hành, chưa push)

2026-11-14 vòng phát triển thứ hai: chỉ sửa trong workspace cục bộ, `npm test` từ **98 bài tăng lên 113 bài, đều xanh**
(run-tests 3→8 + engine-test 25 + auto-test 70→80, thêm các ca hồi quy APK tổng hợp / gói tách .xapk /
materializeImages / Zip64 / tài sản cập nhật / 0xC0000005 / biên của log / ghi đĩa khi thất bại / ghép thành phần khởi chạy, v.v.),
và đã chạy một lần kiểm chứng đầu-cuối thật: khởi động nguội (25s) / khởi động nóng (5s, trúng snapshot) / tắt máy êm (đã lưu snapshot);
**Đo thực tế APK tổng hợp 2,15GB: phân tích 18ms, RSS tiến trình 47MB** (đường cũ cần khoảng 2,2GB bộ nhớ liên tục),
`assoc` đã chạy trọn vòng "sao lưu → đăng ký → hủy đăng ký → khôi phục" trên registry thật của máy này
(liên kết gốc của máy là `MuMuPlayer.apk`, đã khôi phục nguyên trạng).

| # | Sửa gì | Vị trí | Vì sao |
|---|---|---|---|
| 1 | `parseApk` / `parseBundle` chuyển sang đọc ZIP theo luồng phiên bản tệp | `apk.js:80-95`, `installer.js:27-60` | APK 2GB+ không còn chạm giới hạn một Buffer của Node; mỗi phần của gói tách cũng được ghi ra đĩa theo luồng |
| 2 | ZIP hỗ trợ Zip64 (EOCD locator + extra id=0x0001) | `zip.js:9-92`, `zip.js:151-236` | Số mục >65535 không còn bị cắt lặng lẽ; mục siêu lớn không còn vượt biên/mất offset |
| 3 | Thời gian chờ `adb install` phóng to theo kích thước gói (trần 20 phút) | `adb.js:105-114` | Gói 2GB push + dexopt sẽ vượt mốc cố định 4 phút |
| 4 | Triển khai: đo tốc độ có hiển thị tiến độ (nguồn thứ i/n, 6s/nguồn) | `sources.js:408-424` | "Kẹt ở chuẩn bị runtime" không còn là 30 giây không có tiến độ |
| 5 | Bung ảnh thất bại không còn bị nuốt, đổi sang `.part` + đổi tên nguyên tử; phán định "đã bung" đổi thành không nhỏ hơn kích thước gói nén (ảnh dở dang sẽ được giải lại) | `provision.js:766-826` | Bản cũ dừng ở 99% rồi quay lại nguồn chính thức tải thêm 1,4GB; system.img dở dang bị coi là đã xong |
| 6 | `guardDisk('runtime')` bổ sung ước tính 5000MB | `provision.js:262-268` | Đỉnh trọn gói + bung khoảng 4,7GB, ước tính cũ chỉ 1,5GB |
| 7 | Thư mục runtime người dùng tự đặt không còn bị runtime đi kèm ghi đè | `main.js:136-162` | issue #23 "đã đặt thư mục mà vẫn tải vào AppData" |
| 8 | Dự phòng `.zip` của trình cập nhật loại trừ `ApkStart-runtime-*.zip` | `updater.js:73-88` | Tránh trường hợp một lần phát hành thiếu gói portable thì giải nén gói runtime 1,5GB như gói chương trình |
| 9 | Quy tắc chẩn đoán 0xC0000005 + tự hạ GPU + ghi đĩa khi thất bại | `doctor.js:320-330`, `emulator.js` (`describeExitCode` / `_persistFailure` / `lastFailure` / `tailLogFile`), `engine.js:diagnostics` | issue #20/#25: báo cáo có `attempts: []`, `bootLog: []`, UNKNOWN vì dữ liệu chỉ nằm trong bộ nhớ |
| 10 | Khi gỡ `assoc` thì khôi phục liên kết `.apk` gốc của người dùng | `assoc.js:40-135` | Bản cũ xóa vô điều kiện giá trị mặc định (lớp bảo vệ mà chú thích hứa hẹn không tồn tại) |
| 11 | Bảo vệ biên `bak === file` khi cuộn log | `logfile.js:15-30` | Tên tệp không phải `.log` sẽ bị xóa trước rồi rename dẫn đến mất log |
| 12 | Biểu tượng: danh sách trắng thêm jpg, biểu tượng XML đệ quy 3 tầng, ảnh giữ chỗ phân biệt được và có cảnh báo mềm | `apk.js:27-115`, `shortcut.js:109-140`, `installer.js:210-235,289-300` | Biểu tượng `.jpg`/adaptive-icon/layer-list không còn đều thành ảnh giữ chỗ; thật sự không giải được thì báo cho người dùng |
| 13 | UI cài đặt thất bại: thông báo lỗi thống nhất thu về `install:error` và xóa vòng xoay "đang cài" | `ui/app.js:469-520,1446-1460`, `main.js:566` | issue #21 "báo lỗi rồi mà góc dưới phải vẫn đang tải" |
| 14 | Thêm kiểm thử hồi quy "APK tổng hợp": tự tạo manifest AXML + biểu tượng PNG + thư mục ABI, phủ mốc `attributeStart`, `package` không có namespace, thuộc tính số nguyên, phân giải Activity khởi chạy; gói tách `.xapk` và `materializeImages` (bung/bỏ qua/ảnh hỏng không để lại dở dang) có ca kiểm thử riêng | `test/lib/make-apk.js`, `test/run-tests.js`, `test/auto-test.js` | Khi thiếu fixture APK thật thì CI không phủ axml/apk; bung ảnh là bước mong manh nhất của triển khai |
| 15 | **Sau khi cài mới, nhấp biểu tượng chỉ thấy màn hình chính Android**: `startApp` ghép vô điều kiện `${pkg}/${activity}`, trong khi `resolveLauncher`/bản ghi cài mới lưu thành phần đầy đủ `pkg/class` → thành phần của `am start` thành `pkg/pkg/class`, hệ thống hủy luôn (result code=-92). Thêm `componentArg()` thống nhất hai dạng, `parseResolvedActivity()` chịu được dòng trống/dòng priority ở cuối | `adb.js:105-131,520`, `test/auto-test.js` | Đây là **bug có sẵn từ upstream** phát hiện khi đo thực tế (v0.3.4 cũng có), chỉ ảnh hưởng "ứng dụng mới cài/cài lại", apps.json cũ (chỉ tên lớp) không kích hoạt |

> Chưa làm (để vòng sau): tách IPC trong `main.js`, tách `emulator.js`, cho phép cấu hình chấm điểm config của `arsc`,
> tách menu khay/cập nhật khỏi `main.js` 1790 dòng, ca kiểm thử byte tổng hợp cho `arsc.js` (`axml.js`/`apk.js`
> đã được ca "APK tổng hợp" trong `test/run-tests.js` phủ, không còn phụ thuộc fixture bên ngoài).

---

## 7. Phụ lục: tra nhanh mô-đun

### 7.1 Chữ ký xuất của `src/core`

| Mô-đun | Xuất chính |
|---|---|
| `store.js` | `DATA_DIR/ICON_DIR/APK_DIR`, `getSettings/saveSettings/getApps/saveApps/upsertApp/removeApp/getApp/iconPath/apkPath/ensureDirs/DEFAULT_SETTINGS` |
| `engine.js` | `class Runtime`, `MONITOR_PORT` |
| `emulator.js` | `class EmulatorEngine` |
| `provision.js` | `class Provisioner` (`paths/checkEnv/installAdb/installEmulator/installSystemImage/installPlayImage/installAehd/installQemu/materializeImages/installRuntimePack/guardDisk/emulatorAccel/hypervisor`) |
| `installer.js` | `class Installer`, `accentOf` |
| `adb.js` | `class AdbClient`, `friendlyInstallError`, `friendlyLaunchError` |
| `apk.js` | `parseApk` |
| `zip.js` | `class ZipArchive` (toàn gói trong bộ nhớ), `class ZipFile` (luồng qua fd) |
| `appwin.js` | `class AppWindow`, `TITLEBAR_H` |
| `agent.js` | `class WinAgent`, `AGENT_SCRIPT` |
| `doctor.js` | `hostInfo/freeDiskMB/gpuCandidates/lcdFor/shortPath/liteProfile/chooseProfile/overridesFromSettings/autoProfile/planVariants/isPortFree/snapshotKey/imageIdentity/diagnose/describeProfile/writeReport/vcRedistOk` |
| `updater.js` | `class Updater` (`check/prepare/apply`, `repoUrl`) |
| `sources.js` | Liệt kê/đo tốc độ/bộ đệm/ngắt mạch hai nguồn (chi tiết xem `_wip-provision-stack.md`) |
| `download.js` | `downloadMulti` / đơn luồng / tải tiếp từ điểm dừng / watchdog (chi tiết như trên) |
| `container.js` | `nextSessionState/buildSessionCommands/buildIdleCommands/buildRestoreCommands/NEVER_TRIM` |
| `pointer.js` | `pointerOptions/hookOptions/wheelToSwipe/WheelRouter/isInputCommand` |
| `layers.js` | `summary/prune` (kiểm kê và thu hồi phân lớp container) |

### 7.2 Tài liệu liên quan

- `docs/ARCHITECTURE.md`: kiến trúc và các đánh đổi thiết kế hướng tới người dùng (gồm các chương "mô hình container", "phím chuột");
- `docs/CODE-WALKTHROUGH-PARSE.md`: **duyệt từng tệp ngăn xếp phân tích ngoại tuyến** (zip / AXML / ARSC / PNG / apk / shortcut / assoc / version / logfile / display), gồm chữ ký giao diện của từng tệp, bẫy ở mức dòng, điểm gọi, độ phủ kiểm thử và hồ sơ bộ nhớ;
- `docs/CODE-WALKTHROUGH-RUNTIME.md`: **duyệt từng tệp ngăn xếp tải/triển khai/cập nhật** (sources / download / provision / updater / store / layers / notify / android), gồm chọn nguồn tốt nhất giữa hai nguồn, trộn nguồn theo khối, tải tiếp từ điểm dừng, quy tắc đường dẫn, script ghi đè khi cập nhật, và bảng tra nhanh 14 vấn đề triển khai.

### 7.3 Phần cần máy thật mới kiểm chứng được (sandbox/CI không phủ được)

- Toàn bộ quy trình khởi động và không rò rỉ cửa sổ: `tools/check-windows.js`, `check-console.js`, `check-launch-clean.js`, `check-quit-clean.js`;
- Đo giờ khởi động nguội/nóng: `tools/e2e-boot.js` (số liệu lịch sử: nguội ~23s, trúng snapshot ~5s, đầu-cuối kể cả dò trước 30,7s / 13,7s);
- Chuỗi cập nhật: `tools/check-update.js` (GitHub API thật + script ghi đè thật);
- Phím chuột, nhúng, xoay màn hình: `test/pointer-hook-logic.ps1`, `test/embed-probe*.ps1`, `test/win-*.ps1`.
