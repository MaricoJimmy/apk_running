# Duyệt mã ngăn xếp runtime (sources / download / provision / updater / store / layers / tiện ích nhỏ)

> Phiên bản mã: `package.json` = **0.3.5**, `main` = `src/main.js`.
> Số dòng tương ứng với bản làm việc hiện tại (`D:\apkstart-dsh\apkstart`); tệp có thể đã thay đổi, trước khi trích dẫn hãy lấy tên hàm làm chuẩn và kiểm lại số dòng.
> Phạm vi đọc: `src/core/{sources,download,provision,updater,store,layers,logfile,notify,android,display}.js`,
> đọc kèm phía gọi `src/main.js` / `src/core/{engine,emulator,installer}.js` và `test/`.
> Tài liệu này chỉ mô tả sự thật trong mã; "✓" = có kiểm thử, "✗" = không được phủ.

Hướng phụ thuộc (quan trọng, tránh require vòng):

```
main.js ──> engine.js ──> provision.js ──> sources.js ──> version.js
   │            │              │  │
   │            │              │  └──> download.js
   │            │              └─────> store.js / doctor.js / zip.js
   │            ├──> emulator.js ──> provision.js / logfile.js
   │            └──> layers.js ──> store.js (require trễ bên trong summary)
   ├──> updater.js ──> sources.js / download.js / zip.js / version.js
   ├──> installer.js ──> store.js / provision.js(thông qua runtime.provisioner)
   └──> android.js / notify.js / display.js / logfile.js
```

Lý do `version.js` tồn tại riêng được ghi ở `version.js:2-4`: tránh `updater ↔ sources` require lẫn nhau tạo thành vòng.

---

## 1. `src/core/sources.js` — hai nguồn GitHub / Gitee + mirror + đo tốc độ + bộ đệm ngắt mạch

### Trách nhiệm
Trừu tượng hóa "đọc thông tin phiên bản" và "lấy địa chỉ tải" thành một tập URL ứng viên được sắp theo **tốc độ byte đo thực tế**, đồng thời ngắt mạch ngắn hạn với nguồn bị giới hạn tần suất/báo lỗi.

### Giao diện ngoài

| Xuất | Chữ ký | Mô tả |
|---|---|---|
| `Sources` | `new Sources(settingsFn)` | `settingsFn: () => settings`, đọc mới mỗi lần phán định (không lưu đệm cài đặt) |
| `Sources#blockedReason` | `(id: 'github'\|'gitee') => string\|null` | `null` = dùng được; nếu không trả về lý do dạng `Tạm thời bỏ qua (không thử lại trong N phút)` (230-234) |
| `Sources#fetchReleases` | `() => Promise<Array<{source,name,web,rel?,error?}>>` | Theo `sourcePreference` quyết định hỏi một bên hay hai bên, `Promise.all` song song (237-271); kiểm thử có thể ghi đè |
| `Sources#latest` | `({force=false}) => Promise<Merged>` | Thông tin phiên bản đã gộp (xem dưới), bộ đệm 10 phút (277-364) |
| `Sources#candidates` | `(assetOrUrl: string\|{url}\|{urls:[]}) => string[]` | Ưu tiên máy chủ gốc, mirror xếp sau, khử trùng lặp và giữ thứ tự (371-393) |
| `Sources#rank` | `(urls, {onProgress}) => Promise<string[]>` | Giảm dần theo tốc độ đo thực tế được đệm trong 30 phút; ≤1 địa chỉ thì trả về ngay (399-432) |
| `Sources#reset` | `() => void` | Xóa bộ đệm đo tốc độ + bộ đệm phiên bản + ngắt mạch (435-439) |
| `SOURCES` | `{github:{id,name,api,web}, gitee:{...}}` | Hằng số, owner viết cứng ở 22-24 |
| `measure` | `(url, {bytes=256*1024, timeoutMs=9000}) => Promise<{url,ok,got,ms,ttfb,speed,error?}>` | Tải thật 256KB để đo thông lượng (108-157) |
| `withMirror` | `(url, prefix) => string` | Bổ sung dấu gạch chéo cuối cho tiền tố; không phải `http(s)://` thì trả về `''` (160-164) |
| `mirrorList` | `(settings) => string[]` | Tiền tố tự định nghĩa là duy nhất có hiệu lực → kế đến là mirror có sẵn khi `autoMirror!==false` (207-213) |
| `KNOWN_MIRRORS` | `['https://ghfast.top/','https://gh-proxy.com/']` | 42-45 |

Cấu trúc trả về của `latest()` (350-361):

```js
{
  version, tag, name, notes, htmlUrl, publishedAt,
  assets: [{ name, size, url, urls: string[], sizes: { [url]: bytes },
             parts?: [{index,size,urls:[]}], partial?: bool, source }],
  sources: [{ source, name, tag }],      // các nguồn tham gia gộp
  unreachable: [{ source, name, error }],
  bySource,                              // nguồn thắng
  stale?: true, staleReason?             // mọi nguồn đều chết nhưng còn kết quả cũ (296)
}
```

### Triển khai then chốt

**1) Lấy phiên bản = hỏi song song hai bên + hạ cấp sang API danh sách (248-269)**
- Trước tiên `${api}/releases/latest`, thất bại thì `${api}/releases?per_page=10` lấy mục đầu tiên không phải `draft`;
- Kho riêng tư trên Gitee sẽ trả **404 "Not Found Project"** (chứ không phải 401), khi đó có thể điền `runtime.giteeToken` chỉ đọc (243-246 sẽ ghép `access_token`);
- Chỉ `403/429` mới ghi ngắt mạch, `_blockMs = 15min` (226, 263). **Ngắt mạch cũng được ghi bù một lần trong `latest()`** (286-290), chú thích giải thích là để "ai cung cấp kết quả" có thể bị kiểm thử thay thế (auto-test tiêm vào theo cách này).

**2) Chiến lược gộp**
- Số phiên bản dùng `cmpVer` lấy cao nhất (299), sau đó **chỉ giữ tài sản cùng phiên bản đó** (307-310);
- Danh sách trắng tài sản: `/^ApkStart/i` (316), loại gói mã nguồn Gitee tự gắn;
- Tài sản cùng tên trên các nguồn gộp thành `urls[]`, và **ghi `sizes{}` theo từng địa chỉ** (334-348) — hai nguồn nén ra số byte khác nhau, tuyệt đối không được lấy trung bình;
- Cùng phiên bản vừa có trọn gói vừa có gói chia phần thì **ưu tiên trọn gói** (326-327);
- Mọi nguồn thất bại nhưng có `_relCache.value` → trả về kết quả cũ và đánh dấu `stale` (292-298), tránh giao diện báo lỗi ngay.

**3) Ba tầng bộ đệm**

| Bộ đệm | Trường | TTL | Vô hiệu khi |
|---|---|---|---|
| Đo tốc độ | `_rankCache: Map<url,{at,ok,speed}>` | 30min (219) | `reset()`; `ok=false` cũng được đệm, khi sắp xếp tính là -1 (418-421) |
| Phiên bản | `_relCache: {at,key,value}` | 10min (223) | `key` không khớp (`sourcePreference` đã đổi) / `force` / `reset()` |
| Ngắt mạch | `_blocked: Map<sourceId, untilMs>` | 15min (226) | `reset()` |

**4) Đo tốc độ là "tuần tự" (408-417)**: chú thích ghi rõ chạy song song sẽ giành băng thông của nhau, kết quả đo thành "ai giành hung hơn". Cái giá là trường hợp xấu nhất `số ứng viên × 9s` (`timeoutMs` của `measure`).

**5) Thông lượng chỉ tính thời gian "sau khi nhận byte đầu tiên" (120-122)**: `span = now - (firstAt || t0)`, loại bỏ chi phí cố định TLS/DNS; nếu không, nguồn "độ trễ cao nhưng băng thông lớn" sẽ bị đánh giá nhầm là chậm.

**6) Khôi phục phần chia `groupParts` (172-204)**: `xxx.zip.part1/.part2` → tài sản logic `{name, size=Σ, parts:[{index,size,urls:[]}], partial:true}`; thiếu địa chỉ hoặc số thứ tự không liên tục → `broken`, bị `list` lọc bỏ; danh sách `broken` có được trả về nhưng `latest()` **không phơi ra ngoài**.

### Bẫy và bất biến

- **Gitee giới hạn một tệp 100MiB** (chú thích 172-204, `.github/release.yml:36-44,78-100`): vượt giới hạn thì cắt thành `.part1/.part2`; `updater._downloadParts` chịu trách nhiệm ghép lại.
- **Mục tài sản Gitee không có `size`** (198-201): vì vậy "tính toàn vẹn" chỉ yêu cầu "các phần liên tục + mỗi phần có địa chỉ", không được đòi `size>0`; khi chưa biết kích thước thì tiến độ hiển thị theo số byte đã nhận.
- **Gói mã nguồn `v1.2.3.zip` / `.tar.gz` sẽ lẫn vào tài sản** (313-316): dựa vào danh sách trắng `^ApkStart` để chặn; khớp đuôi kiểu `\.zip$` sẽ tải gói mã nguồn về như gói cập nhật.
- **Mirror chỉ áp được cho địa chỉ GitHub** (366-369, 385-390): ghfast / gh-proxy chỉ proxy GitHub, ghép với Gitee chỉ ra 403, phí công đo tốc độ một lần.
- **Tài sản cùng tên phải giữ đủ mọi địa chỉ** (329-333): trước đây khử trùng theo tên "ai đến trước dùng nấy", GitHub đứng trước → địa chỉ Gitee bị bỏ → tự chọn nguồn thoái hóa thành chỉ dùng GitHub.
- `SAMPLE_BYTES = 256KB` (52), nhưng chú thích ở `provision.installRuntimePack:532` vẫn ghi "128KB" — **chú thích đã lỗi thời, triển khai là 256KB**.
- Trong `measure`, `openUrl` trả về `res` (luồng), `req.destroy()` lúc `done()` đóng luồng chứ không phải đối tượng request (`req = res` ở 115-132), dùng được nhưng cách đặt tên gây hiểu lầm.
- `groupParts` với `part0` (bắt đầu từ 0) cũng phán `broken` (196 yêu cầu `index === i+1`).
- Bất biến: mục đầu tiên của `candidates()` luôn là **URL máy chủ gốc** (380-382), `rank()` chỉ sắp xếp khi `length>1` (401); đây là bảo đảm "trường hợp xấu nhất vẫn tải trực tiếp được".

### Được ai gọi
- `src/core/provision.js:16` (require), `:145` (`new Sources(() => store.getSettings())`), `:149-151` (`get sources`), `:535` (`rank`), `:588` (`candidates`, `_downloadUrls`).
- `src/core/updater.js:23,47` (`new Sources(this.settings)`), `:74` (`latest`), `:140-141` (`candidates`+`rank`), `:191-196` (mỗi phần tự `candidates`+`rank`).
- `src/main.js:819-825`: trong cài đặt đổi `sourcePreference/mirrorPrefix/autoMirror` → `updater.sources.reset()` + `provisioner.sources.reset()`. **Lưu ý**: ở đây không xóa `provisioner._cache.pack / emulatorUrl / sysimgUrl / playUrl` (xem bẫy ở §3).

### Độ phủ kiểm thử (`test/auto-test.js`)
- ✓ `:843` Địa chỉ ứng viên có tiền tố mirror, tiền tố tự định nghĩa ưu tiên hơn mirror công cộng
- ✓ `:864` Kết quả đo tốc độ sắp theo tốc độ, khi tất cả thất bại thì giữ nguyên thứ tự, không mất địa chỉ dùng được (và kiểm chứng `reset()`)
- ✓ `:878` Gói mã nguồn Gitee tự kèm (`v1.2.3.zip`) tuyệt đối không được coi là gói cài
- ✓ `:901` Tài sản Gitee không có `size`: nhóm phần chia vẫn phải thành lập
- ✓ `:926` Tài sản chia phần phải được truyền suốt tới `updater.asset`
- ✓ `:949` Khi gộp phiên bản chỉ nhận tài sản cùng phiên bản
- ✓ `:976` Trọn gói cùng tên có ở cả hai bên thì giữ cả hai địa chỉ
- ✓ `:1282` Kết quả phiên bản đệm 10 phút, `force` buộc hỏi lại
- ✓ `:1300` Ngắt mạch 403 bỏ qua + nội dung `blockedReason` + `reset()` gỡ ngắt mạch
- ✓ `:1323` Khi mọi nguồn không truy cập được thì quay về kết quả lần trước (`stale`)

---

## 2. `src/core/download.js` — đơn luồng / chia khối / nhiều nguồn song song + tải tiếp từ điểm dừng + watchdog

### Trách nhiệm
Bộ tải bốn tầng chỉ phụ thuộc `http/https/fs`: đơn luồng có tải tiếp → chia khối một nguồn → chia khối nhiều nguồn (cộng dồn băng thông) → lần lượt đổi nguồn; tất cả đều có watchdog nhàn rỗi và bảo vệ "đảm bảo settle".

### Giao diện ngoài

| Xuất | Chữ ký | Trả về |
|---|---|---|
| `openStream` | `(url, {method='GET', headers={}, redirects=0}) => Promise<IncomingMessage>` | Theo 301/302/303/307/308 (≤6 bước nhảy), timeout socket nhàn rỗi 30s (15-36) |
| `head` | `(url) => Promise<{status,size,type,error?}>` | Không bao giờ ném lỗi, thất bại thì `status:0` (38-50) |
| `sha256File` | `(file) => Promise<hex>` | 52-60 |
| `download` | `(url, dest, opt) => Promise<{file,size}>` | `opt = {onProgress,signal,expectSha256,retries=2,idleMs=30000}` |
| `downloadParallel` | `(url, dest, opt) => Promise<{file,size,parallel:n}>` | `opt += {connections=8,minChunk=1MB,retries=3}` |
| `downloadAny` | `(urls, dest, opt) => Promise<{file,size,url}>` | Thử lần lượt, tất cả thất bại thì ném lỗi tổng hợp (314-326) |
| `downloadMulti` | `(urls, dest, opt) => Promise<{file,size,parallel,sources,multi,resumed}>` | `opt += {minChunk=2MB,retries=6,idleMs=20000,slowAfterMs=45000,slowBps=120*1024}` (338-548) |
| `downloadAnyParallel` | `(urls, dest, opt) => Promise<{file,size,url}>` | Lần lượt dùng `downloadParallel` (551-563) |

Thân callback `onProgress`: `{got,total,percent,speed,eta}` (`downloadMulti` có thêm `sources`).

### Triển khai then chốt

**1) `download()`: đơn luồng + tải tiếp (68-173)**
- Trước mỗi lần thử `statSync(dest).size` → `Range: bytes=existing-` (75-77);
- `416` coi là "đã đầy đủ", `break` luôn (82-86);
- `200` mà `existing>0` = máy chủ không hỗ trợ tải tiếp → `rmSync` rồi ghi lại (97-100);
- Không phải 200/206: thử lại tối đa `retries=2` lần, **lùi cố định 1500ms** (87-90);
- Watchdog nhàn rỗi `idleMs` (mặc định 30s): `kick()` đặt lại mỗi khi nhận dữ liệu, hết giờ thì `res.destroy()` + `finish(Error('Kết nối đình trệ (lâu không có dữ liệu)'))` (112-130). Chú thích (109-111) ghi lại: khi kết nối im lặng, `res` không `end` cũng không `error`, `pipe` không bao giờ `finish`, toàn bộ lượt tải treo mà không báo lỗi;
- `signal.abort` → `res.destroy(new Error('Đã hủy'))` (132-133);
- Kết thúc thì ép `onProgress({percent:100})` (162-163); `expectSha256` không khớp → xóa tệp + ném lỗi (165-171).

**2) `downloadParallel()`: chia khối một nguồn (180-311)**
- Đã có tệp không rỗng → quay về `download()` luôn, tránh mất trạng thái chia khối (188-191);
- Dò Range: `Range: bytes=0-0`, 206 + `content-range` mới song song; `total < minChunk*2` cũng quay về đơn luồng (193-210);
- `n = min(connections, ceil(total/minChunk))`, `per = ceil(total/n)` (212-213);
- Trước tiên `ftruncateSync(fd,total)` tạo tệp rỗng, rồi mỗi khối `fs.writeSync(fd, buf, 0, len, pos)` ghi theo vị trí (219-220, 268);
- Mỗi khối tối đa `retries=3`, lùi `800 * tries` ms (285-300);
- Cuối cùng kiểm `size === total`, nếu không ném "tải không đầy đủ" (307-310).

**3) `downloadMulti()`: chia khối nhiều nguồn (338-548)**
1. `list = khử trùng(urls)`; chỉ có một → `downloadParallel` (350-352);
2. `Promise.all` dò song song tổng kích thước `content-range` của từng địa chỉ (355-365); tất cả không hỗ trợ Range → `downloadAnyParallel` (367-370);
3. **Tổng kích thước chuẩn lấy `usable[0].total`**, tức là nguồn đầu tiên đã được `rank()` sắp xếp (nguồn nhanh nhất), không phải `Math.max` (371-377); chỉ trộn các nguồn có `total === giá trị đó` (378-381);
4. `n = clamp(2..connections, ceil(total/minChunk))`, khối được phân nguồn xoay vòng theo `i % same.length` (384, 409-416);
5. **Tệp phụ tải tiếp theo khối** `${dest}.chunks.json` (391-405): chỉ nhận khi `m.total===total && m.n===n && kích thước dest===total`; nếu không thì xóa tệp + xóa tệp phụ và tải lại. Khối hoàn thành thì `doneSet.add(c.start)` + `saveMeta()` (518-520);
6. Khi tải tiếp, khối đã xong được tính vào `got`, tiến độ không quay về 0 (425-427);
7. **Đổi nguồn khi chậm**: một khối chạy đủ `slowAfterMs=45s` mà trung bình < `slowBps=120KB/s`, và `c.rotates < 2` → `res.destroy()` + ném "nguồn này quá chậm… đổi nguồn thử lại", giữ `c.pos` (446-451, 492-503). Chú thích chỉ đích danh hiện tượng: **"kẹt ở 95% không nhúc nhích"**;
8. Mỗi khối `retries=6` (chú thích: 3 lần không đủ khi "trong ba nguồn có hai nguồn thỉnh thoảng đứng"), thất bại thì `c.src += 1` đổi nguồn, lùi `600 * tries` (523-534);
9. Khi thoát vì thất bại thì `saveMeta()` rồi mới ném (526-528), thành công thì `rmSync(meta)` (542).

**10) Bảo hiểm kép "đảm bảo settle"**: `fetchChunk` tự duy trì `settled` + `finish()`, watchdog gọi thẳng `finish`, vì `res.destroy(err)` đôi khi chỉ phát `close` mà không phát `error` (466-480).

### Bẫy và bất biến

- **Nhiều nguồn chỉ được trộn các nguồn "khai báo tổng kích thước giống nhau"** (371-381), nếu không sẽ ghép ra tệp hỏng; kích thước khác nhau (GitHub/Gitee mỗi bên nén một bản) thì chỉ đi theo nguồn nhanh nhất.
- **`c.rotates` phải được khởi tạo tường minh bằng 0** (chú thích 415): `undefined < 2` là `false`, logic đổi nguồn sẽ không bao giờ kích hoạt (bug lịch sử).
- **Mỗi request chỉ được đổi nguồn một lần** (459-463): cùng một kết nối sau khi `destroy` vẫn có thể nhận gói đã đệm, sẽ kích hoạt đổi nguồn lặp lại, nhảy quá nguồn.
- **Tải tiếp chỉ có hiệu lực với `download()` và `downloadMulti`**, `downloadParallel` thấy tệp dở dang là hạ về đơn luồng (188-191) — đây là đánh đổi thiết kế, không phải bug.
- `provision.installQemu:1100` truyền `{ resume: true }`, nhưng `download()` hoàn toàn không có tùy chọn `resume` (69), tải tiếp là tự động: **tham số này vô hiệu/di sản lịch sử**.
- `downloadMulti` không xử lý `opt.signal` (chỉ `download()` xử lý), hủy tải nhiều nguồn hiện chỉ có thể dựa vào timeout/ném lỗi.
- Nhánh `416` của `download()` sẽ `break` và coi "tệp đã tồn tại" là tệp đầy đủ (82-86); nếu `existing > total` (lần trước ghi hỏng) sẽ không tự lành, chỉ `expectSha256` đỡ được.
- `timeout: 30000` của `openStream` là timeout socket nhàn rỗi, **không có timeout kết nối riêng**; DNS treo thì dựa vào bộ hẹn giờ của `measure/rank` ở lớp ngoài.
- UA ở `download.js:13` là `ApkStart/0.2`, ở `sources.js:64` là `ApkStart/0.3`, hai chỗ không nhất quán (không ảnh hưởng chức năng, chỉ ảnh hưởng log/thống kê phía máy chủ).
- Bất biến: `onProgress` của mọi hàm tải chắc chắn được gọi một lần với `percent:100` trước khi kết thúc thành công (163, 308, 545), UI sẽ không dừng ở 99%.

### Được ai gọi
- `src/core/provision.js:14` (require), `:434` `downloadAny` (adb), `:541` `downloadMulti` (runtime trọn gói), `:912` `downloadAnyParallel` (emulator), `:1010` (ảnh play), `:1052` (aehd), `:1143` (ISO), `:628-629`/`:1071-1072` `openStream` (lấy chỉ mục/trang thư mục), `:1226-1228` `head` (`probeSources`).
- `src/core/updater.js:20,150` (`downloadMulti` gói cập nhật), `:198` (`downloadAnyParallel` từng phần).
- `test/engine-test.js:32`; `test/boot-test.js:23,38` (tải ISO thật, chạy qua `test:boot`).

### Độ phủ kiểm thử
`test/engine-test.js`
- ✓ `:83` Tải đầy đủ + theo chuyển hướng
- ✓ `:89` Tải tiếp từ điểm dừng (đã có tệp dở dang)
- ✓ `:101` Dò HEAD + SHA256
- ✓ `:108` Kiểm SHA256 thất bại thì dọn tệp
- ✓ `:118` Tải chia khối song song: ghép nhiều kết nối ra nội dung giống nhau
- ✓ `:133` Nguồn không hỗ trợ Range thì tự quay về đơn luồng

`test/auto-test.js` (chạy http server cục bộ phát byte thật)
- ✓ `:995` Tải song song nhiều nguồn: hai nguồn kích thước khác nhau thì đi theo nguồn nhanh nhất
- ✓ `:1068` Các khối khác nhau kéo từ các nguồn khác nhau, byte ghép ra phải giống hệt
- ✓ `:1108` Làm lại sau thất bại chỉ bổ sung khối thiếu (tệp phụ)
- ✓ `:1155` Sau khi kết nối thiết lập mà không có byte nào tới, phải timeout đổi nguồn chứ không treo
- ✓ `:1198` Khi một nguồn chỉ chạy vài chục KB/s thì đổi nguồn, thay vì kẹt ở vài % cuối
- ✓ `:1251` Chỉ có một địa chỉ dùng được thì quay về chia khối một nguồn
- ✓ `:1033` Gói cập nhật chia phần được ghép lại theo thứ tự thành trọn gói, kích thước không khớp thì dừng ngay (`updater._downloadParts`)

---

## 3. `src/core/provision.js` — tự khởi tạo runtime (adb / emulator / system image / qemu / aehd)

### Trách nhiệm
Không phụ thuộc trình giả lập bên thứ ba, đưa adb, emulator, ảnh hệ thống, AEHD, QEMU, đĩa ảo qua toàn bộ quy trình "tải → kiểm tra → giải nén/cài → ghi ra đĩa", đồng thời quản lý thống nhất các tệp này đặt ở đâu (`paths()`), đủ dung lượng không (`guardDisk`), đã cài xong chưa (`checkEnv`).

### Giao diện ngoài (`class Provisioner`, xuất `{Provisioner, SOURCES, MIN_SIZE, absUrl, baseOf}`)

| Thành viên | Chữ ký | Mô tả |
|---|---|---|
| `constructor` | `(appRoot)` | 140-146; bên trong `_sources = new Sources(() => store.getSettings())` |
| `get sources` | `Sources` | 149-151, dùng chung bộ cài đặt mirror/đo tốc độ với updater |
| `get root` | `string` | `settings.runtime.dir` hoặc `%APPDATA%\apkstart\runtime` (192-195) |
| `paths()` | `Paths` | 197-245, xem bảng dưới |
| `ensureDirs()` | `Paths` | Tạo root/qemu/platform-tools/images/_tmp/avdHome (247-253) |
| `guardDisk` | `(component, targetDir) => Promise<freeMB>` | Không đủ thì ném lỗi thân thiện với người dùng (262-277) |
| `hypervisor` | `() => Promise<{whpx,dll,hypervisorPresent,note}>` | Chỉ kiểm tra tệp mức mili giây (281-296) |
| `adbVersion` / `qemuVersion` / `emulatorVersion` | `() => Promise<{ok,path,version}>` | Mỗi cái có bộ đệm bộ nhớ 30s (298-338, 687-714) |
| `inspectIso` | `(file) => {ok,iso9660,rawImage,size,reason,magic}` | Đọc `CD001` ở `0x8001` (341-365) |
| `checkEnv` | `() => Promise<Env>` | 367-424, "trạng thái" trên UI hoàn toàn dựa vào nó |
| `installAdb` | `(onProgress) => {ok,path,version}` | 428-456 |
| `resolveRuntimePack` | `() => {url,name,size,tag,page,from}` | 476-516, Gitee/GitHub song song tìm `ApkStart-runtime-*.zip` |
| `installRuntimePack` | `(onProgress) => {ok,name,tag}` | 522-580, triển khai một chạm của bản nhẹ |
| `extractZip` | `(zipPath,destDir,{onEntry}) => destDir` | 591-622, >64MB dùng zip phiên bản tệp, mục lớn thì theo luồng |
| `resolveEmulatorUrl` / `resolveSysimgUrl` / `resolvePlayUrl` / `resolveQemuUrl` | `() => Promise<string>` | Phân giải động từ chỉ mục/trang thư mục của Google, rơi về hằng số dự phòng |
| `materializeImages` | `(onLog) => Promise<count>` | 722-794, `.img.xz/.gz` → `.img` (chỉ làm một lần) |
| `systemImageInfo` / `playImageInfo` | `() => {ok,dir,size,api,tag?,note?}` | 797-839 / 972-980 |
| `emulatorAccel` | `() => Promise<{ok,kind,note,...}>` | 845-902, `-accel-check` + bộ đệm trên đĩa |
| `installEmulator` | `(onProgress) => {ok,path,version}` | 905-937 |
| `ensurePlatformTools` / `adbVersionPath` | `() / () => bool / string` | 940-955 / 957-963 |
| `installSystemImage` | `(onProgress)` | 966-969, tương đương `installPlayImage` (chỉ có một ảnh cơ sở) |
| `installPlayImage` | `(onProgress) => playImageInfo` | 1004-1044, tiện tay dọn `android-30` |
| `installAehd` | `(onProgress) => {ok,dir,installer}` | 1047-1062, chỉ tải không giải nén cài đặt |
| `installQemu` | `(onProgress) => {ok,path,version}` | 1090-1130, NSIS `/S /D=` cài im lặng |
| `downloadIso` / `inspectImage` / `importIso` / `importDisk` | | 1134-1195 (lộ trình QEMU) |
| `createDisk` | `(sizeGB=24, onProgress)` | 1199-1220, `qemu-img create -f qcow2` |
| `probeSources` | `() => {adb,qemu,iso}` | 1224-1231, dò HEAD ba URL cố định |
| `envCacheGet/Set`, `invalidateEnvCache`, `_envKey` | | 154-188, bộ đệm dò môi trường trên đĩa |

`paths()` trả về (225-245):

```js
{ root, qemuDir, qemuExe, qemuImg,
  adbDir, adbExe,
  emulatorDir, emulatorExe,
  sysImgRoot,                       // ★ xem ba nhánh bên dưới
  sysImgDir: <sysImgRoot>/android-34/google_apis_playstore/x86_64,
  avdHome, aehdDir,
  imagesDir, iso, disk, tmp,
  sysTag:'google_apis_playstore', sysApi:'34', sysAbi:'x86_64' }
```

`checkEnv()` trả về (387-423):

```js
{ adb:{ok,path,version,required}, emulator:{ok,path,version,required,note},
  sysimg:{ok,dir,size,api,required,note}, playImage:{ok,dir,size,...},
  accel:{ok,kind,note}, qemu:{ok,...}, iso:{ok,path,size,iso9660,reason,...},
  disk:{ok,path,size,note}, hypervisor:{...},
  ready, engine:'emulator'|'qemu'|'none', paths }
```
`ready = adb.ok && (emulatorReady || qemuReady)`; `emulatorReady = emulator.ok && (sysimg.ok || playImage.ok)` (384, 420).

### Triển khai then chốt

**1) Ba quy tắc đường dẫn của `paths()` (197-245) — nguồn có thẩm quyền duy nhất về "ảnh rốt cuộc nằm ở ổ nào"**

- `root`: `settings.runtime.dir`, trống thì `%APPDATA%\apkstart\runtime` (192-195).
- `avdHome` (237): `settings.runtime.avdDir`, nếu không thì **nếu root không nằm dưới `DATA_DIR`** dùng `<DATA_DIR>/avd`, ngược lại `<root>/avd` (202-209). Lý do (202-206): runtime của bản phát hành một tệp được giải nén vào thư mục tạm, đặt AVD vào đó đồng nghĩa mỗi lần thoát là mất ứng dụng.
- Ba nhánh `sysImgRoot` (217-224):
  1. `<root>/system-images` đã tồn tại → dùng nó (sản phẩm giải nén trọn gói);
  2. Nếu không mà `<DATA_DIR>/system-images` tồn tại → dùng nó (bố cục của người dùng cũ/bản phát hành một tệp);
  3. Cả hai đều không có → **đặt tại `<root>/system-images`** (cài mới hoàn toàn; chú thích giải thích CI lắp runtime dựa vào điều này, và `DATA_DIR` có thể bị chuyển hướng sang thư mục tạm).

**2) `materializeImages()` (722-794)**
- Thư mục nguồn cố định là `<root>/system-images` (723), **thư mục đích là `this.paths().sysImgRoot`** (726); chú thích yêu cầu rõ hai bên dùng cùng một quy tắc, nếu không sẽ xảy ra "trọn gói giải vào ổ D, ảnh lại bung về AppData ổ C" (đo thực tế 1,2GB + 3,3GB tồn tại song song).
- Duyệt: `.img.xz` ưu tiên hơn `.img.gz` (Map `found`, 729-741); các tệp khác (`kernel-ranchu` / `ramdisk.img` / `.img` không nén) **phải được sao chép kèm** (728, 751-760), nếu không trình giả lập báo "còn thiếu ảnh hệ thống".
- Phán định đã bung: `fileSize(dest) > 32MB` thì bỏ qua (765).
- Giải nén `.xz` phải vòng qua lối vào ESM của gói (771-781): `require.resolve('@napi-rs/lzma')` lấy thư mục rồi `require(dir/index.js)`; chú thích giải thích Node 20 của Electron không hỗ trợ `require('stream-polyfill.mjs')`, và `exports` không cho phép viết thẳng `/index.js`.
- Một ảnh thất bại chỉ `onLog('Bung ảnh thất bại: …')` (790), **không ném lên trên**.

**3) `installRuntimePack()` (522-580) — "một chạm" của bản nhẹ**
- `resolveRuntimePack()`: `settings.runtime.runtimePackUrl` tự định nghĩa được ưu tiên (477-478, `size:0`); kết quả đệm vào `this._cache.pack`, **never invalidated** (479, 514);
- Hỏi song song `releases?per_page=15` của GitHub/Gitee, tìm trong `assets` theo `/^ApkStart-runtime-.*\.zip$/i`, dùng `cmpVer` lấy tag cao nhất (487-515);
- `guardDisk('runtime', p.root)` (525) → **`'runtime'` không có trong bảng `need`**, rơi vào mặc định 512MB + 1024MB buffer = 1536MB (264-266);
- `rank(this._downloadUrls(pack.url))` đo tốc độ (534-536), thất bại thì quay về ứng viên gốc;
- `downloadMulti(urls, tmp/runtime-pack.zip, {connections: settings.runtime.downloadConnections||8})` (529, 541-555); **
  ánh xạ tiến độ `percent = clamp(1..90, pct*0.9)`** (551);
- Cổng kích thước: `< 200MB` ném "tải runtime trọn gói không đầy đủ, có thể thử lại để tải tiếp" (556);
- `extractZip(zip, p.root, {onEntry})` (559-565), tiến độ 91→99;
- Ghi dấu `<root>/.runtime-pack.json` (`{name,tag,at,from}`) và xóa zip (566-571);
- **Ngay lập tức** `materializeImages(...).catch(() => 0)` (573-576); chú thích giải thích nếu không, `checkEnv()` ngay sau đó sẽ cho rằng chưa cài ảnh và lại đi tải một bộ 1,4GB từ Google;
- Trả về `{ok,name,tag}`, tiến độ 100.

**4) `extractZip()` (591-622)**
- `fileSize > 64MB` → `new ZipFile(path)` (không đưa nguyên gói vào bộ nhớ); nếu không thì `new ZipArchive(fs.readFileSync(...))`;
- Mục đơn lẻ `uncompSize > 64MB` đi theo luồng `zip.pipeTo()`, còn lại `fs.writeFileSync(zip.read())`;
- `finally { zip.close() }` (618-620).

**5) `checkEnv()` (367-424)**: `Promise.all` chạy 5 phép dò (adb/qemu/hypervisor/emulator/accel), rồi cộng thêm `inspectIso`, `fileSize(disk)`, `systemImageInfo()`, `playImageInfo()`; `sysimg.ok` được định nghĩa là `systemImageInfo().ok || playImageInfo().ok` (381-399).

**6) Bộ đệm dò môi trường trên đĩa (126-188)**
- Tệp: `%APPDATA%\apkstart\cache\env.json` (129-131);
- key = `đường dẫn exe + exe(size:mtime) + aehd.sys(size:mtime) + WinHvPlatform.dll có tồn tại hay không` (154-162);
- TTL: kết luận dùng được 6h (126), **không dùng được chỉ tin 10 phút** (127, người dùng có thể vừa bật ảo hóa);
- Khi khởi động thất bại, emulator gọi `invalidateEnvCache()` (`emulator.js:848,886`).

**7) `emulatorAccel()` (845-902)**: phân tích văn bản `-accel-check`; ba quy tắc dự phòng: thiếu `emulator-check` nhưng có `aehd.sys` → phán dùng được (879-883, chú thích giải thích "tránh phán nhầm là không có tăng tốc rồi ép `-accel off`, mô phỏng phần mềm crash thẳng trên một số máy"); `hasAehdFile && /aehd/` → dùng được (884); `hv.dll && /whpx/` → dùng được (886); còn lại `viaTcg: true` (888-897).

**8) Bảo vệ đĩa `guardDisk()` (262-277)**

| component | need(MB) | + buffer 1024MB |
|---|---|---|
| adb | 64 | 1088 |
| emulator | 600 | 1624 |
| sysimg / playimg | 1800 | 2824 |
| qemu | 320 | 1344 |
| iso | 1100 | 2124 |
| aehd | 64 | 1088 |
| Không liệt kê (như `'runtime'`) | 512 | **1536** |

Khi không đủ thì ném: "Ổ đĩa đích không đủ dung lượng: thành phần này cần khoảng N MB… hãy đổi 'thư mục dữ liệu runtime' sang ổ có nhiều dung lượng hơn (Cài đặt → Tích hợp hệ thống → Thư mục dữ liệu runtime → Duyệt)".

### Bẫy và bất biến

- **Vị trí đặt ảnh phải nhất quán với `paths().sysImgRoot`**: `installPlayImage` giải vào `p.sysImgRoot` (1023), đích của `materializeImages` là `paths().sysImgRoot` (726), `playImageInfo` tra `p.sysImgRoot` (974). Bất kỳ code mới nào tự ghép `<DATA_DIR>/system-images` sẽ tái hiện "đã đặt thư mục runtime mà vẫn tải vào AppData".
- **Ước tính của `guardDisk('runtime')` quá thấp**: 512+1024=1536MB, trong khi thực tế là "gói 1,5GB + zip ghi ra đĩa + giải ra system.img 3,3GB + bung .xz". Máy ổ nhỏ sẽ thất bại ở giai đoạn giải nén và để lại tệp dở dang (`installRuntimePack` không có logic dọn zip dở dang, dựa vào lần tải tiếp sau).
- **`this._cache.pack` / `emulatorUrl` / `sysimgUrl` / `playUrl` không có lối vô hiệu hóa**: `main.js:819-825` chỉ `sources.reset()`. Người dùng đổi `sourcePreference` hoặc đổi địa chỉ trọn gói trong cài đặt thì trong cùng tiến trình vẫn dùng địa chỉ cũ (`runtimePackUrl` là ngoại lệ, vì mỗi lần đều đọc cài đặt trước, 477).
- **Lỗi của `materializeImages` bị nuốt ở hai chỗ**: tự nó `.catch(e => onLog(...))` (790) + phía gọi `.catch(() => 0)` (576). `@napi-rs/lzma` bị thiếu/bị phần mềm diệt virus chặn → ảnh không bao giờ bung được → `checkEnv().sysimg.ok === false` → mỗi lần khởi động lại đi lại đường "tải runtime" (điển hình của "kẹt ở chuẩn bị runtime").
- **`emulatorVersion()` thất bại thì không đệm** (687-714): `ok:false` return luôn, không có `envCacheSet`, cũng không có bộ đệm bộ nhớ 30s; mỗi lần `checkEnv()` đều `execFile(emulator.exe -version)` tối đa 20s. Chỉ đường thành công mới ghi bộ đệm (707-710).
- **Bộ đệm `emulatorVersion` chỉ ở bộ nhớ/trên đĩa, `_cache.emulatorVerAt` chỉ được đặt khi thành công**, đường thất bại khiến việc thăm dò trạng thái liên tục khởi chạy tiến trình.
- **`extractZip` không kiểm tra zip-slip**: ghép thẳng `path.join(destDir, name)` (606); `updater._extract` có phòng vệ `startsWith(path.resolve(dest))` (updater:237), hai bên không nhất quán. Runtime trọn gói và gói cập nhật đều đến từ release của dự án này nên rủi ro thấp, nhưng người tiếp quản đừng dùng `extractZip` cho đầu vào không tin cậy.
- **Địa chỉ tự định nghĩa của `resolveRuntimePack()` có `size: 0`**, tiến độ tải chỉ có thể dựa vào dò hoặc số byte đã nhận; `total` trong `installRuntimePack` vì thế cũng là 0, văn bản `mb` sẽ thiếu "/ tổng kích thước".
- **`installAdb` giải nén vào `p.root`** (446), tầng trên cùng của zip chính là `platform-tools/`; `installEmulator` cũng vậy (926). Vì thế root đồng thời là `ANDROID_SDK_ROOT` (chú thích 232-234).
- **`ensurePlatformTools()` (939-955)**: emulator yêu cầu dưới SDK root có `platform-tools`, nếu không thì FATAL; nó sao chép 3 tệp (`adb.exe` + hai dll) từ `engine/platform-tools`, `tools/platform-tools`, thư mục chứa `settings.adbPath`.
- **`installAehd` chỉ tải** (1047-1062), cài đặt cần quyền quản trị: `main.js:1121-1200` dùng `silent_install.bat` + UAC.
- **Cài QEMU**: NSIS `/S /D=<dir>`, `/D` phải ở cuối và không thêm dấu nháy (1112-1116); `setTimeout` 600s thì giết cưỡng bức (1119).
- **`systemImageInfo()` (797-839)**: trước tìm trong `paths().sysImgDir`, rồi liệt kê mọi `android-*/tag/abi` dưới `sysImgRoot`, `<root>/system-images`, `<appRoot>/engine/system-images` (giảm dần theo API), bộ nào có `system.img > 300MB` và có `kernel-ranchu` thì tính là ok. Đây là điểm tương thích cho "bản đầy đủ có thể chỉ mang ảnh AOSP nhỏ hơn".
- **Quan hệ giữa `playImageInfo()` và `sysimg.ok`**: `checkEnv().sysimg.ok` lấy OR của cả hai (390-399), nhưng `engine.ensure()` dùng `env.sysimg.ok` (`engine.js:852`), nên chỉ có ảnh play cũng khởi động được.
- **Bất biến**: `onProgress` của mọi `install*` đều báo theo dạng `{stage:'download'|'extract'|'install'|'done', percent}`, `main.js:317` thống nhất thêm `component`, phía UI `app.js:357 updateStepProgress` chỉ đọc `percent/message`.
- Phiên bản dự phòng viết cứng trong `SOURCES` sẽ lỗi thời (`emulator-windows_x64-16847572.zip`, `x86_64-34_r14.zip`, 27-41), chỉ dùng khi không lấy được chỉ mục.

### Được ai gọi
- `src/core/engine.js:16,54` (`new Provisioner(appRoot)`), `:79,202,393,995` (`paths()`), `:109,235,368,635,849,996` (`checkEnv`), `:264,761` (`emulatorAccel`), `:639` (`createDisk`), `:848` (`materializeImages`), `:1017,1021` (`paths().root` → layers), `:873` (`needsSetup`).
- `src/core/emulator.js:17,29`, `:53,225` (`paths`/`ensureDirs`), `:56,63` (`systemImageInfo`), `:62,723` (`playImageInfo`), `:659` (`adbVersionPath`), `:761-762` (`emulatorAccel`+`emulatorVersion`), `:848,886` (`invalidateEnvCache`).
- `src/core/installer.js:95-99` (`playImageInfo` + `installPlayImage`, lần đầu gặp ứng dụng ARM thì tải theo nhu cầu); `:159,169,190,489` (phán định bằng `playImageInfo`).
- `src/main.js`: `:314-354` (luồng chính `autoDeploy`), `:707` (`paths().root` cho UI), `:824` (`sources.reset`), `:898,932,939,946,953,964,977` (tự kiểm/chẩn đoán), `:1076-1269` (các IPC `provision:*`), `:1330,1542` (`avdHome`/`root`), `:1631` (`checkEnv` trước khi khởi động nóng).
- `test/engine-test.js:146-220,391-401`, `test/auto-test.js:1347-1350`, `test/boot-test.js:44`.

### Độ phủ kiểm thử
`test/engine-test.js`
- ✓ `:149` Thư mục runtime mặc định nằm dưới thư mục dữ liệu
- ✓ `:156` Kiểm tra môi trường rỗng: adb chưa sẵn sàng, cấu trúc thành phần đầy đủ
- ✓ `:166` Giải nén ZIP có sẵn dùng được
- ✓ `:197` url tương đối trong chỉ mục SDK được bổ sung thành địa chỉ tuyệt đối (`absUrl`/`baseOf`)
- ✓ `:211` Địa chỉ emulator / ảnh hệ thống phân giải được đều là URL tuyệt đối tải được
- ✓ `:244` Kiểm tra ảnh: phân biệt ISO9660 hợp lệ / hỏng / chưa tải xong (`inspectIso`)
- ✓ `:391` `playImageInfo` kiểm tra tính toàn vẹn của ảnh tương thích API 34

`test/auto-test.js`
- ✓ `:1339` **Vị trí đặt ảnh hệ thống: cài mới hoàn toàn phải nằm trong thư mục runtime** (phủ ba nhánh `paths().sysImgRoot`)

`test/boot-test.js:44` chạy `checkEnv` thật + khởi động máy thật (`npm run test:boot`, không cần mạng nhưng cần ISO).

**Chưa phủ**: `installRuntimePack`, `resolveRuntimePack`, `materializeImages`, `installAdb/installEmulator/installPlayImage/installAehd/installQemu`, `guardDisk` đều không có unit test (đều cần mạng thật/tệp lớn).

---

## 4. `src/core/updater.js` — cập nhật trực tuyến (check / prepare / apply)

### Trách nhiệm
Lấy phiên bản mới nhất từ GitHub/Gitee Releases của kho này, chọn tài sản theo hình thái cài đặt, tải và lắp ráp tải trọng, sinh một đoạn script PowerShell ghi đè để sau khi tiến trình thoát thì thực hiện "thay thế + khởi động lại".

### Giao diện ngoài (xuất `{Updater, cmpVer, OWNER, REPO}`)

| Thành viên | Chữ ký | Mô tả |
|---|---|---|
| `constructor` | `({currentVersion, exePath, isPackaged, dataDir, settings?, onProgress?})` | 38-50; `this.installDir = dirname(exePath)`, `this.sources = new Sources(settings)` |
| `get flavor` | `'setup' \| 'portable'` | 53-59: dưới `installDir` có `Uninstall *.exe` → `setup` |
| `get updateDir` | `<dataDir>/update` | 61-63 |
| `check` | `({force=false}) => Promise<Latest>` | 73-115, xem dưới |
| `prepare` | `(info?) => Promise<{mode:'zip'\|'setup', payload, version}>` | 121-176 |
| `_downloadParts` | `(asset, target, conns, total)` | 182-227, tải từng phần + ghép theo thứ tự |
| `_extract` | `(zipPath, dest)` | 229-251, có phòng vệ zip-slip, theo luồng từng mục |
| `apply` | `(job, {waitPid?, spawn?}) => true \| script` | 258-325; khi `spawn:false` chỉ trả về script (dùng cho kiểm thử) |
| `static repoUrl()` | `() => 'https://github.com/RoutineMiku/apkstart/releases'` | 328-330 |
| `cmpVer` | re-export từ `version.js` | 333 |

`check()` trả về (82-112):

```js
{ version, tag, name, notes, htmlUrl, publishedAt,
  asset: { name, size, url, urls[], sizes{}, source, parts?, partial? } | null,
  assets, sources, unreachable,
  flavor, hasUpdate, current, canAutoApply }
```
Chọn `asset` (77-80):
- `setup`: `/Setup\.exe$/i` → dự phòng `/win.*\.exe$/i`
- `portable`: `/portable.*\.zip$/i` → `/win64.*\.zip$/i` → **`/\.zip$/i`**
`hasUpdate = cmpVer(merged.tag, current) > 0` (109); `canAutoApply = !!asset && (asset.url || asset.parts?.length)` (111).

### Triển khai then chốt

**1) `check()` (73-115)** chỉ làm "siêu dữ liệu + chọn tài sản", địa chỉ tải đến `prepare()` mới đo tốc độ. `force` được truyền thẳng cho `sources.latest`.

**2) `prepare()` (121-176)**
- Thư mục tải trọng `<dataDir>/update/<version>/`;
- Có `asset.parts` → `_downloadParts` (133-134);
- Nếu không thì `candidates(asset)` → `rank()` → `downloadMulti(ranked, file, {connections})` (136-163);
- **Cách lấy tổng kích thước tiến độ**: theo thứ tự `ranked` tìm `sizes[url]` đầu tiên đã biết (142-147); chú thích giải thích lấy sai sẽ "hiển thị mãi 92% rồi đột ngột nhảy sang hoàn thành";
- `.zip` → giải vào `payload/` → `{mode:'zip',payload:out}`; còn lại → `{mode:'setup',payload:file}` (166-175).

**3) `_downloadParts()` (182-227)**: mỗi phần tự `candidates + rank` (có thể một phần đi Gitee, một phần đi mirror), `downloadAnyParallel` tới `<name>.<index>.tmp`, kiểm `part.size` (nếu đã biết, 211-216), `fs.writeSync(fd, buf, 0, len, doneBytes)` ghi tuần tự ra đĩa, cuối cùng kiểm `doneBytes === total` (224-226). Cả phần được `readFileSync` vào bộ nhớ (213) — mỗi phần ≤100MiB, chấp nhận được.

**4) `apply()` (258-325) — đoạn then chốt nhất của chuỗi cập nhật**
Script sinh ra (`lines`, 265-307) lần lượt:
1. `$ErrorActionPreference='SilentlyContinue'`, `Note()` ghi vào `<updateDir>/update.log`;
2. `Wait-Process -Id <waitPid> -Timeout 90` + `Sleep 700ms` (270-272);
3. `mode==='zip'`: `Copy-Item -Recurse -Force` **tối đa 12 vòng**, mỗi vòng dùng "exe đích có tồn tại không" làm đầu dò, thất bại thì `Sleep 600ms` (275-290); sau đó `Remove-Item $src` (thư mục giải nén, 289);
4. `mode==='setup'`: `Start-Process -ArgumentList '/S' -Wait` và ghi lại exit code (291-298);
5. Khởi chạy lại `exe` (300-301);
6. `Remove-Item <updateDir>/<version> -Recurse -Force`, cuối cùng **`exit 0`** (304-306, chú thích: dọn dẹp thất bại không nên khiến phía gọi tưởng cập nhật thất bại).

Cách khởi chạy (309-324):
- Script được ghi ra đĩa trước ở `update/apply.log.ps1` để tiện điều tra (310);
- Thực thi thật dùng `-EncodedCommand` (UTF-16LE base64, 313), chú thích giải thích là để **né việc PS 5.1 giải mã script không có BOM theo ANSI/GBK** gây lỗi font đường dẫn chứa ký tự không phải ASCII;
- **Không được `detached`** (315-318): một số phần mềm bảo mật/sandbox chặn "tiến trình console tách rời", biểu hiện là script hoàn toàn không chạy (giao diện kẹt ở "đang thay thế chương trình và khởi động lại"); đổi sang tiến trình con thường + `child.unref()`;
- `spawn(ps, ['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-WindowStyle','Hidden','-EncodedCommand',b64], {stdio:'ignore', windowsHide:true})`.

### Bẫy và bất biến

- **Bản cài đặt vs bản portable được phán định dựa vào "thư mục cài có `Uninstall *.exe` không"** (53-59), không có dấu hiệu nào khác; NSIS cài ghi đè im lặng, bản portable dựa vào sao chép ghi đè.
- **Ghi đè không xóa các tệp thừa của phiên bản cũ** (chú thích 287-288), chỉ dọn thư mục giải nén lần này; vì vậy "dll đã bị xóa còn sót lại" có thể ảnh hưởng phiên bản mới (hiện đánh giá là vô hại).
- **Sau `apply()` phía gọi phải thoát**: `main.js:594-596` sau `apply(job)` 900ms thì `app.quit()`; script chờ tối đa 90s.
- **Gitee 100MiB → `.part1/.part2`** (chú thích 130-134); `sources.latest` đã gộp các phần thành tài sản logic, `check()` phải mang `parts` ra suốt (88-101), auto-test:926 chuyên canh điều này.
- **`sizes` ghi theo từng địa chỉ**, không được dùng mỗi `asset.size` cho xong (142-147, sources:339-347).
- **Nguy cơ phán nhầm: dự phòng mặc định `/\.zip$/i` sẽ coi runtime trọn gói là gói cập nhật** (80). Cùng một release có cả `ApkStart-vX-win64-portable.zip` lẫn `ApkStart-runtime-vX.zip` (`.github/workflows/release.yml:44,187`); hiện tại nhờ regex `portable` khớp trước nên chưa có vấn đề; một khi gói portable đổi tên, `/\.zip$/i` sẽ chọn runtime trọn gói 1,5GB và ghi đè thư mục chương trình.
- **`prepare` không kiểm tra tính toàn vẹn zip của kết quả tải**, đến `_extract` mới lộ lỗi; kích thước tải không khớp `total` thì `downloadMulti` sẽ ném (download:546).
- **Chỉ kiểm tra cập nhật sau khi đóng gói**: `main.js:1665 if (app.isPackaged)`; trạng thái phát triển không kiểm tra.
- Bất biến: `apply()` phải được gọi sau khi `prepare()` thành công (`prepare` không có tải trọng thì ném lỗi, `main.js:592` bắt rồi `sendProgress({stage:'error'})`).
- `flavor` mỗi lần đều `readdirSync(installDir)`, không có bộ đệm (53-59) — gọi tần suất cao sẽ có IO đĩa, hiện chỉ dùng ở check/UI.

### Được ai gọi
- `src/main.js:38` (require), `:1503-1511` (khởi tạo, tiêm `settings`/`onProgress`), `:579-604` (`runUpdate`: `check`→`prepare`→`apply`→`quit`), `:496,584,588` (khay/kiểm tra thủ công + `repoUrl()`), `:1447` (`app:updateCheck`, `force` mặc định là true), `:1456` (`app:updateOpen`), `:1461` (`app:updateApply`), `:1667` (kiểm tra im lặng sau 8s khởi động).
- `src/preload.js:71-72` (`updateCheck` / `updateApply`); `src/ui/app.js` mục "Cập nhật phần mềm" của trang cài đặt.

### Độ phủ kiểm thử (`test/auto-test.js`)
- ✓ `:820` So sánh phiên bản theo từng đoạn số (`cmpVer`)
- ✓ `:828` Hình thái cài đặt quyết định chọn tài sản nào + phán định `flavor`
- ✓ `:926` Tài sản chia phần phải được truyền suốt tới `updater.asset` (nếu không `prepare` báo "không có địa chỉ tải dùng được")
- ✓ `:1033` Gói cập nhật chia phần được ghép lại theo thứ tự thành trọn gói, kích thước không khớp thì dừng ngay (`_downloadParts`)
- Phủ gián tiếp: `:843/:864/:878/:901/:949/:976` (`sources`), `:995/:1068/:1108/:1155/:1198/:1251` (`downloadMulti`)
- **Chưa phủ**: nội dung script do `apply()` sinh ra (không có assert kiểm `apply.log.ps1`), zip-slip của `_extract`, cách chọn `sizes` của `prepare`.

---

## 5. `src/core/store.js` — lưu trữ cài đặt và danh sách ứng dụng

### Trách nhiệm
Một kho JSON "khi đọc thì gộp giá trị mặc định + ghi nguyên tử": `%APPDATA%\apkstart\{settings.json,apps.json,icons/,apks/}`.

### Giao diện ngoài (`module.exports = store`)

| Thành viên | Chữ ký | Mô tả |
|---|---|---|
| `DATA_DIR` / `ICON_DIR` / `APK_DIR` | `string` | 10-14; `DATA_DIR = %APPDATA%\apkstart` |
| `getSettings()` | `() => Settings` | 175-186: `deepMerge(DEFAULT_SETTINGS, nội dung trên đĩa)` + **cưỡng bức di trú** |
| `saveSettings(patch)` | `(patch) => Settings` | 188-196: `deepMerge(hiện tại, patch)`, khi có `engine.resourceMode` thì dịch thành ba công tắc |
| `getApps()` | `() => App[]` | 198-201, tệp hỏng thì rơi về `[]` |
| `saveApps(apps)` | `(apps) => void` | 203-205 |
| `upsertApp(app)` | `(app) => app` | 207-214, gộp theo `package` |
| `removeApp(pkg)` / `getApp(pkg)` | | 216-223 |
| `iconPath(pkg)` / `apkPath(pkg,version='cur')` | `=> string` | 225-231 |
| `ensureDirs()` | `() => void` | 119-123 |
| `DEFAULT_SETTINGS` | Đối tượng hằng | 16-117, được kiểm thử và doctor tham chiếu trực tiếp |

### Triển khai then chốt

- **Ghi nguyên tử** (133-138): ghi `<file>.tmp` → `renameSync`, tránh JSON dở dang.
- **`deepMerge` (140-150)**: chỉ đệ quy đối tượng thường, mảng và giá trị vô hướng ghi đè thẳng; `base[k]` phải là đối tượng mới đệ quy.
- **Di trú khi đọc (175-186) — ba chỗ ghi đè cưỡng bức, không có trường số phiên bản**:
  - `s.engine.headless = false` (179): chạy không giao diện của bản cũ ≠ không mở được cửa sổ;
  - `s.hideAfterLaunch = false` (181): thoát lớp vỏ ở bản cũ sẽ giết toàn bộ runtime;
  - `s.freeform = false` (184): cửa sổ nhỏ freeform của bản cũ sẽ thành "cửa sổ nhỏ lồng trong cửa sổ".
  Vì mỗi lần đọc đều ghi đè, giá trị `true` trong settings.json cũ vĩnh viễn vô hiệu (assert ở auto-test:455).
- **Dịch chiến lược tài nguyên (160-170, 191-193)**: `save`→`liteMode:true/priorityMode:balanced/renderSize:540x960`; `smooth`→`false/performance/720x1280`; `balanced`→`true/balanced/auto`. Chỉ kích hoạt khi `patch.engine.resourceMode` xuất hiện, tránh xung đột với các công tắc chi tiết.
- **"Ràng buộc thực tế" trong giá trị mặc định** (ghi trong chú thích, khi đọc đừng xóa):
  - `engine.headless:false` (28-30): chế độ không giao diện thì SurfaceFlinger không phát VSYNC, ứng dụng sống nhưng không có hình;
  - `engine.badGpu:''` (32-34): ghi `<phiên bản emulator>|<gpu>` "vừa bật đã crash", nâng cấp runtime thì tự mất hiệu lực;
  - `runtime.dir:''` (68) = `%APPDATA%\apkstart\runtime`;
  - `runtime.downloadConnections:8` (88);
  - `runtime.sourcePreference:'auto'` (91), `autoMirror:true` (94), `giteeToken:''` (97);
  - `runtime.compatImage:false` (78) — **về cơ bản đã bỏ**: `provision.checkEnv:381-384` không còn phụ thuộc nó, ảnh play đồng thời được dùng làm ảnh chính;
  - `engine.logLimitKB:2048` (55), không có `engine.prefetch`, `engine.prewarm:true` (65);
  - `display.portrait:'900x1600'` (112), nhưng `main.js:276` dùng `d.portrait || '540x960'` (giá trị mặc định không nhất quán, thực tế lấy 900x1600 có trong settings làm chuẩn).
- **`DEFAULT_SETTINGS` thiếu `runtime.avdDir`**: `provision.paths():207` đọc `runtime.avdDir`, với người dùng mới cài thì ở đây là `undefined`; UI ghi vào rồi mới có (`ui/app.js:1203`). Tương tự `runtime.installed` được `engine.js:870` đọc nhưng không có trong giá trị mặc định.

### Bẫy và bất biến

- **Mỗi lần gọi `getSettings()` đều `readFileSync + JSON.parse`, không có bộ đệm bộ nhớ** (175-186). Mà `provision.paths()` mỗi lần gọi phải đọc settings 2~4 lần (193, 207, 209, v.v.), `checkEnv()` được thăm dò trạng thái gọi ở nhiều chỗ → đọc tệp nhỏ tần suất cao. Muốn tối ưu hiệu năng thì đây là chỗ ra tay đầu tiên.
- **`saveSettings` ghi "đối tượng đầy đủ sau khi gộp"** (189-194), nên settings.json sẽ mang theo mọi giá trị mặc định tại thời điểm đó; giá trị mặc định mới thêm sau khi nâng cấp sẽ không được ghi vào, chỉ gộp khi đọc — đây chính là lý do di trú có thể đặt ở thời điểm đọc.
- Di trú là **cưỡng bức một chiều** (179-184); tương lai nếu muốn cho người dùng bật lại headless thì phải sửa ở đây chứ không phải sửa UI.
- `renameSync` của `writeJson` sẽ thất bại khi khác ổ đĩa (`os.tmpdir` và `DATA_DIR` cùng ổ thì không sao; trong kiểm thử sau khi đổi `APPDATA` vẫn cùng ổ).
- Cách cô lập kiểm thử: đổi `process.env.APPDATA` rồi **require lại** (`auto-test.js:11,1344-1347`); `DATA_DIR` là hằng số được tính khi nạp mô-đun, đổi env trong cùng tiến trình sẽ không có hiệu lực — lưu ý khi viết kiểm thử.

### Được ai gọi
- `src/core/provision.js:12,145,192,197-237,452,1159,1187,1193,1217`.
- `src/core/engine.js:15,1017-1021` (`store.DATA_DIR`), `src/core/emulator.js:16`, `src/core/installer.js:10`, `src/core/sharer.js:10`, `src/core/layers.js:162` (require trễ bên trong `summary`).
- `src/main.js`: toàn bộ quy trình (di trú khi khởi động, `app:info`, `settings:get/set`, `bootstrabBundledRuntime:97-171` gọi thẳng `saveSettings({runtime:{dir}})`).
- `test/engine-test.js:147`, `test/auto-test.js:456,700,1346,1374,1386`, `test/boot-test.js:21`.

### Độ phủ kiểm thử
- ✓ `auto-test.js:455` Cưỡng bức di trú cấu hình cũ: không giao diện và "thoát sau khi khởi chạy" không còn hiệu lực
- ✓ `auto-test.js:1373` Đổi chiến lược tài nguyên ở một chỗ, tự dịch thành vCPU/ưu tiên/độ phân giải
- ✓ `auto-test.js:1385` Dung lượng phân vùng dữ liệu cấu hình được, mặc định không còn là số chết
- ✓ `engine-test.js:149` Thư mục runtime mặc định nằm dưới thư mục dữ liệu (phụ thuộc `DATA_DIR`)
- **Chưa phủ**: `upsertApp/removeApp/apkPath/iconPath`, tính nguyên tử của `writeJson`.

---

## 6. `src/core/layers.js` — kiểm kê / thu hồi phân lớp container

### Trách nhiệm
Coi thư mục runtime như các lớp ảnh để **kiểm kê chỉ đọc** và **thu hồi theo danh sách rõ ràng** (mặc định `dryRun`), đồng thời cung cấp cho trang cài đặt bản tóm tắt "tổng cộng chiếm bao nhiêu dung lượng".

### Giao diện ngoài (xuất `{analyze, prune, summary, walk, dirSize}`)

| Xuất | Chữ ký | Mô tả |
|---|---|---|
| `walk` | `(dir, out=[], depth=0) => [{path,size}]` | Danh sách tệp đệ quy, **giới hạn độ sâu 6** (15-27) |
| `dirSize` | `(dir) => bytes` | 29 |
| `analyze` | `(root, {keepAvd='apkstart.avd', aggressive=false, keepSnapshots=false}) => {total,groups,candidates}` | 36-127 |
| `prune` | `(root, {apply=false, keepAvd, aggressive, keepSnapshots, onRemove}) => {…analyze, apply, removed, saved, after}` | 133-152 |
| `summary` | `(root) => {total,totalText,runtimeText,groups,reclaimable,reclaimableText,count}` | 155-184 |

Phần tử `candidates[]`: `{path, size, reason, kind:'file'|'dir'}`.

### Triển khai then chốt

**1) 8 loại mục thu hồi của `analyze()` (theo thứ tự trong mã)**

| # | Dòng | Mục tiêu | reason |
|---|---|---|---|
| 0 | 48-51 | `emulator/`, `system-images/`, `avd/`, `platform-tools/` | Chỉ nhóm theo size (`groups`), không xóa |
| 1 | 53-61 | `emulator/qemu/windows-x86_64/qemu-system-{aarch64,armel,i386}*` | Đích QEMU không phải x86_64 |
| 2 | 63-68 | `system-images/**/{NOTICE.txt,source.properties}` và >1MB | Tệp mô tả dung lượng lớn trong gói ảnh |
| 3 | 70-77 | `system-images/android-30` (chỉ khi `system.img` play API34 tồn tại), `<root>/x86_64` | Ảnh cũ / thư mục giải nén sai vị trí |
| 4 | 79-86 | `avd/*.avd` có `name !== keepAvd` | AVD không hoạt động (gồm 8-16GB dữ liệu người dùng) |
| 5 | 87-90 | `avd/**/*.lock` | Tệp khóa sót lại từ lần thoát bất thường trước |
| 6 | 91-100 | `avd/<keepAvd>/snapshots` hoặc `snapshots.stale-N` (khi `keepSnapshots=false`) | Snapshot quickboot cũ |
| 7 | 103-110 | `<root>/_tmp`, `<root>/images` | Tệp tạm khi tải / phần sót lại của QEMU·ISO cũ |
| 8 | 112-123 | Khi `aggressive` thì `emulator/crashreport.exe` | Chuyên dùng khi build gói phát hành |

**2) Ràng buộc an toàn của `prune()` (139-141)**
```js
const p = path.resolve(c.path), rootAbs = path.resolve(root);
if (p === rootAbs || !p.startsWith(rootAbs + path.sep)) continue;   // không ra khỏi root, không xóa root
```
Khi `apply=false` thì **không đụng tới tệp nào** (142-149), chỉ trả về danh sách; xóa thất bại (đang bị chiếm) thì lặng lẽ bỏ qua, lần sau dọn tiếp (148).

**3) `summary()` (155-184)**: `analyze` runtime + 4 thư mục phụ (`avd`, `APK_DIR`, `ICON_DIR`, `logs`), lọc các nhóm 0 byte, trên 1GB thì đổi đơn vị sang GB.

### Bẫy và bất biến

- **Danh sách đen của `aggressive` là ràng buộc cứng** (chú thích 112-114): `Qt6WebEngineCoreAndroidEmu.dll` là phụ thuộc lúc nạp của `qemu-system-x86_64.exe`, **tuyệt đối không được xóa**; `qsn/netsim` được giữ lại một cách thận trọng.
- **`keepAvd` mặc định viết cứng `'apkstart.avd'`**, phải nhất quán với `AVD_NAME` của `emulator.js`; đổi tên thì phải đồng bộ cả hai chỗ.
- **Khi runtime đang chạy bắt buộc `keepSnapshots:true`**: `engine.cleanup()` truyền `keepSnapshots: this.vmRunning` (`engine.js:1019-1023`), nếu không xóa snapshot của phiên hiện tại sẽ làm hỏng máy đang chạy.
- Độ sâu 6 của `walk` là để chống vòng liên kết tượng trưng/thư mục sâu làm tràn ngăn xếp; tệp sâu hơn 6 tầng không được tính vào size (sẽ ước tính thấp).
- `candidates` của `analyze` **không bao gồm** "userdata/snapshot của AVD đang hoạt động (khi `keepSnapshots=true`)", đây là bảo đảm "ứng dụng đã cài sẽ không bị dọn" (assert ở auto-test:174).
- `after` của `prune` chỉ là `total - saved`, không quét lại, khi xóa thật thất bại sẽ hơi lệch với thực tế.

### Được ai gọi
- `src/core/engine.js:1017` (`usage()` → `summary`), `:1019-1023` (`cleanup()` → `prune`).
- `src/main.js:1004` (`runtime:usage` → `runtime.usage()` → `summary`), `:1056-1071` (`runtime:cleanup`: trước tiên `apply:false` lấy danh sách → `dialog.showMessageBox` xác nhận lần hai → `apply:true`).
- `src/ui/app.js` (bảng "dung lượng/dọn dẹp" trên trang cài đặt, qua `runtime:usage`/`runtime:cleanup`).
- `test/auto-test.js:25,157,167,171`.

### Độ phủ kiểm thử
- ✓ `auto-test.js:139` Kiểm kê mục có thể thu hồi: QEMU không phải x86_64, ảnh cũ, AVD cũ, tệp khóa, snapshot cũ (gồm dryRun không xóa, sau `apply` vẫn giữ AVD đang hoạt động và QEMU x86_64)
- **Chưa phủ**: 4 thư mục phụ của `summary()`, nhánh `aggressive`, giới hạn độ sâu.

---

## 7. Bộ bốn tiện ích nhỏ

### 7.1 `src/core/logfile.js` — cuộn log theo kích thước

| Xuất | Chữ ký | Mô tả |
|---|---|---|
| `rotate` | `(file, limitKB) => bool` | 15-26: `size < limit` trả về false; nếu không xóa `.1.log` cũ → `rename` thành `.1.log` |
| `append` | `(file, line, limitKB=2048) => bool` | 33-45: **lần đầu của mỗi tiến trình + mỗi 200 dòng** thì rotate một lần (39), `appendFileSync` bổ sung xuống dòng |
| `trimNow` | `(file, limitKB=2048) => bool` | 48-50: khi khởi động kiểm tra một lần vô điều kiện |

- Trách nhiệm: `app.log` / `emulator.log` append lâu dài sẽ bị đầy (header 2-9), chỉ giữ **một bản** `.1.log`.
- Bẫy: `limitKB` bị `Math.max(256, ...)` kẹp ≥256KB (39, 49); `counters` là `Map` cấp mô-đun, khởi động lại tiến trình thì về 0; `rotate` dùng `renameSync`, trên Windows tệp bị chiếm sẽ thất bại và trả về false (lặng lẽ).
- Được ai gọi: `src/main.js:85` (`appLog`, `logs/app.log`), `src/core/emulator.js:577` (log emulator).
- Kiểm thử: ✓ `auto-test.js:1404` Log vượt giới hạn thì tự cuộn, chỉ giữ một bản sao lưu.

### 7.2 `src/core/notify.js` — thông báo Android → thông báo Windows

| Xuất | Chữ ký | Mô tả |
|---|---|---|
| `parseRecords` | `(văn bản dumpsys) => [{pkg,key,title,text}]` | 34-63 |
| `NotifyBridge` | `new NotifyBridge({getClient,getAppLabel,getAppIcon,onOpen})` | `start()/stop()`, bên trong `setInterval(_tick, POLL_MS=2500)` (11, 77-89) |

Triển khai then chốt:
- Mỗi 2,5s `client.shell('dumpsys notification --noredact', {timeout:12000})` (97), **trước tiên `isOnline()`** (96);
- Lọc: danh sách trắng `SYSTEM_PKGS` + `com.android.providers.*` + `launcher` (18-32); bỏ qua `FLAG_ONGOING_EVENT(0x2)`, `FLAG_FOREGROUND_SERVICE(0x40)` (43-45);
- `_tick` lần đầu chỉ lập mốc `primed`, tránh việc vừa khởi động đã bật lại toàn bộ thông báo lịch sử (99-104); `seen` vượt 500 mục thì cắt còn 300 (113);
- Nhấp `note.on('click')` → `onOpen(pkg)` (130);
- Cấp trên cùng của mô-đun `require('electron')` (9) → **kiểm thử Node thuần không chạy được**, nên `test/notify-test.js` chạy bằng electron.

Được ai gọi: `src/main.js:36,682-697` (`startNotifier()`, chỉ được `onContainerActive(true)` khởi động khi container có cửa sổ ứng dụng, `:670-678` khi đóng thì `stop()`; `:1772` khi thoát thì stop).
Kiểm thử: `test/notify-test.js` (dùng dump thật `test/notif.txt` gọi `parseRecords`, **không nằm trong `npm test`**); bản thân `NotifyBridge` không được phủ.

### 7.3 `src/core/android.js` — công tắc cài đặt Android (không cần vào màn hình chính)

| Xuất | Mô tả |
|---|---|
| `ACTIONS` | 11 hằng số action `android.settings.*` (7-19) |
| `AndroidSettings` | `new AndroidSettings(runtime)`; các phương thức `status()`, `setWifi`, `setAirplane`, `setVolume`, `setAnimations`, `setFontScale`, `setDensity`, `tune({pkg})`, `open(action)`, `permissions(pkg)`, `grantAll(pkg)` |

Triển khai then chốt:
- `client()` mỗi lần đều `await runtime.ensure()` (24-28), thất bại thì ném "runtime chưa sẵn sàng";
- `_sh(commands)` nối nhiều lệnh bằng `; ` thành **một lần** `adb shell` (30-34), timeout 20s;
- `status()` dùng `echo "k=$(...)"` lấy 7 giá trị một lần rồi phân tích bằng regex (37-61);
- `tune()`: tắt ba hiệu ứng + `max_cached_processes=32` + tùy chọn `deviceidle whitelist +pkg` (111-121);
- `permissions()` phân tích đoạn `runtime permissions:` của `dumpsys package`, kết thúc theo thụt lề (131-145); `grantAll()` lần lượt `pm grant`, thất bại thì bỏ qua (147-156);
- Phạm vi giá trị: `fontScale 0.85~1.3`, `density 120~640`, `volume 0~100` (79-108).

Được ai gọi: `src/main.js:1501` (`androidSet = new AndroidSettings(runtime)`), `:1404-1434` (IPC `android:status/set/open/tune/permissions/grantAll`); `src/preload.js` phơi ra cho trang cài đặt.
Kiểm thử: **✗ không được phủ** (cần adb thật).

### 7.4 `src/core/display.js` — tính toán thuần cho thích ứng hiển thị

| Xuất | Chữ ký | Mô tả |
|---|---|---|
| `densityFor` | `(w,h,manual) => dpi` | Khi `manual>0` thì kẹp 120~640; nếu không `min(w,h)/2.57` kẹp 200~480 (7-10) |
| `portraitSize` | `(str) => {w,h}` | Phân tích `900x1600`, không hợp lệ/nằm ngang thì trả về `{900,1600}` (12-18) |
| `defaultBounds` | `(area) => {x,y,w,h}` | Chiều cao `area.h*0.84`, rộng 9:16, căn giữa (20-28) |
| `fullscreenBounds` | `(portrait, area) => {x,y,w,h}` | Phủ kín chiều cao, tính chiều rộng theo tỉ lệ dọc, căn giữa ngang (36-46) |
| `sizeFor` | `(mode, portrait, area) => {w,h}` | **Cả hai chế độ đều trả về thiết lập sẵn dọc** (55-57) |

Bất biến then chốt (ghi trong chú thích): tỉ lệ khung cửa sổ trình giả lập **bị LCD khóa chết lúc khởi động**, `SW_MAXIMIZE` trực tiếp chỉ ra một cửa sổ dính mép trái, chiều rộng không đổi; vì vậy "toàn màn hình" = phóng to cửa sổ mà **không đổi độ phân giải Android** (48-54), chuyển chế độ không cần khởi động lại runtime.

Được ai gọi: `src/main.js:32` (require), `:274-277` (`portraitSize()` đọc `display.portrait`) — **chỉ `portraitSize` được dùng trong mã runtime**; `densityFor/defaultBounds/fullscreenBounds/sizeFor` hiện chỉ được kiểm thử gọi (`appwin.js:46` có bản `AppWindow.sizeFor` riêng).
Kiểm thử: ✓ `auto-test.js:465` Thích ứng hiển thị: cửa sổ/toàn màn hình dùng chung độ phân giải dọc, tỉ lệ cửa sổ 9:16 kéo giãn được (phủ 4 hàm).

---

## 8. Toàn bộ chuỗi tải / triển khai / cập nhật

### 8.1 Lưu đồ dạng văn bản

```
[Người dùng nhấn "Hoàn tất một chạm"]
src/ui/app.js:371  deployAll()
   ├─ setStepBusy('all',true)  → nhãn nút "Đang chuẩn bị…" (app.js:334)
   ├─ api.autoDeploy()         → preload.js:45  invoke('runtime:autoDeploy')
   └─ IPC runtime:autoDeploy   → main.js:870
        └─ autoDeploy()        → main.js:314  (có khóa loại trừ deploying, main.js:313/315)

[Luồng chính autoDeploy main.js:314-354]
 1. env = provisioner.checkEnv()                           main.js:319
 2. needEngine = !env.emulator.ok || !env.sysimg.ok        main.js:320
 3. if needEngine && settings.runtime.preferGithubRuntime:
      installRuntimePack(progress)                          provision.js:522
        ├─ resolveRuntimePack()                             provision.js:476
        │    ├─ runtimePackUrl tự định nghĩa? Dùng luôn       :477
        │    ├─ GET song song GitHub / Gitee releases?per_page=15  :487
        │    └─ Tìm assets /^ApkStart-runtime-.*\.zip$/, cmpVer lấy cao nhất  :497-515
        ├─ guardDisk('runtime', root)   [512+1024=1536MB]    :525 → :262
        ├─ sources.rank(sources.candidates(url))  đo tốc độ tuần tự   :534-536 → sources.js:399
        ├─ downloadMulti(urls, _tmp/runtime-pack.zip)        :541 → download.js:338
        │    ├─ Dò Range song song → chỉ trộn các nguồn "cùng tổng kích thước"   download.js:355-381
        │    ├─ Chia khối 8 luồng phân xoay vòng + tệp phụ .chunks.json     download.js:391-416
        │    └─ Watchdog nhàn rỗi 20s / chậm 45s&<120KB/s thì đổi nguồn      download.js:449-503
        ├─ Cổng kích thước <200MB → ném "tải trọn gói không đầy đủ"            :556
        ├─ extractZip(zip, root)   >64MB dùng ZipFile theo luồng     :559 → :591
        ├─ Ghi <root>/.runtime-pack.json, xóa zip              :566-571
        └─ materializeImages()  .img.xz/.gz → .img           :573-576 → :722
      afterPack = checkEnv()                                 main.js:328
      if emulator.ok && sysimg.ok → return {ok:true,source:'github'}
      else → tiếp tục bổ sung từ nguồn chính thức (main.js:330)
 4. Dự phòng từng thành phần từ nguồn chính thức (chỉ khi bước trước thất bại/không đầy đủ):
      installAdb()          provision.js:428  → downloadAny  platform-tools.zip
      installEmulator()     provision.js:905  → downloadAnyParallel + extractZip + ensurePlatformTools
      installSystemImage()  provision.js:966  → installPlayImage(:1004) → downloadAnyParallel + extractZip
 5. after = checkEnv(); ok = adb.ok && emulator.ok && sysimg.ok   main.js:347-348
 6. finally deploying=false                                 main.js:351-353

[UI tiếp theo khởi động máy app.js:381-387]
 api.runtimeStart() → main.js:880 → runtime.ensure()        từ engine.js:787
   ├─ provisioner.materializeImages(onLog).catch(()=>{})     engine.js:848
   ├─ checkEnv()                                             engine.js:849
   ├─ killOrphanEmulators()                                  engine.js:856
   └─ boot()  thất bại thì doctor chẩn đoán + thử lại biến thể (GPU/accel/bộ nhớ hạ dần từng cấp)

[Hai chuỗi nền sau khi khởi động]
 A. Tự triển khai (trễ 20s) main.js:1657-1661 → autoDeploy()   ← cùng một hàm với UI
 B. Kiểm tra cập nhật (sau đóng gói, trễ 8s) main.js:1665-1676
      updater.check()                     updater.js:73
        └─ sources.latest({force})        sources.js:277
             ├─ fetchReleases() song song GitHub/Gitee            :237
             ├─ 403/429 → ngắt mạch 15min                          :286-290
             ├─ Tất cả thất bại → kết quả lần trước + stale        :292-298
             └─ Gộp tài sản cùng phiên bản (urls[] + sizes{}), giữ parts  :304-348
      info.hasUpdate → notify + send('update:state')

[Người dùng nhấn "Cập nhật ngay"]
 main.js:579 runUpdate()  (loại trừ updateBusy)
   ├─ updater.prepare(info)                              updater.js:121
   │    ├─ parts?  _downloadParts()  mỗi phần tự đo tốc độ+tải+ghép tuần tự  :182
   │    └─ nếu không  candidates→rank→downloadMulti          :140-163
   │    └─ .zip → _extract vào update/<ver>/payload         :166-173
   ├─ updater.apply(job)                                  updater.js:258
   │    ├─ Sinh script PS (Wait-Process 90s → sao chép/cài im lặng → khởi động lại → dọn dẹp → exit 0)
   │    ├─ Ghi ra đĩa update/apply.log.ps1 (để điều tra)               :310
   │    └─ spawn powershell -EncodedCommand (**không detached**) + unref  :319-323
   └─ setTimeout(900ms) → quitting=true; app.quit()        main.js:596
        └─ Script chờ tiến trình thoát → ghi đè thư mục cài → Start-Process exe → xóa update/<ver>
```

Các con số thời gian then chốt (đều là hằng số dùng một lần, người tiếp quản đừng tùy tiện giảm):
- `autoDeploy` trễ **20s** (`main.js:1661`, chú thích: lúc khởi động nguội đĩa/CPU đã đầy tải);
- Kiểm tra cập nhật trễ **8s** và chỉ khi `app.isPackaged` (`main.js:1665-1675`);
- Trong `apply`: `Wait-Process -Timeout 90`, sao chép **12 vòng ×600ms**, sau khi khởi động lại 400ms thì dọn dẹp (`updater.js:271-306`);
- Sau khi `apply` trả về **900ms** thì thoát ứng dụng (`main.js:596`);
- `downloadMulti`: khối nhàn rỗi **20s**, ngưỡng chậm **45s + 120KB/s**, mỗi khối thử lại **6** lần, đổi nguồn tối đa **2** lần;
- `download` (đơn luồng): nhàn rỗi **30s**, không phải 2xx thì thử lại **2** lần ×1,5s.

### 8.2 Các khâu dễ hỏng nhất trên chuỗi này

| # | Hiện tượng (góc nhìn người dùng) | Vị trí mã | Cơ chế / ghi chú |
|---|---|---|---|
| 1 | **"Kẹt ở chuẩn bị runtime"**, thanh tiến độ dừng lâu ở 1~3% | `provision.js:531` (cố định `percent:1`) + `sources.js:412-417` (đo tốc độ **tuần tự**, mỗi địa chỉ ≤9s) + `sources.js:52` (256KB/lần) | 4 ứng viên (trực tiếp+2 mirror+Gitee) là 30s+ "không có tiến độ byte nào". Mạng càng tệ ứng viên càng nhiều, càng giống treo |
| 2 | Tiến độ **dừng ở 99% rất lâu**, rồi lại nhảy về "chuyển sang nguồn chính thức để bổ sung" | `provision.js:575-576` (`materializeImages(...).catch(()=>0)`) + `:790` (một ảnh thất bại chỉ onLog) | Bung `.xz` thất bại bị hai lớp catch nuốt → `checkEnv().sysimg.ok=false` → `autoDeploy` đi `main.js:330` tải thêm một bộ 1,4GB; lần khởi động sau vẫn thử bung lại |
| 3 | Lỗi lộn xộn liên quan `@napi-rs/lzma` | `provision.js:771-781` (`require.resolve('@napi-rs/lzma')` rồi require `index.js` theo đường dẫn tệp) | Khi đóng gói nếu binary lzma không được mang theo/bị asar nén → `Cannot find module`; chú thích giải thích vì sao không thể `require('@napi-rs/lzma')` trực tiếp (ESM polyfill) |
| 4 | **"Đã đặt thư mục runtime mà vẫn tải vào AppData"** | `provision.js:217-224` (ba nhánh `sysImgRoot`), `:726` (đích của `materializeImages`), `:237` (`avdHome`), `store.js:67-98` (`runtime.dir` mặc định trống), `main.js:97-171` (`bootstrapBundledRuntime` **sẽ ghi đè** `runtime.dir`) | ① Người dùng cũ đã có `<DATA_DIR>/system-images` → nhánh 2 tiếp tục dùng nó, không dời đi; ② Khi cạnh exe bản portable có `runtime/`, `bootstrapBundledRuntime` ở `main.js:165-168` gọi thẳng `saveSettings({runtime:{dir: bundled}})`, thư mục người dùng tự đặt bị ghi đè (chỉ khi `sameTree && emulator.exe tồn tại` mới tôn trọng cài đặt cũ, `:144-148`); ③ AVD có cài đặt `avdDir` riêng, có thể khác ổ với thư mục runtime |
| 5 | Đĩa rõ ràng đủ mà báo "thiếu dung lượng", hoặc ngược lại giải nén giữa chừng thì thất bại | `provision.js:262-277` (bảng `need` 264-265 không có `'runtime'`), `main.js:940` (ngưỡng tự kiểm 8192MB) | `guardDisk('runtime')` chỉ ước 1536MB, trọn gói + bung thực tế cần ~5GB; qua guard rồi vẫn có thể làm đầy ổ |
| 6 | Tiến độ **kẹt ở 95% không nhúc nhích** (issue lịch sử) | Đã có đối sách: `download.js:446-451,492-503` (đổi nguồn khi chậm), `:466-480` (đảm bảo settle); đường đơn luồng vẫn chỉ có `idleMs=30s` (`:112`) | Khối đuôi kéo dài do nguồn chậm; tệp phụ (`.chunks.json`) đảm bảo thử lại chỉ bổ sung khối thiếu, không tải lại nguyên gói |
| 7 | Sau "kết nối bị ngắt / đình trệ" cả lượt tải bị hủy | `download.js:155` (`close` mà `!complete` → reject), `:526-528` (khối hết lượt thử → ném + lưu tệp phụ) | Thiết kế cho phép tải tiếp; nhưng `downloadParallel` thấy tệp dở dang là hạ về đơn luồng (`:188-191`), đa luồng thoái hóa thành đơn luồng |
| 8 | Cập nhật kẹt ở "đang thay thế chương trình và khởi động lại" | `updater.js:315-323` (chú thích tương thích **không được detached**), `:271` (Wait-Process 90s), `:280-285` (sao chép 12 vòng) | Phần mềm bảo mật chặn "tiến trình tách rời" → script không chạy; hoặc gỡ/cài bị UAC chặn; `update/update.log` là hiện trường duy nhất |
| 9 | Cập nhật xong thư mục chương trình dư ra tệp lạ 1,5GB | `updater.js:80` (bản portable dự phòng `/\.zip$/i`) | Nếu một phiên bản chỉ có `ApkStart-runtime-vX.zip` mà không có tài sản `portable`, nó sẽ bị coi là gói cập nhật và giải nén vào thư mục cài |
| 10 | Trên Gitee "có một phiên bản không có gói cài" | `.github/workflows/release.yml:36-44,78-100` (cổng 100MiB + thiếu `GITEE_TOKEN` thì thất bại luôn); phía tiêu thụ `sources.js:172-204`, `updater.js:182-227` | Vấn đề ở khâu build, nhưng hiện tượng xuất hiện ở đây; các phần phải liên tục `part1..N`, nếu không cả nhóm bị bỏ (`sources.js:196-203`) |
| 11 | Đổi nguồn/sửa tiền tố mirror mà vẫn đi địa chỉ cũ | `main.js:819-825` chỉ `sources.reset()`; `_cache.*` ở `provision.js:479,514,642,664,984` không có lối vô hiệu hóa | Cần khởi động lại tiến trình mới có hiệu lực hoàn toàn |
| 12 | Thăm dò trạng thái làm đầy CPU/tiến trình | `provision.js:687-714` (`emulatorVersion` thất bại không đệm), `:298-315` (adb đệm 30s), `:845-902` (accel 30s + trên đĩa 6h/10min) | Khi chưa cài emulator, mỗi lần `checkEnv` đều `execFile` dò nhiều đường dẫn |
| 13 | AVD bị phán "đang bị chiếm" nên không khởi động được | `layers.js:87-90` (danh sách tệp khóa), `main.js:963-969` (tự kiểm phát hiện `.lock`), `engine.js:856` (`killOrphanEmulators`) | Lần thoát bất thường trước còn sót `*.lock`, bảng dọn dẹp có thể thu hồi |
| 14 | Lần khởi động đầu làm mất "ứng dụng/dữ liệu đã cài" | `store.js:179-184` (ba chỗ cưỡng bức di trú), `engine.js:848` (`materializeImages`), `doctor.snapshotKey`/`imageIdentity` (dấu vân tay snapshot, `auto-test.js:88,98`) | Di trú là một chiều; dấu vân tay snapshot **không bao gồm kích thước phân vùng dữ liệu** (`auto-test:1395`), mở rộng dung lượng không xóa dữ liệu |

### 8.3 Ba điều "xem ở đây trước" cho người tiếp quản

1. **Chỉ cần xem một hàm là giải thích được tám phần vấn đề triển khai**: `Provisioner.checkEnv()` (`provision.js:367`). Nó đồng thời quyết định "thiếu gì" trên UI, nhánh của `autoDeploy`, việc `engine.ensure()` đi emulator hay qemu, và nội dung báo cáo chẩn đoán.
2. **Quy tắc đường dẫn chỉ có một chỗ**: `Provisioner.paths()` (`provision.js:197`). Bất kỳ code mới nào cần ghi tệp runtime đều phải lấy đường dẫn từ đây, đừng tự ghép `DATA_DIR`.
3. **Chiến lược tải đều quy về `Sources` + `downloadMulti`**: thêm nguồn mới chỉ cần đưa vào `candidates()`; thêm logic "giới hạn tốc độ/chọn tốt nhất" chỉ cần sửa `rank()` và điều kiện trộn nguồn của `downloadMulti`, đừng viết thêm một bộ khác trong `provision.js`.
