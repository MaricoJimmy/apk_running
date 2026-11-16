# Đọc hiểu mã nguồn ngăn xếp phân tích ngoại tuyến của ApkStart (WIP)

> Đối tượng: kỹ sư sẽ tiếp nhận dự án này và tiếp tục phát triển chuỗi "APK → biểu tượng → lối tắt".
> Cách đọc: chỉ đọc mã + grep điểm gọi, không chạy bất kỳ lệnh nào làm thay đổi trạng thái.
> Phiên bản tham chiếu: `package.json` version `0.3.5` (electron ^33.4.11, node >=20).
> Mọi `tệp:số dòng` đều ứng với ảnh chụp workspace hiện tại, sau khi sửa đổi xin tiện tay cập nhật.

Các tệp được đọc (`src/core/*.js` có tổng cộng 29 tệp, ở đây chỉ bao quát nhóm phân tích/biểu tượng/liên kết/phiên bản/nhật ký):

| Tệp | Số dòng | Định vị trong một câu |
|---|---|---|
| `src/core/zip.js` | 236 | Trình đọc ZIP chỉ dùng `zlib` (bản trong bộ nhớ + bản stream theo fd) |
| `src/core/axml.js` | 167 | Trình phân tích XML nhị phân của AndroidManifest.xml |
| `src/core/arsc.js` | 233 | Trình phân tích rút gọn resources.arsc (khôi phục tham chiếu @0x7f) |
| `src/core/png.js` | 132 | Bộ mã hóa PNG không phụ thuộc + biểu tượng thương hiệu vẽ bằng chương trình |
| `src/core/apk.js` | 190 | Điểm vào chung cho siêu thông tin APK `parseApk()` |
| `src/core/shortcut.js` | 183 | Tạo ICO nhiều kích thước + ghi .lnk |
| `src/core/assoc.js` | 68 | Liên kết tệp .apk dưới HKCU |
| `src/core/version.js` | 36 | So sánh số phiên bản (tách riêng để tránh phụ thuộc vòng) |
| `src/core/logfile.js` | 52 | Ghi nối + cuộn theo kích thước (module nhỏ cho nhật ký/công cụ) |
| `src/core/display.js` | 59 | Tính toán thuần cho thích ứng hiển thị (phụ lục: cũng thuộc nhóm module nhỏ "công cụ thuần") |

---

## 1. `src/core/zip.js`

### Trách nhiệm
Trình đọc ZIP tối giản dùng `zlib` có sẵn của Node: chỉ phân tích central directory, giải nén từng mục theo nhu cầu; ngoài ra còn một phiên bản stream dựa trên file descriptor, chuyên để xử lý ảnh hệ thống cỡ GB.

### Giao diện công khai
```js
const { ZipArchive, ZipFile } = require('./zip');

new ZipArchive(buffer /*: Buffer, toàn bộ gói */)
  .entries        // Map<string, {name, flags, method, compSize, uncompSize, localOffset}>  ← trường công khai, bên ngoài đọc trực tiếp
  .has(name)      // → boolean
  .names()        // → string[]
  .find(re)       // (RegExp) → string[] (tên các mục khớp)
  .read(name)     // → Buffer | null (mục không tồn tại trả về null; local header hỏng/phương thức nén không hỗ trợ thì throw)
  .pipeTo(name, dest /*: Writable */)  // → Promise<number> (resolve kích thước chưa nén, tiện kiểm tra số byte đã ghi xuống đĩa)

new ZipFile(filePath /*: string */)
  .size           // số byte của tệp
  .entries        // như trên
  .has / .names / .find          // như trên
  .close()        // idempotent; fd đặt thành null
  .read(name)     // → Buffer (không tồn tại thì throw, không trả về null —— không nhất quán với ZipArchive!)
  .pipeTo(name, dest)  // → Promise<number>
```
> Lưu ý giao diện không đối xứng: `ZipArchive.read` thiếu mục thì trả về `null`, `ZipFile.read` ném lỗi "mục không tồn tại". Trong `apk.js` có kiểm tra rỗng `if (data && ...)` cho kết quả của `zip.read(...)` chính là vì trường hợp thứ nhất.

### Cài đặt nội bộ quan trọng

**ZipArchive —— đọc toàn bộ gói vào bộ nhớ (không phải stream)**
- Hàm khởi tạo nhận trực tiếp `Buffer` do bên gọi đưa vào (`zip.js:14`), tự nó không đụng tới đĩa. Vì vậy "có đọc toàn bộ gói vào bộ nhớ hay không" phụ thuộc vào bên gọi: `apk.js:78` là `fs.readFileSync`, `installer.js:27` cũng vậy → **đường phân tích APK 100% giữ toàn bộ gói trong bộ nhớ**.
- `_parse()` (`zip.js:20`): quét ngược `EOCD_SIG` từ cuối `buf.length-22`, cận dưới `buf.length - 65557` (`zip.js:23`, = 22 byte EOCD + 65535 byte chú thích tối đa). Tìm thấy rồi thì `total` lấy ở `+10` (u16), offset central directory lấy ở `+16` (u32).
- Vòng lặp central directory (`zip.js:32-47`): bước tiến 46 + nameLen + extraLen + commentLen, các offset trường 8/10/20/24/28/30/32/42 khớp với đặc tả PKZIP; tên luôn được giải mã theo UTF-8 (`zip.js:42`), **không xử lý GP flags bit 11**.
- `read()` (`zip.js:54`): trước tiên kiểm tra chữ ký local file header `LOC_SIG`, sau đó dùng nameLen/extraLen trong **local header** để tính điểm bắt đầu dữ liệu (`zip.js:61-63`, không được dùng độ dài của central directory, hai giá trị có thể khác nhau); `method 0` trả về `Buffer.from(raw)` (**sao chép một bản**, `zip.js:65`); `method 8` dùng `zlib.inflateRawSync` (`zip.js:66`).
- `pipeTo()` (`zip.js:80`): cắt `raw` thành lát 1MB đưa vào `createInflateRaw`, khi `write()` trả về false thì `once('drain')` để đẩy tiếp (`zip.js:105-116`); `dest.on('finish')` và `dest.on('error')` dùng chung `done`, thành công thì resolve `e.uncompSize` (bên gọi có thể dùng để kiểm tra số byte). **Lưu ý dữ liệu vốn đã nằm trong bộ nhớ, chia lát chỉ để tránh zlib nuốt một lần cả GB dữ liệu, không phải để tiết kiệm bộ nhớ.**

**ZipFile —— fd + cửa sổ cuối tệp**
- Khởi tạo: `fs.openSync(path,'r')` + `statSync` (`zip.js:134-135`), khi `_parse()` thất bại thì tự động `close()` rồi mới ném lỗi (`zip.js:137`, chống rò rỉ fd).
- Chỉ đọc `min(size, 22 + 65557 + 4096)` byte ở cuối (`zip.js:152`, tối đa 69675B) để quét EOCD; nếu central directory không nằm trong cửa sổ này (chú thích quá dài, v.v.), thì đọc riêng `readAt(cdOffset, min(eocdAbs-cdOffset, 64MB))` (`zip.js:166-172`).
- `_readAt` (`zip.js:145`): `Buffer.alloc(len)` + **một lần** `fs.readSync`. POSIX cho phép đọc thiếu (short read), ở đây không có vòng lặp thử lại → về lý thuyết central directory 64MB có thể bị cắt cụt âm thầm (tệp cục bộ trên Windows thường không gặp, đổi sang ổ mạng/ổ ảo thì cần cẩn thận).
- `read()` (`zip.js:206`) đọc toàn bộ `compSize` của mục vào bộ nhớ rồi mới inflate —— **mục lớn vẫn đụng giới hạn 2GB**; `pipeTo()` (`zip.js:214`) mới là stream: `createReadStream(null,{fd, autoClose:false, start, end})`, `end` là **khoảng đóng** (`zip.js:203` đã là `start+compSize-1`).
- `_range()` (`zip.js:195`) mỗi lần đọc 30 byte local header để kiểm tra chữ ký, trả về `{e,start,end}`.

**Giới hạn 2GB rốt cuộc nằm ở những dòng nào**
| Vị trí | Ý nghĩa |
|---|---|
| `zip.js:75-79` (chú thích) | Ghi rõ "mục cỡ GB không thể inflate nguyên khối, sẽ đụng giới hạn 2GB cho một Buffer của Node", đây là lý do `pipeTo` tồn tại |
| `zip.js:37` / `zip.js:180` | `uncompSize`, `compSize` đọc bằng `readUInt32LE` → **không có Zip64**, mục >4GiB sẽ đọc ra giá trị bị cắt cụt/bí danh |
| `zip.js:29-30` / `161-162` | `total` là u16 (số mục >65535 thì không còn đúng), `cdOffset` là u32 (dưới Zip64 là `0xffffffff`, sẽ rơi vào nhánh "offset bất thường" ở `zip.js:166` và ném lỗi) |
| `zip.js:208` | `ZipFile.read()` cấp phát một Buffer cho toàn bộ `compSize` → mục đơn >2GB thì trực tiếp `ERR_BUFFER_TOO_LARGE` |
| `apk.js:78` | `readFileSync` toàn gói → một APK >2GB (hoặc >`buffer.constants.MAX_LENGTH`) thất bại ngay ở giai đoạn đọc, không vào được tới lớp zip |

### Cạm bẫy và bất biến
1. **nameLen/extraLen của local header và central directory phải đọc riêng** (`zip.js:61-63`, `198-202`). Hai bên có thể khác nhau (đặc biệt khi có data descriptor hoặc padding căn lề), dùng giá trị của central directory để tính điểm bắt đầu dữ liệu cục bộ là cách sửa hỏng phổ biến nhất.
2. **data descriptor (GP bit 3) không cần xử lý đặc biệt**: vì kích thước sau nén lấy từ central directory (`zip.js:36/179`), ba trường trong local header có là 0 cũng không sao. Điểm này ổn định hơn nhiều trình phân tích ZIP dạng stream.
3. **Không kiểm tra bit mã hóa**: `flags` chỉ được lưu lại (`zip.js:34`), chưa bao giờ xét bit 0; mục bị mã hóa sẽ báo lỗi dưới dạng "inflate thất bại", thông báo lỗi không chỉ ra nguyên nhân thật.
4. **Central directory bị cắt cụt sẽ âm thầm thiếu mục**: `break` ở `zip.js:176` thoát thẳng khi `off+46 > cd.length` hoặc chữ ký sai, không ném lỗi. Biểu hiện là "APK rõ ràng có lib/, nhưng abis lại rỗng".
5. `ZipArchive.entries` là `Map` công khai, `apk.js:31`, `apk.js:44`, `provision.js:608` đều trực tiếp `entries.get(name)` để đọc `uncompSize`, đổi cấu trúc dữ liệu sẽ kéo theo ba chỗ.
6. `dest` của `pipeTo` phải là writable stream và do bên gọi tạo (`provision.js:611`, `updater.js:239` đều là `fs.createWriteStream`), bên trong hàm không close dest, chỉ chờ `finish`.
7. `ZipFile` dùng xong phải `close()` (`provision.js:619` dùng `finally`, `updater.js:249` cũng vậy), nếu không sẽ rò rỉ fd.
8. Giải mã tên thống nhất dùng `utf8`, ZIP cũ có tên tệp GBK sẽ bị lỗi ký tự, nhưng trong bối cảnh APK đều là đường dẫn ASCII, không có ảnh hưởng thực tế.

### Được ai gọi
`ZipArchive`:
- `src/core/apk.js:8` (require), `apk.js:79` (đường chính của `parseApk`)
- `src/core/installer.js:12`, `installer.js:27` (`parseBundle`, tách .apks/.xapk)
- `src/core/provision.js:15`, `provision.js:595` (gói nhỏ đi bản trong bộ nhớ)
- `test/run-tests.js:29`, `57`; `test/run-tests.js:119`, `124` (fixture thật)
- `test/engine-test.js:167`, `194`
- `test/auto-test.js:277`, `319`

`ZipFile`:
- `src/core/provision.js:15`, `595` (>64MB đi bản tệp)
- `src/core/updater.js:21`, `230` (`_extract`, giải nén gói cập nhật)
- `test/auto-test.js:277`, `320` (so sánh tính nhất quán với `ZipArchive`)

`pipeTo`:
- `src/core/provision.js:611`, `src/core/updater.js:239`, `src/core/zip.js:80` (chính nó)

### Độ bao phủ test
- `test/run-tests.js:30` "Phân tích được cấu trúc gói nén package.json của chính dự án" —— tên nghe dọa người, thực tế là tự tay dựng một zip stored tối giản (`run-tests.js:32-57`), chỉ bao quát `has` + `read`.
- `test/engine-test.js:166` "Giải nén ZIP tích hợp hoạt động" —— bao quát gián tiếp `ZipArchive` + `pipeTo` qua `Provisioner.extractZip` (`provision.js:591`).
- `test/auto-test.js:275` "ZipFile và ZipArchive cho kết quả phân tích nhất quán trên cùng một gói nén (gồm deflate và stream pipeTo)" —— test case duy nhất đồng thời kiểm tra stored/deflate, `read`/`pipeTo` và cả hai lớp, `auto-test.js:278-315` tự ghép byte.
- **Lỗ hổng**: không có Zip64, không có "central directory bị cắt cụt", không có bit mã hóa, không có test case cho `find()`; đường mục lớn của `ZipFile.read()` không được bao phủ.

---

## 2. `src/core/axml.js`

### Trách nhiệm
Phân tích `AndroidManifest.xml` đã biên dịch trong APK (XML nhị phân / AXML) thành cây DOM thông thường, để tầng trên truy vấn theo thẻ/thuộc tính.

### Giao diện công khai
```js
const { parseAxml, attr, attrValue, children, ANDROID_NS, TYPE_REFERENCE } = require('./axml');

parseAxml(buffer /*: Buffer */)   // → node (gốc là manifest; không phải AXML hoặc manifest rỗng thì throw)
// node = { name: string, attrs: Attr[], children: node[], parent: node|null }
// Attr = {
//   ns: string,        // '' nghĩa là không có namespace (nsIdx = 0xffffffff)
//   prefix: string,    // được duy trì bởi các sự kiện start/end của namespace, lấy prefix "khai báo sau cùng"
//   name: string,      // tên thuộc tính (string pool)
//   value: string|number|boolean|null,  // ưu tiên rawValue, sau đó diễn giải theo dataType
//   refId: number|null,   // chỉ có giá trị khi dataType=TYPE_REFERENCE(0x01) (không dấu)
//   dataType: number,  // giá trị gốc của Res_value.dataType
//   typed: string|number|boolean|null,  // là null khi là reference, còn lại giống value
// }

attr(node, name, ns = ANDROID_NS)   // → Attr | null; ns truyền null nghĩa là không giới hạn namespace
attrValue(node, name, ns = ANDROID_NS)  // → Attr.typed | null
children(node, name)                // → node[] (lọc theo tên thẻ, không đệ quy)
ANDROID_NS = 'http://schemas.android.com/apk/res/android'
TYPE_REFERENCE = 0x01
```

### Cài đặt nội bộ quan trọng

**`readStringPool(buf, start)` (`axml.js:26-62`)**
- Header: `type@0`, `headerSize@2`, `chunkSize@4`, `count@8`, `flags@16`, `stringsStart@20`; `isUtf8 = flags & 0x100` (`axml.js:34`).
- Bảng offset nằm ngay sau header: `start + headerSize + i*4` (`axml.js:38`); địa chỉ cơ sở của chuỗi là `start + stringsStart` (`axml.js:40`).
- Pool UTF-8 phải đọc **hai** độ dài biến đổi: trước là "độ dài UTF-16" (có thể 1~2 byte, `axml.js:47-48`), sau đó là "độ dài byte UTF-8" (`axml.js:50-51`), cắt lát dùng **cái sau**. Pool UTF-16 thì độ dài là 1~2 u16, đơn vị là code unit (cắt lát `len*2`, `axml.js:58`).
- Trả về `{ strings, chunkSize }`, bên gọi chỉ lấy `strings` (`axml.js:88`).

**`parseAxml(buffer)` (`axml.js:67-150`)**
- Kiểm tra header `RES_XML_TYPE(0x0003)` (`axml.js:69`), `pos = readUInt16LE(2)` (headerSize), `total = readUInt32LE(4)` (`axml.js:72-73`).
- Lặp từng chunk `while (pos + 8 <= total && pos < buf.length)` (`axml.js:81`), đọc `type/headerSize/chunkSize`, `chunkSize <= 0` thì `break` ngay để tránh vòng lặp vô hạn (`axml.js:85`).
- Namespace: `nsStack` lưu uri, `prefixByUri` ghi uri→prefix (`axml.js:76-77`); khi START thì đồng thời push + set, khi END chỉ pop (`axml.js:89-97`). **Khi cùng một uri được khai báo nhiều lần thì prefix là "sau ghi đè trước"**, `prefixByUri` không bao giờ được dọn.
- START_ELEMENT (`axml.js:98`):
  ```js
  nameIdx   = readUInt32LE(pos + 20)
  attrStart = readUInt16LE(pos + 24)   // offset tương đối so với ResXMLTree_attrExt
  attrSize  = readUInt16LE(pos + 26)   // kích thước một thuộc tính, bình thường là 20
  attrCount = readUInt16LE(pos + 28)
  const attrBase = pos + 16 + attrStart;   // ★ axml.js:106
  ```
- Mỗi thuộc tính 20 byte: `ns@0`, `name@4`, `rawValue@8`, `value.size@12`, `value.res0@14`, `value.dataType@15`, `value.data@16` (`axml.js:109-113`).
- Thứ tự lấy giá trị: **có rawValue thì dùng chuỗi trong pool** (`axml.js:120-121`) → nếu không thì `TYPE_STRING` lấy `data` làm chỉ số pool (`122-123`) → `TYPE_REFERENCE` chỉ ghi `refId` (`124-126`) → boolean (`127-128`) → dec/hex (`129-130`, `| 0` chuyển thành số có dấu 32 bit).
- Dựng cây: `parent` của nút mới trỏ tới đỉnh ngăn xếp, sau khi push vào nút cha thì bản thân được đẩy vào ngăn xếp (`axml.js:104`, `139-140`); END_ELEMENT chỉ bật ra một tầng (`141-142`).
- Kết thúc: tìm phần tử tên `manifest` trong `root.children`, không thấy thì lấy phần tử đầu tiên (`axml.js:147`); hoàn toàn không có thì ném "Manifest APK rỗng" (`148`).

### Cạm bẫy và bất biến

1. **Cơ sở của `attributeStart` (`axml.js:105-106`) là dòng dễ bị sửa hỏng nhất trong toàn tệp.**
   Header `ResXMLTree_node` dài 16 byte (type 2 + headerSize 2 + chunkSize 4 + lineNumber 4 + comment 4), `ResXMLTree_attrExt` bắt đầu từ chunk+16, còn `attributeStart` là **offset tương đối so với attrExt** (giá trị bình thường 20 = sizeof của chính attrExt). Vì vậy công thức đúng là `pos + 16 + attrStart`.
   Đổi thành `pos + attrStart` hoặc `pos + headerSize + attrStart` đều không crash, chỉ **âm thầm giải ra tên thuộc tính/namespace bị lệch**, biểu hiện bên ngoài là: tên ứng dụng lùi về tên gói, biểu tượng đi theo dự phòng heuristic, `package` thành `undefined`. Hiện **không có bất kỳ assertion hay test case byte tổng hợp nào** canh giữ nó.

2. **Thuộc tính `package` không có namespace**: `apk.js:88` phải dùng `attrValue(manifest,'package',null)` mới lấy được; nhánh `ns===null` của `attr()` (`axml.js:154`) tồn tại chính vì điều này.

3. **`rawValue` và `dataType` đều phải thử**: những thuộc tính như `android:label`, `android:name` thường có `rawValue = 0xffffffff` và `dataType = 0x03`, chỉ đọc raw sẽ được null. Ngược lại, một số toolchain ghi raw mà không ghi kiểu, nên thứ tự không thể đảo.

4. **Khác biệt giữa `typed` và `value` là có chủ ý**: khi có `refId` thì `typed = null` (`axml.js:136`), đảm bảo `attrValue()` không trả "số resource id" như một chuỗi. Mọi logic tầng trên (`apk.js:111`, `apk.js:141`) đều xem `refId` trước rồi mới xem `typed`.

5. **Không có bảo vệ cho `chunkSize < 8`** (chỉ có `<= 0`, `axml.js:85`), một AXML dị dạng về lý thuyết có thể quay tại chỗ; trong bối cảnh APK sẽ không xảy ra, nhưng nếu sau này phân tích tệp tùy ý do người dùng tải lên thì cần bổ sung.

6. **Chunk không được hỗ trợ bị bỏ qua âm thầm**: CDATA(0x0104) không có nhánh, được lướt qua nhờ `pos += chunkSize` (`axml.js:144`). `RES_XML_RESOURCE_MAP(0x0180)` cũng chỉ bị bỏ qua —— vì vậy tên thuộc tính lấy từ string pool, chứ không phải attr id của resource map. Với dự án này như vậy là đủ (tra theo tên), nhưng **khi đổi ngôn ngữ/đổi resources, tên thuộc tính có thể bị làm rối thành `a`/`b`** (APK được gia cố/làm rối tài nguyên sẽ như vậy, lúc đó chỉ có thể tra ngược bằng id của resource map).

7. Chỉ phân tích ra cây con `manifest`, các nút anh em sau END của namespace không còn được quan tâm.

### Được ai gọi
- `parseAxml`: `src/core/apk.js:9` (require), `apk.js:86` (manifest), `apk.js:54` (XML biểu tượng thích ứng cũng dùng lại cùng trình phân tích)
- `attr`: `src/core/apk.js:62` (`attr(node,'drawable')`)
- `attrValue`: `apk.js:18`, `19` (action/category của intent-filter), `88`, `91`, `92`, `96`, `97`, `124`, `125`
- `children`: `apk.js:16`, `19`, `95`, `99`, `121`
- `ANDROID_NS`: **chỉ được import ở `apk.js:9`, không hề được dùng** (import chết); nơi thực sự dùng nó là tham số mặc định của `attr()` (`axml.js:152`)
- Test: `test/run-tests.js:80` (require), `run-tests.js:120`
- Không có module nào khác tiêu thụ trực tiếp (`arsc.js` tự viết riêng một bản string pool)

### Độ bao phủ test
- `test/run-tests.js:118` "Nút gốc AXML là manifest" —— **phụ thuộc fixture APK thật** (`run-tests.js:86-100` tìm `APKSTART_TEST_APK` / `test/fixtures/sample.apk` / `Documents/*.apk`); không tìm thấy thì bỏ qua cả đoạn (`run-tests.js:130-132`).
- Không có test case AXML tổng hợp ở mức byte → trên máy không có fixture (CI) thì `axml.js` có độ bao phủ bằng 0, các lỗi offset kiểu `attributeStart` sẽ không bị phát hiện.
- Các export `attr` / `attrValue` / `children` / `ANDROID_NS` / `TYPE_REFERENCE` không có unit test trực tiếp.

---

## 3. `src/core/arsc.js`

### Trách nhiệm
Trình phân tích `resources.arsc` bản rút gọn: khôi phục các tham chiếu tài nguyên `@0x7f...` trong Manifest thành chuỗi tên ứng dụng và đường dẫn tệp biểu tượng.

### Giao diện công khai
```js
const { ResTable, TYPE_REFERENCE } = require('./arsc');

new ResTable(buffer /*: Buffer, toàn bộ resources.arsc */)
  .globalStrings   // string[]: string pool cấp tệp (value.data chính là chỉ số vào đây)
  .packages        // Array<{ id:number, typeStrings:string[], keyStrings:string[],
                   //         types: Map<number /*typeId*/, Array<{id, config, entries: Map<number, {dataType,data} >}>> }>
  .resolve(ref /*: number, 0xPPTTEEEE*/, prefer /*: 'string'|'file'|'any' = 'any' */, depth = 0)
                   // → string | number | boolean | null
TYPE_REFERENCE = 0x01   // được export nhưng trong dự án không có bên dùng ngoài
```

### Cài đặt nội bộ quan trọng

**Cấu trúc ba tầng (`arsc.js:9-15`)**
`ResTable`(0x0002) → `ResTable_package`(0x0200) → `ResTable_type`(0x0201). `RES_TABLE_TYPE_SPEC_TYPE`(0x0202) có hằng số nhưng không bao giờ được xử lý.

**`readStringPool(buf,start)` (`arsc.js:23-46`)**
Là **bản sao chép-dán của cùng một logic** với `axml.js:26` (hai nhánh UTF-8/UTF-16, hai độ dài varint). Hai chỗ phải được bảo trì đồng bộ.

**`_parse()` (`arsc.js:87-106`)**
- Kiểm tra `RES_TABLE_TYPE` (`89`), `total@+4`, `pkgCount@+8` (đọc ra nhưng vòng lặp chỉ dùng `pos<total` để điều khiển, `pkgCount` thực tế không dùng để đếm).
- Chỉ coi string pool **đầu tiên** là `globalStrings` (điều kiện `this.globalStrings.length === 0` ở `99-100`), các pool bên trong package về sau sẽ không bị nhầm thành pool toàn cục.

**`_parsePackage(start,size)` (`arsc.js:108-139`)**
- Các trường: `id@+8`, `typeStrings@+268`, `keyStrings@+276`, `headerSize@+2` (`111-113`) —— đây là bố cục cố định của `ResTable_package` (name[128] UTF-16 chiếm 12..268).
- Việc đọc hai string pool được bọc trong `try/catch` (`117-120`), thất bại chỉ mất tên kiểu/tên khóa, **không ảnh hưởng `resolve`** (đây là khả năng chịu lỗi có chủ ý, bất biến xem bên dưới).
- Vòng lặp chunk con `while (pos + 8 <= end)`, chỉ xử lý `RES_TABLE_TYPE_TYPE` (`125-137`), gom theo `typeId` thành `Map<number, chunk[]>` (nhiều config cùng typeId mỗi cái chiếm một mục).

**`_parseType(start)` (`arsc.js:141-179`)**
- Header: `headerSize@+2`, `id@+8` (u8), `flags@+9` (u8), `entryCount@+12` (u32), `entriesStart@+16` (u32), `config@+20`.
- Bảng offset bắt đầu từ `start + headerSize`, dữ liệu mục bắt đầu từ `start + entriesStart` (`151-152`).
- Ba kiểu mã hóa:
  - `FLAG_SPARSE(0x01)`: mỗi mục 4 byte `{idx:u16, offset:u16}`, **đơn vị offset là 4 byte** (`*4` ở `157-158`)
  - `FLAG_OFFSET16(0x02)`: `offset:u16`, `0xffff` nghĩa là rỗng, **cũng `*4`** (`165-167`)
  - Thông thường: `offset:u32`, `0xffffffff` nghĩa là rỗng (`172-173`)
- Ba chỗ `*4` là mã hóa compact entry của Android, xóa đi thì tất cả đều lệch.

**`_readValue(at)` (`arsc.js:181-192`)**
- `ResTable_entry`: `size@0` (u16), `flags@2` (u16); `flags & 0x0001` = `FLAG_COMPLEX` (bag/map, style, array, attr đều nằm ở đây) → **trả về null ngay** (`186`).
- `valueAt = at + entrySize` (`187`, entrySize có thể là 8 hoặc 16), `dataType@+3`, `data@+4` của `Res_value` (`189-190`).
- Không kiểm tra `Res_value.size` (quy ước là 8), cũng không kiểm tra biên ngoài `at+8` (chỉ có một chỗ ở `183`).

**`parseConfig` / `score`**
- Bố cục `ResTable_config`: `size@0`, `imsi@4`, `locale(language@8,country@10)`, `screenType(orientation@12,touchscreen@13,**density@14**)`, `input@16`, `screenSize@20`, `version(**sdkVersion@24**)`, `screenConfig(screenLayout@28,**uiMode@29**)` (`48-59`).
- `isDefault = !language && !country && density===0 && !sdkVersion` (`60`) —— **không tính `uiMode` vào**, nên config chỉ mang `uiMode` sẽ bị coi là default.
- Chấm điểm (`65-77`):
  - `prefer='file'`: `s += density` (ưu tiên mật độ cao), `anydpi(0xfffe)` bị trừ thêm `-500` (sợ lấy phải biểu tượng thích ứng dạng xml, chú thích `69`)
  - Còn lại: ưu tiên không có mật độ, `language` −40, `sdkVersion/1000`, `uiMode` −20 (tức là ưu tiên config mặc định "không ngôn ngữ, sdk thấp, không uiMode")

**`resolve(ref,prefer,depth)` (`arsc.js:200-230`)**
- `depth > 6` hoặc `ref` bằng 0 thì trả null ngay (chống tham chiếu vòng, `201`).
- Tách `pkgId = ref>>>24`, `typeId = (ref>>>16)&0xff`, `entryIdx = ref&0xffff` (`202-204`).
- **Không tìm thấy package thì lùi về `packages[0]`** (`206`) —— APK nhiều package (thư viện dùng chung 0x02/0x03) có thể tra nhầm package.
- Trong mọi config cùng typeId, chọn cái có `score` cao nhất (`211-217`).
- `TYPE_STRING` → `globalStrings[data]` (`220-222`, undefined trả null); `TYPE_REFERENCE` → đệ quy (`224-226`); boolean/dec/hex trả trực tiếp (`227-228`); còn lại null (như `TYPE_DIMENSION`, màu sắc, ở đây không phân tích).

### Cạm bẫy và bất biến

1. **`globalStrings` phải là pool cấp tệp**: `value.data` là chỉ số vào pool toàn cục; `typeStrings/keyStrings` trong package chỉ dùng để hiển thị khi gỡ lỗi. Vì vậy việc `try/catch` trong `_parsePackage` nuốt lỗi là an toàn —— `resolve` không phụ thuộc vào nó. **Khi sửa mã đừng đổi `resolve` sang dùng `keyStrings`.**
2. **Các hằng số trong `score()` đều là giá trị kinh nghiệm**: `anydpi` phạt 500, `language` phạt 40. Mục đích là "ứng dụng tiếng Trung ưu tiên lấy tài nguyên mặc định, biểu tượng ưu tiên lấy mật độ cao nhất"; nhưng cái giá là **tên ứng dụng có thể ra tiếng Anh** (`values/` là mặc định, `values-zh/` bị trừ điểm). Hiện chỉ nhắm tới "hiển thị được", không khớp theo ngôn ngữ hệ thống.
3. **Tài nguyên `FLAG_COMPLEX` đều không lấy được**: nếu `android:icon` trỏ tới tài nguyên dạng bag như `<bitmap>`/`<shape>` sẽ trả về null, rồi rơi xuống dự phòng heuristic của `apk.js`.
4. **`*4` của offset sparse/16 bit không thể bỏ** (`158`, `167`).
5. **`pkgCount` đọc ra nhưng không dùng** (`92`): duyệt chunk cấp cao dựa vào `pos<total`, nếu tệp lẫn chunk không phải package cũng không sai, nhưng `pkgCount` là biến chết.
6. Không có `ResTable_typeSpec`, không có overlayable/staged alias, không khớp locale, không có package động `0x00`.
7. Hằng số `TYPE_REFERENCE` được export nhưng không ai dùng (`arsc.js:233`), thuộc dạng nhiễu API.

### Được ai gọi
- `ResTable`: `src/core/apk.js:10` (require), `apk.js:104` (khởi tạo trong `try/catch`, thất bại thì hạ cấp thành `res=null`)
- `resolve`: `apk.js:65` (`drawable` của biểu tượng thích ứng), `apk.js:111` (`label`, `'string'`), `apk.js:141` (`icon`/`roundIcon`, `'file'`), `arsc.js:225` (đệ quy chính nó)
- Test: `test/run-tests.js:81` (require), `run-tests.js:126`
- `TYPE_REFERENCE`: toàn dự án không có bên tiêu thụ

### Độ bao phủ test
- `test/run-tests.js:123` "resources.arsc phân tích được" —— chỉ assert `res.packages.length > 0`, cũng phụ thuộc fixture APK thật, không có fixture thì bỏ qua.
- Không có test case cho `resolve()` (không có assertion nào kiểu "một ref nào đó giải ra đúng chuỗi/đường dẫn mong đợi"), cũng không có test case cho FLAG_SPARSE / FLAG_OFFSET16 / FLAG_COMPLEX.
- Kết luận: **trong chuỗi này test của `arsc.js` mỏng nhất**, trong khi logic lại khó nhất (ba kiểu mã hóa entry + chấm điểm config).

---

## 4. `src/core/png.js`

### Trách nhiệm
Bộ **mã hóa** PNG không phụ thuộc + vẽ bằng chương trình biểu tượng thương hiệu ApkStart (tránh nhét tài nguyên nhị phân vào kho mã, cũng tiện đổi màu chủ đề).

> Lưu ý chiều: chỉ có mã hóa (RGBA → PNG), **không có giải mã**. Giải mã WebP/PNG hoàn toàn dựa vào `nativeImage` / Chromium của Electron (xem mục 6).

### Giao diện công khai
```js
const { encodePng, drawAppIcon } = require('./png');

encodePng(width, height, rgba /*: Uint8Array, độ dài phải = w*h*4, thứ tự RGBA */)  // → Buffer(PNG)
drawAppIcon(size = 256)  // → Buffer(PNG), size×size
```

### Cài đặt nội bộ quan trọng
- **CRC32** (`png.js:8-22`): đa thức phản xạ chuẩn `0xedb88320`, bảng tra 256 mục, lưu bằng `Int32Array`; `crc32()` trả về giá trị không dấu `>>> 0`.
- **chunk()** (`png.js:24-31`): `[len BE][type ascii][data][crc BE]`, CRC bao phủ type+data.
- **`encodePng`** (`png.js:34-55`):
  - IHDR 13 byte: `width/height` BE, bitDepth=8, colorType=6 (RGBA), compression/filter/interlace đều 0 (`png.js:36-40`)
  - Dữ liệu thô `raw = (width*4+1)*height`, byte đầu mỗi hàng ghi filter 0 (None), phần còn lại sao chép bằng `Buffer.from(rgba.buffer, byteOffset + y*stride, stride)` (`png.js:43-48`) —— **yêu cầu `byteOffset` của `rgba` là offset hợp lệ**, truyền view `Uint8ClampedArray` cũng được
  - Chỉ có một IDAT, `zlib.deflateSync(raw, {level:9})` (`png.js:52`), `level:9` với 256×256 mất khoảng vài chục mili giây
- **`drawAppIcon`** (`png.js:80-130`):
  - Siêu lấy mẫu 4×: `SS=4`, `S=size*4`; `acc = Float32Array(size*size*4)` tích lũy màu (`png.js:83`)
  - Hình dạng: hình chữ nhật bo góc `pad = 6%`, bán kính `24%` (`85-86`), xác định bằng `roundRectAlpha()` (`59-65`, "kẹp điểm vào hình chữ nhật trong, tính khoảng cách tới tâm cung gần nhất"); tam giác `pointInTriangle()` (`67-74`, ba tích có hướng cùng dấu thì nằm trong)
  - Phối màu: gradient chéo `t = (x/S)*0.6 + (y/S)*0.4` → `r 20..34 / g 26..44 / b 33..57`; tam giác màu đặc `#3ddc84` = (61,220,132) (`105-111`)
  - Lấy mẫu chỉ tích lũy các mẫu trong hộp (`if (!inBox) continue;` ở `102`), ngoài hộp alpha giữ 0; cuối cùng chia đều cho `n = SS*SS = 16` (`122-127`) → cạnh có độ phủ 0..255, tức là khử răng cưa
- **Biên hiệu năng**: `size=256` → `S=1024`, 1.048.576 lần lặp, mỗi lần 1~2 phép kiểm tra hình học; một lần gọi cỡ khoảng 5–15ms. `size=512` là 4M lần lặp (khoảng gấp 4). `main.js:175` tính `ICON_PNG` một lần khi khởi động rồi cache, nên không phải đường nóng.

### Cạm bẫy và bất biến
1. **`acc` phải là `Float32Array`**: cộng dồn 16 mẫu, `Uint8Array` sẽ tràn/cắt thành 255, xuất hiện mảng màu. Đổi sang Uint16 cũng được, nhưng dòng phép chia phải đồng bộ.
2. `encodePng` giả định `rgba.length >= w*h*4`, **không kiểm tra độ dài**; ngắn hơn thì `copy` ném RangeError, dài hơn thì bị bỏ qua.
3. Chỉ hỗ trợ RGBA8 / filter 0 / một IDAT —— đây là bộ mã hóa "đủ dùng là được", muốn thêm tối ưu filter (Paeth) phải viết lại vòng lặp điền `raw`.
4. Mọi tọa độ của `drawAppIcon` đều tương đối với `S` (không gian siêu lấy mẫu), đổi `SS` không ảnh hưởng bố cục; đổi `size` chỉ ảnh hưởng độ nét/thời gian.
5. Đây là nguồn của "biểu tượng giữ chỗ thương hiệu", cũng là đầu vào cho dự phòng cấp ba của `iconToIco` (`shortcut.js:128-129`), nên trong **mọi** tình huống trích xuất biểu tượng thất bại, thứ người dùng thấy trên desktop đều là tam giác xanh lá này.

### Được ai gọi
- `drawAppIcon`: `src/main.js:15` (require), `main.js:28` (dự phòng của `loadBrandIcon()`, dùng khi `LOGO_FILE` không tồn tại)
- `src/core/shortcut.js:128` (require), `129` (ICO giữ chỗ)
- `encodePng`: chỉ `png.js:129` (bên trong `drawAppIcon`) + test
- Test: `test/run-tests.js:63` (require), `66`, `73`; `test/auto-test.js:496`, `497`; `test/electron-integration.js:22`, `27`

### Độ bao phủ test
- `test/run-tests.js:64` "Bộ mã hóa PNG xuất ra chữ ký và IHDR hợp lệ" —— kiểm tra chữ ký `0x89 0x50`, `IHDR`, độ dài > 50, **không kiểm tra CRC, không kiểm tra pixel**.
- `test/run-tests.js:71` "Biểu tượng ứng dụng vẽ được ở kích thước bất kỳ" —— đầu ra 16/32/64/256 có chiều rộng bằng tham số vào.
- `test/auto-test.js:494` gián tiếp dùng `drawAppIcon(64)` làm nguyên liệu PNG-in-ICO.
- Lỗ hổng: **độ đúng pixel** của `drawAppIcon` không có assertion nào (chỉ test kích thước); tham số vào bất thường về kích thước/độ dài của `encodePng` chưa được test.

---

## 5. `src/core/apk.js` (điểm vào chung)

### Trách nhiệm
Trích xuất ngoại tuyến siêu thông tin APK: tên gói / phiên bản / tên ứng dụng / Activity khởi chạy / biểu tượng / ABI. Không phụ thuộc aapt, adb, mạng.

### Giao diện công khai
```js
const { parseApk, quickCheck } = require('./apk');

parseApk(filePath /*: string */) → {
  ok: true,
  filePath,          // trả về nguyên trạng
  sizeBytes,         // size của fs.statSync
  package: string,   // bắt buộc có, nếu không thì throw
  label: string,     // đã gộp khoảng trắng + trim + cắt còn 60 ký tự
  versionName: string,   // mặc định '1.0'
  versionCode: number,   // không phải number thì là 0
  minSdk: number,        // mặc định 0
  targetSdk: number,     // mặc định 0
  launchActivity: string|null,
  abis: string[],        // ['arm64-v8a', ...], không có lib/ thì []
  iconPng: Buffer|null,  // byte gốc của biểu tượng (PNG hoặc WebP! tên trường gây hiểu lầm)
  iconFile: string|null, // đường dẫn trong APK, ví dụ 'res/mipmap-xxxhdpi-v4/ic_launcher.png'
}   // thất bại luôn throw (không trả ok:false)

quickCheck(filePath /*: string */) → boolean   // chỉ đọc 4 byte đầu để xét 'PK', mọi ngoại lệ đều trả false
```

### Cài đặt nội bộ quan trọng (`parseApk`, `apk.js:75-175`)

1. `fs.statSync` → `size < 1024` thì ném "Tệp quá nhỏ" (`76-77`).
2. `const buf = fs.readFileSync(filePath)` (`78`) → **toàn bộ gói vào bộ nhớ**, đây là bước nặng nhất của cả chuỗi.
3. `new ZipArchive(buf)` (`79`).
4. Bắt buộc có `AndroidManifest.xml`, nếu không thì gợi ý "có thể là gói tách .apks/.xapk" (`81-83`).
5. `zip.read` + `parseAxml` (`85-86`).
6. `package`: **tra theo không namespace trước** (`88`, `attrValue(manifest,'package',null)`), rồi mới lùi về namespace mặc định (cách viết dự phòng).
7. `versionName` mặc định `'1.0'`, `versionCode` chỉ chấp nhận number (`91-93`).
8. `minSdkVersion` / `targetSdkVersion` của `uses-sdk` được chuẩn hóa bằng `| 0` (`95-97`) —— `null | 0 === 0`.
9. Nút `application` lấy cái đầu tiên, dự phòng một đối tượng rỗng (`99`).
10. Bảng tài nguyên: có `resources.arsc` thì mới khởi tạo `ResTable`, **toàn bộ bọc try/catch** (`103-105`) → khi arsc hỏng thì `res=null`, mọi phân giải `refId` sau đó thất bại và tự động rơi về giá trị mặc định.
11. Tên ứng dụng (`108-117`): `attr(app,'label')` → `res.resolve(refId,'string')` → nếu không thì `typed` là string thì dùng → nếu không thì **đoạn cuối của tên gói viết hoa chữ cái đầu**.
12. Activity khởi chạy (`120-134`):
    - Ứng viên = `activity` + `activity-alias` (`121`)
    - `isLauncherActivity` (`15-25`): **trong cùng một `intent-filter`** phải đồng thời chứa `android.intent.action.MAIN` và `android.intent.category.LAUNCHER` (không phải kết hợp qua nhiều filter)
    - Bổ sung tên: bắt đầu bằng `.` → `package + n`; không chứa `.` → `package.n`; còn lại giữ nguyên (`127-129`)
    - Khi là `activity-alias` và có `targetActivity` thì **ghi đè** thành target (`130-132`, phép kiểm tra dùng tên nút `launcher.name === 'activity-alias'`)
13. Biểu tượng (`137-152`): ưu tiên `icon`, dự phòng `roundIcon` (`138`) → `res.resolve(refId,'file')` hoặc chuỗi `typed` → kiểm tra `zip.has(file)` → `.xml` thì đi `iconFromAdaptiveXml`, nếu không thì trực tiếp `zip.read(file)` → cuối cùng khi `!icon` thì `pickIconFromZip`.
14. ABI (`155-158`): các mục có tiền tố `lib/` lấy đoạn thứ 2 rồi khử trùng lặp.
15. Đối tượng trả về (`160-174`).

**`iconFromAdaptiveXml(zip, xmlBuffer, res)` (`apk.js:51-73`)**
- Phân tích XML biểu tượng thích ứng, tìm **nút con trực tiếp** theo thứ tự `['foreground','background','monochrome']` (`58-60`), cũng chấp nhận bản thân nút gốc là một trong số đó (nửa sau của `60`)
- Lấy `android:drawable`: `refId` → `res.resolve(...,'file')`, nếu không thì chuỗi `typed` (`62-66`)
- **Chỉ chấp nhận `.png`/`.webp`** (`67`) và bắt buộc `zip.has(file)` (`68`), `data.length > 100` mới trả về (`70`)
- Không đệ quy vào `<inset>`, `<layer-list>`, `<bitmap>`; bản thân XML phân tích thất bại thì trả null (`53-57`)

**`pickIconFromZip(zip)` (`apk.js:27-48`, dự phòng heuristic)**
- Ứng viên: `/^res\/.*\.(png|webp)$/i` (`29`)
- Điểm = `entries.get(n).uncompSize` **số byte chưa nén** (không phải kích thước pixel), rồi nhân với trọng số tên:
  - `ic_launcher|app_icon|ic_app` ×6 (`33`)
  - `_round|_foreground|_background` ×0.4 (`34`)
  - `xxxhdpi` ×1.6 / `xxhdpi` ×1.4 / `xhdpi` ×1.2 (`35-37`)
- Sắp xếp giảm dần rồi chỉ thử 30 cái đầu (`41`), `data.length > 100` mới chấp nhận (`44`), nếu không thì null.

### Cạm bẫy và bất biến
1. **`readFileSync` toàn gói (`apk.js:78`)**: phân tích một APK 500MB sẽ khiến tiến trình chiếm thêm 500MB bộ nhớ thường trú; `>2GB` thì trực tiếp `ERR_FS_FILE_TOO_LARGE`. `.apks`/`.xapk` đi qua `installer.parseBundle` còn tệ hơn (ZIP bên ngoài cũng đọc toàn gói, rồi ghi từng split xuống đĩa, rồi mỗi cái lại `parseApk`).
2. **Tên trường `iconPng` đánh lừa**: `apk.js:172` trả về **byte gốc của biểu tượng**, có thể là WebP (`res/mipmap-*/ic_launcher.webp`). Vì vậy `shortcut.iconToIco` phải có dự phòng ba cấp, `installer.js:208-209` lưu nó xuống đĩa như `.png` cũng là "tên tệp .png, nội dung có thể là WebP" —— Chromium/nativeImage đọc theo magic number nên hiển thị được, nhưng mở bằng công cụ ngoài sẽ không nhất quán.
3. **`launchActivity` chỉ là "cái được khai báo trong APK"**: `installer.js:227-234` chú thích rõ "Activity chính phân tích được từ APK thường không phải điểm vào LAUNCHER thật sự", sau khi cài sẽ dùng `client.resolveLauncher(pkg)` để ghi đè. **Đừng thêm logic khởi chạy ở đây.**
4. **Xử lý target của `activity-alias`**: `130-132` dùng `launcher.name` (tên thẻ), nếu cùng một activity vừa có alias vừa có khai báo thật, cả hai lần đều khớp thì lấy cái tìm thấy trước; thứ tự là `activity` trước, `activity-alias` sau (`121`).
5. **`apk.js:38` trong `pickIconFromZip`** là mã chết còn sót: `if (/\//.test(n.split('/')[1] || '')) { /* noop */ }`, không có tác dụng gì, xóa đi an toàn.
6. **Chấm điểm dùng `uncompSize`**: một ảnh "tỷ lệ nén cao, pixel cực lớn" (ảnh khởi động màu đặc) có thể vì sau nén nhỏ mà xếp sau; biểu tượng màu đặc cũng có thể xếp trước ảnh chụp. Đây là khuyết điểm tự nhiên của heuristic.
7. **Dự phòng `label`**: `a.b.c` → `C`, nên gói `com.example.game` sẽ hiển thị thành `Game`. Ứng dụng tiếng Trung khi phân tích arsc thất bại sẽ thoái hóa thành đoạn tiếng Anh, thuộc dạng hạ cấp chấp nhận được.
8. **Khi `res` là null sẽ không ném lỗi**, `label`/`icon` đều lùi về mặc định —— đường chịu lỗi này khiến "trình phân tích ARSC hỏng" biểu hiện thành "biểu tượng xấu đi, tên thành tiếng Anh", chứ không báo lỗi. Khi điều tra hãy xem trước `iconFile` có phải được chọn bởi dự phòng hay không.
9. `quickCheck` (`178-188`) **không có bên gọi nào trong `src/`** (chỉ test dùng), là mã chết; kênh IPC `apk:parse` (`main.js:756`) cũng chỉ được `preload.js:10` cung cấp, `src/ui/app.js` không tiêu thụ (UI thực tế đi qua `installApk`, `ui/app.js:484`).

### Được ai gọi
- `parseApk`:
  - `src/main.js:14` (require), `main.js:756` (IPC `apk:parse`)
  - `src/preload.js:10` (`window.apkstart.parseApk`)
  - `src/core/installer.js:11` (require), `installer.js:40` (tìm base trong gói tách), `installer.js:149` (đường cài đặt chính)
  - `scripts/selftest.js:18`, `142`
  - Test: `test/run-tests.js:82`, `106`; `test/electron-integration.js:24`, `55`
- `quickCheck`: **chỉ được dùng ở `test/run-tests.js:103-104`**
- Gián tiếp (`installer.install`): `src/main.js:758` (IPC `apk:install`) ← `src/ui/app.js:484`

### Độ bao phủ test
- `test/run-tests.js:103` "quickCheck nhận diện header PK"
- `test/run-tests.js:107` "Phân tích ra tên gói / phiên bản / Activity khởi chạy" —— assert `package` khớp `^[\w.]+$`, có `versionName`, `launchActivity` chứa `.`
- `test/run-tests.js:113` "Phân tích ra biểu tượng dùng được" —— `iconPng.length > 100` và `label` không rỗng
- Cả ba mục trên đều **phụ thuộc fixture APK thật**, không có fixture thì bỏ qua cả đoạn (`run-tests.js:130-132`) → trên CI coi như không test
- `test/electron-integration.js:54-62` dùng APK thật chạy "biểu tượng APK → ICO nhiều kích thước", khi thất bại log ghi "biểu tượng có thể ở định dạng ngoài webp/jpg"
- Lỗ hổng: `.apks`/`.xapk` (`installer.parseBundle`) không có test case nào; các ca âm `activity-alias`, không có arsc, không có biểu tượng đều chưa test

---

## 6. `src/core/shortcut.js`

### Trách nhiệm
Chuyển biểu tượng APK thành ICO nhiều kích thước, và ghi `.lnk` trên desktop/Start Menu của Windows; dự phòng ba cấp đảm bảo lối tắt **luôn luôn** có biểu tượng.

### Giao diện công khai
```js
const {
  pngToIco, pngBytesToIco, iconToIco,
  writeShortcut, removeShortcut, safeFileName, ICO_SIZES,
} = require('./shortcut');

ICO_SIZES = [16, 20, 24, 32, 40, 48, 64, 128, 256]   // 9 mức, được export nhưng trong dự án không có bên dùng ngoài

pngToIco(pngBuffer)                  // → Buffer(ICO, DIB nhiều kích thước) | null; ★ bên trong require('electron'), chạy dưới Node thuần sẽ ném TypeError
pngBytesToIco(png)                   // → Buffer(ICO, PNG-in-ICO một kích thước) | null; dùng được với Node thuần
iconToIco(raw, { decode } = {})      // async → Buffer(ICO) | null; dự phòng ba cấp
writeShortcut({                      // → string (shortcutPath ghi thành công)
  shortcutPath, target, args?, iconIcoPath?, description?, cwd?, appUserModelId?,
})                                   // thất bại thì throw (ba loại thông báo lỗi xem bên dưới)
removeShortcut(p)                    // → boolean, nuốt ngoại lệ
safeFileName(name)                   // → string, thay ký tự không hợp lệ + gộp khoảng trắng + cắt 60 ký tự, rỗng thì 'Android App'
```

### Cài đặt nội bộ quan trọng

**`buildDib(bgra, size)` (`shortcut.js:13-33`)**
- Tự viết `BITMAPINFOHEADER` 40 byte: `biSize=40`, `biWidth=size`, `biHeight=size*2` (hai đoạn XOR + AND), `biPlanes=1`, `biBitCount=32`, `BI_RGB`, `biSizeImage=size*size*4` (`14-21`)
- Bitmap XOR **lật thứ tự hàng từ dưới lên** (`25-28`, trục y của ICO/DIB hướng lên)
- Mặt nạ AND 1bpp, hàng căn theo 4 byte, **toàn 0** (`30-31`, chú thích giải thích "giao cho kênh alpha")

**`pngToIco(pngBuffer)` (`shortcut.js:39-73`) —— đường DIB nhiều kích thước**
- `require('electron')` nằm trong hàm (`40`), `nativeImage.createFromBuffer`, `isEmpty()` thì trả null (`41-42`)
- Với 9 mức kích thước lần lượt `resize({quality:'best'})` → `buildDib(img.toBitmap(), s)` (`45-51`)
- `img.toBitmap()` trên Windows là **BGRA**, đúng thứ tự DIB cần, không cần hoán đổi kênh
- ICONDIR: `reserved=0, type=1, count=n`, mỗi mục 16 byte: `width/height` u8, `colorCount=0`, `reserved=0`, `planes=1`, `bitCount=32`, `bytesInRes`, `imageOffset` (`53-72`)
- **Byte rộng/cao ghi 0 khi `>=256`** (`61-62`) —— trong thư mục ICO một byte 0 nghĩa là 256

**`pngBytesToIco(png)` (`shortcut.js:83-101`) —— đường PNG-in-ICO**
- Kiểm tra: là `Buffer` và `length >= 24` và `[1,4)` là `'PNG'` (`84`), từ IHDR đọc BE `w@16`, `h@20`, `w/h` khác 0 và `<= 1024` (`85-87`)
- ICONDIR cố định 22 byte (6 + 16), `bytesInRes = png.length`, `imageOffset = 22` (`88-99`), vùng dữ liệu **chính là byte PNG gốc** (không mã hóa lại, không mất alpha)
- Hợp lệ từ Vista trở đi, nên chú thích nói "đường DIB cũ ở đây sẽ thất bại toàn bộ" (`80-82`)

**`iconToIco(raw, {decode})` (`shortcut.js:109-133`) dự phòng ba cấp**
1. `nativeImage.createFromBuffer(raw)` giải được (PNG/JPEG thật) → `img.toPNG()` → `pngToIco` (`111-118`). **`toPNG()` là cần thiết**, vì raw có thể là JPEG, còn `pngToIco` nhận PNG/JPEG đều được nhưng DIB cần pixel
2. Có callback `decode` → `await decode(raw)` được PNG → `pngBytesToIco` (`120-126`). WebP đi đường này (Chromium giải mã)
3. Giữ chỗ: `drawAppIcon(256)` → `pngBytesToIco` (`127-132`)
4. Tất cả thất bại thì trả null

**`writeShortcut(opt)` (`shortcut.js:144-169`)**
- Thư mục không tồn tại thì `mkdirSync(recursive)`, thất bại thì ném "Thư mục lối tắt không ghi được" (`146-151`)
- **.lnk đã tồn tại thì `unlinkSync` trước** (`152-154`)
- `shell.writeShortcutLink(path,'create',{target,args,icon,iconIndex:0,description,cwd,appUserModelId})` (`155-163`), `icon` mặc định dùng `target`
- Trả false thì ném "Tạo lối tắt thất bại" (`164`)
- **Đọc lại để kiểm tra**: `fs.existsSync(shortcutPath)` là false thì ném "Lối tắt không được ghi xuống đĩa" (`165-167`) —— chú thích (`138-141`) ghi lại cái bẫy này: khi phần mềm bảo mật chặn, hoặc desktop bị chuyển hướng tới ổ mạng chưa đăng nhập, thì "trả true nhưng tệp không tồn tại"

**`safeFileName` (`shortcut.js:75-77`)**
`[\\/:*?"<>|]` → `_`, `\s+` → khoảng trắng, trim, `slice(0,60)`, rỗng thì `'Android App'`. Tên dành riêng của Windows (CON/PRN/NUL…) **không được xử lý**.

### Cạm bẫy và bất biến
1. **`pngToIco` không chạy được dưới Node thuần**: `require('electron')` trong Node trả về **chuỗi đường dẫn** tới electron.exe, `nativeImage` giải cấu trúc ra là `undefined`, `createFromBuffer` lập tức TypeError (trong hàm không có try/catch). Đây là lý do mọi test case `pngToIco` đều nằm trong `test/electron-integration.js` (chạy bằng `electron test/...`), còn `npm test` chỉ test `pngBytesToIco`/`iconToIco`.
2. **Hai nhánh của toán tử ba ngôi ở `shortcut.js:46-48` có mã hoàn toàn giống nhau** (chỉ khác chú thích), tương đương `resize` vô điều kiện. Thuộc dạng "chú thích giải thích một nhánh không tồn tại", có thể dọn dẹp. Ý định thực sự mà chú thích muốn diễn đạt là: **phóng to ảnh nhỏ còn tốt hơn thiếu kích thước** (sẽ nội suy biểu tượng 64px lên 256px, trông mờ nhưng không xuất hiện ô biểu tượng trống).
3. **Bất biến kích thước của `pngBytesToIco`**: rộng/cao trong thư mục là một byte, `>=256` thì ghi 0 (=256). Nếu truyền vào PNG 512×512, thư mục sẽ **khai là 256 trong khi dữ liệu là 512**, một số shell sẽ từ chối hiển thị. Hiện dựa vào bên gọi đảm bảo: `decodeIcon` ở `main.js:223` đã kẹp bằng `Math.min(256, ...)`, `pngToIco` tối đa cũng chỉ tới 256. **Ràng buộc này là ngầm định, rất dễ dính khi thêm bên gọi mới.**
4. **Mặt nạ AND của DIB toàn 0**: dựa vào kênh alpha của 32bpp. Shell kiểu XP cũ xử lý alpha 32bpp không nhất quán, nhưng Win10/11 không vấn đề.
5. **`writeShortcut` xóa trước rồi tạo**: sẽ mất các thuộc tính trên .lnk gốc như "Ghim vào thanh tác vụ", "Chạy với quyền quản trị". `installer.createShortcut` mỗi lần cài lại đều tạo lại, nên mục người dùng tự pin có thể mất hiệu lực (pin theo AUMID, thường vẫn khôi phục được).
6. **`icon: opt.iconIcoPath || opt.target`**: khi tạo ico thất bại thì dùng biểu tượng exe, sẽ không xuất hiện biểu tượng "giấy trắng".
7. **`appUserModelId` là tùy chọn** (`162`), sau `installer.js:299` có truyền "mỗi ứng dụng một AUMID" để nhóm trên thanh tác vụ —— chú thích ở `installer.js:299`, `writeShortcut` chỉ truyền thẳng qua.
8. `removeShortcut` nuốt mọi ngoại lệ và trả false; `installer.uninstall` không kiểm tra giá trị trả về (`installer.js:373-374`).

### Được ai gọi
- `pngToIco`: `src/main.js:1310` (require), `1311` (tính ngay khi thiếu ICO thương hiệu); `shortcut.js:115` (bên trong `iconToIco`); `test/electron-integration.js:23`, `29`, `56`
- `pngBytesToIco`: `shortcut.js:123`, `129`; `test/auto-test.js:495`, `498`, `502`
- `iconToIco`: `src/core/installer.js:13` (require), `212` (khi cài đặt), `346` (khi tạo bù biểu tượng); `test/auto-test.js:495`, `505`, `507`
- `writeShortcut`: `installer.js:13`, `292` (`createShortcut`); `test/electron-integration.js:23`, `35`
- `removeShortcut`: `installer.js:13`, `373`, `374` (gỡ cài đặt)
- `safeFileName`: `installer.js:13`, `75` (đường dẫn desktop), `88` (đường dẫn Start Menu), `319` (đường dẫn dự phòng)
- `ICO_SIZES`: chỉ dùng ở `shortcut.js:45`; được export nhưng không có bên dùng ngoài
- Ngữ cảnh gọi: `ctx.decodeIcon` được định nghĩa ở `main.js:213`, tiêm vào `Installer` ở `main.js:1498`

### Độ bao phủ test
- `test/auto-test.js:494` "PNG-in-ICO và dự phòng biểu tượng WebP đều tạo ra ICO dùng được" —— assert header ICO `type=1/count=1`, `bytesInRes` bằng độ dài PNG, `ico.slice(22)` giống hệt PNG gốc, đầu vào không hợp lệ trả null, WebP không có decode thì lùi về giữ chỗ, có decode thì dùng ảnh thật. **Đây là test case bao phủ tốt nhất của tệp này.**
- `test/electron-integration.js` (`electron test/electron-integration.js`, **không nằm trong `npm test`**): các bước "Tạo ICO", "Tạo .lnk", "Xóa .lnk", "Biểu tượng APK → ICO nhiều kích thước", kết quả ghi vào `test/out/result.json`.
- Lỗ hổng: cấu trúc byte DIB của `pngToIco` không có assertion (chỉ trong tích hợp Electron "tạo được và >1000 byte"); tên dành riêng/quá dài/ký tự không hợp lệ của `safeFileName` không có unit test; nhánh "trả true nhưng không ghi xuống đĩa" của `writeShortcut` không thể dựng trong test.

---

## 7. `src/core/assoc.js`

### Trách nhiệm
Đăng ký/hủy đăng ký liên kết tệp `.apk` dưới `HKCU\Software\Classes` (không cần quyền quản trị), nhấp đúp APK → `apkstart.exe "%1"`.

### Giao diện công khai
```js
const { registerAssociation, unregisterAssociation, PROGID } = require('./assoc');
PROGID = 'ApkStart.apk'

registerAssociation(exePath /*: string, bắt buộc */, iconPath /*?: string */, extraArgs /*?: string */)
  // → { ok: true, progId: 'ApkStart.apk' }   ★ luôn luôn ok:true, kể cả khi mọi lệnh reg đều thất bại
unregisterAssociation() → { ok: true }        // như trên
```

### Cài đặt nội bộ quan trọng
- `reg(args)` (`assoc.js:11-18`): `execFileSync('reg', args, {windowsHide:true, stdio:'pipe'})`, **nuốt toàn bộ ngoại lệ và trả false**, không lan truyền lên trên. → Mọi thao tác ghi registry đều là "cố gắng hết sức", bên gọi không nhận được thông tin thất bại.
- `notifyShell()` (`assoc.js:20-33`): PowerShell `Add-Type` P/Invoke gọi `SHChangeNotify(0x08000000=SHCNE_ASSOCCHANGED, 0, NULL, NULL)` để File Explorer làm mới biểu tượng/liên kết; `timeout: 8000`, thất bại thì bỏ qua (chú thích `32`).
- `registerAssociation` (`assoc.js:40-56`) ghi 6 mục:
  1. Giá trị mặc định của `HKCU\Software\Classes\.apk` = `ApkStart.apk`
  2. `.apk\OpenWithProgids` thêm `ApkStart.apk` (giá trị rỗng `REG_NONE`, `46`, đây là cách ghi đúng để xuất hiện trong danh sách "Mở bằng")
  3. Giá trị mặc định của `ApkStart.apk` + `FriendlyTypeName` = "Gói ứng dụng Android"
  4. `DefaultIcon` = `"<icon>",0`
  5. Giá trị mặc định của `shell\open` = "Cài đặt vào ApkStart"
  6. `shell\open\command` = `"<exePath>" <extraArgs> "%1"` (`43`)
- Ghép `command` (`assoc.js:43`): `extraArgs` **do bên gọi chịu trách nhiệm thêm dấu ngoặc kép** (chế độ phát triển phải truyền thư mục ứng dụng). Điểm gọi thực tế: `main.js:1315` truyền `l.args` (`launcherInfo()` đã có ngoặc kép), `scripts/assoc.js:22` truyền `"<appDir>"`.
- `unregisterAssociation` (`assoc.js:58-66`): xóa giá trị trong `OpenWithProgids` → xóa toàn bộ cây con `ApkStart.apk` → **vô điều kiện** đặt giá trị mặc định của `.apk` thành rỗng → thông báo shell.

### Cạm bẫy và bất biến
1. **★★ Chú thích và cài đặt không nhất quán (lỗi thật)**: `assoc.js:62` ghi "chỉ xóa giá trị mặc định khi .apk vẫn còn trỏ về chính chúng ta", nhưng `assoc.js:63` là `reg(['add', ...EXT, '/ve', '/d', '', '/f'])` **không có điều kiện nào**. Hậu quả: người dùng vốn đã liên kết `.apk` với một công cụ giải nén khác (hoặc mặc định "kiểu không xác định" của hệ thống), sau khi hủy liên kết thì giá trị mặc định bị xóa trống, liên kết cũ bị mất mà không có sao lưu/khôi phục. Cách sửa: trước tiên `reg query` đọc giá trị mặc định hiện tại, bằng `PROGID` thì mới xóa.
2. **Giá trị trả về không mang thông tin**: `registerAssociation` luôn trả `ok:true`, IPC ở `main.js:1315` vì vậy không thể phân biệt "thành công" và "toàn bộ bị chính sách chặn". Nếu UI hiển thị thông báo thành công thì đó là giả.
3. **`notifyShell` phụ thuộc PowerShell + `Add-Type`**: trên máy không có PowerShell/chính sách bị hạn chế sẽ âm thầm thất bại, liên kết không được làm mới (cần người dùng đăng nhập lại hoặc tự làm mới). `timeout: 8000` chặn đồng bộ tiến trình chính, tệ nhất treo 8 giây.
4. **Trách nhiệm dấu ngoặc kép của `extraArgs` thuộc về bên gọi** (`assoc.js:43`), truyền vào đường dẫn có khoảng trắng mà không có ngoặc kép sẽ ghép ra dòng lệnh sai.
5. Chỉ ghi HKCU, không đụng HKLM —— đây là mấu chốt của "không cần quyền quản trị", cũng có nghĩa là **trong môi trường nhiều người dùng, mỗi người dùng phải tự đăng ký**.
6. `PROGID` được viết cứng là `'ApkStart.apk'`, cùng với `EXT='.apk'` tạo thành hợp đồng registry; đổi tên sẽ khiến các mục còn sót do phiên bản cũ đăng ký không thể được `unregisterAssociation` dọn (nó chỉ xóa cây `PROGID` này).

### Được ai gọi
- `registerAssociation`: `src/main.js:30` (require), `main.js:1315` (IPC `assoc:register`); `scripts/assoc.js:10`, `21`
- `unregisterAssociation`: `main.js:1318` (IPC `assoc:unregister`), `main.js:1351` (`try/catch` trong luồng gỡ cài đặt); `scripts/assoc.js:26`
- `PROGID`: `main.js:1297` (`assoc:status` dùng việc đầu ra `reg query` có chứa nó hay không để xét đã liên kết)
- UI: `src/ui/app.js:754-755` chỉ tiêu thụ trường `registered` của `assoc:status`

### Độ bao phủ test
**Không có.** `grep -r assoc test/` không trúng kết quả nào, `auto-test.js` / `engine-test.js` / `run-tests.js` đều không có test case registry (vì sẽ thay đổi trạng thái). `scripts/assoc.js` là công tắc thủ công. Đây là module duy nhất trong cả nhóm "hoàn toàn không có xác minh tự động".

---

## 8. `src/core/version.js`

### Trách nhiệm
So sánh số phiên bản. Tách thành module nhỏ độc lập, **để tránh phụ thuộc vòng `updater` ↔ `sources`** (chú thích `version.js:3`).

### Giao diện công khai
```js
const { parseVer, cmpVer } = require('./version');

parseVer(v)     // → Array<number|string>: bỏ tiền tố 'v', tách theo [.+-], đoạn toàn số chuyển thành Number, lọc đoạn rỗng
cmpVer(a, b)    // → 1 (a>b) | -1 (a<b) | 0 (bằng nhau)
```

### Cài đặt nội bộ quan trọng
- `parseVer` (`version.js:7-13`): `String(v||'')` → `replace(/^v/i,'')` → `split(/[.+-]/)` → đoạn số chuyển `Number`, đoạn không phải số giữ nguyên chuỗi → `.filter(x => x !== '')`.
  - `'v0.3.2'` → `[0,3,2]`; `'0.3.2-preview'` → `[0,3,2,'preview']`; `'1.0.0+build'` → `[1,0,0,'build']`.
- `cmpVer` (`version.js:16-34`): lấy độ dài của bên dài hơn và so từng đoạn; **bên nào hết trước → bên ngắn nhỏ hơn** (`23-24`); hai bên đều là number thì so số, nếu không thì so thứ tự từ điển `String()` (`25-31`).

### Cạm bẫy và bất biến
1. **`cmpVer('1.0','1.0.0') === -1`, không phải 0** (ngữ nghĩa của `23-24`). Khi dùng cho `updater.hasUpdate` (`updater.js:109`), "hiện tại 1.0 / từ xa 1.0.0" sẽ bị xét là có cập nhật —— hiện số phiên bản luôn có ba đoạn, chưa kích hoạt, nhưng **đừng dùng nó để xét "bằng nhau"**.
2. **Không phải semver**: đoạn tiền phát hành so theo chuỗi → `'preview' > 'beta'` (thứ tự từ điển), `'rc1' > 'rc'`; `1.0.0+build` vì thừa một đoạn nên **lớn hơn** `1.0.0` (trong semver build metadata phải bị bỏ qua). Với mục đích "sắp xếp release tag của GitHub/Gitee" thì đủ dùng.
3. Đoạn số dùng `Number()`, nên `'01'` và `'1'` bằng nhau; `'1.10' > '1.9'` đúng (so số).
4. Chuỗi rỗng / `null` → `[]`, so với bất kỳ phiên bản không rỗng nào đều là `-1`.
5. Module cố ý không phụ thuộc (chỉ export hai hàm thuần), bất kỳ bên nào muốn thêm phụ thuộc đều sẽ đưa phụ thuộc vòng trở lại.

### Được ai gọi
- `cmpVer`:
  - `src/core/provision.js:17` (require), `513` (`cands.sort((a,b) => cmpVer(b.tag, a.tag))`, chọn phiên bản ảnh hệ thống)
  - `src/core/sources.js:20` (require), `299` (danh sách release giảm dần theo tag)
  - `src/core/updater.js:22` (require), `109` (`hasUpdate: cmpVer(merged.tag, this.current) > 0`), `333` (**export lại** `cmpVer`, nên bên tiêu thụ `updater.js` có thể đi vòng qua version.js)
- `parseVer`: chỉ `version.js:17-18` (bên trong `cmpVer`)
- Test: `test/auto-test.js:821` import từ `../src/core/updater` (qua re-export), không import trực tiếp `version.js`

### Độ bao phủ test
- `test/auto-test.js:820` "So sánh phiên bản theo từng đoạn số, tiền tố v / nhiều đoạn đều đúng" —— 4 assertion: `v0.3.2 > 0.3.1`, tiền tố `v` bằng nhau, `0.10.0 > 0.9.9` (chống so chuỗi), `1.0.0 < 1.0.1`.
- Lỗ hổng: `1.0` vs `1.0.0`, đoạn tiền phát hành, `+build`, giá trị rỗng đều không có test case.

---

## 9. `src/core/logfile.js`

### Trách nhiệm
Ghi nối nhật ký gọn nhẹ + cuộn theo kích thước (chỉ giữ một bản sao lưu `.1.log`), ngăn `app.log` / `emulator.log` tăng vô hạn ngốn đĩa.

### Giao diện công khai
```js
const { append, rotate, trimNow } = require('./logfile');

append(file, line, limitKB = 2048)   // → boolean (true=ghi thành công; mọi ngoại lệ đều false, ghi log không bao giờ ném lỗi)
rotate(file, limitKB)                // → boolean (true=lần này đã thực hiện cuộn)
trimNow(file, limitKB = 2048)        // → boolean (= rotate, nhưng bỏ qua bộ đếm; ★ trong src không có bên gọi)
```

### Cài đặt nội bộ quan trọng
- Chú thích động cơ (`logfile.js:4-9`): mỗi lần emulator khởi động log nhân vài chục KB, một ngày bật tắt hơn chục lần + qemu verbose → vài tháng lên vài trăm MB.
- `counters = new Map()` (`13`): đếm theo đường dẫn tệp **trong tiến trình**, không chia sẻ giữa các tiến trình.
- `rotate(file, limitKB)` (`15-26`):
  - `statSync` thất bại (tệp không tồn tại) → catch trả false (`23-25`)
  - `size < limitKB*1024` → false (`18`), tức là **chỉ cuộn khi vượt ngưỡng**
  - Tên bản sao lưu: `file.replace(/\.log$/i, '.1.log')` (`19`); trước tiên `rmSync(bak,{force:true})` rồi `renameSync(file,bak)` → luôn chỉ giữ một bản sao lưu
- `append(file, line, limitKB)` (`33-45`):
  - `mkdirSync(dirname, {recursive:true})` (`35`, kể cả khi ghi log cũng đảm bảo thư mục tồn tại)
  - Bộ đếm +1; **khi `n===1` (lần đầu trong tiến trình) hoặc `n%200===0`** mới `rotate` (`39`, chú thích `38`: `statSync` rất rẻ nhưng không cần làm mỗi dòng)
  - `appendFileSync(file, line.endsWith('\n') ? line : line+'\n')` (`40`, tự bổ sung xuống dòng)
  - Kẹp cận dưới: `Math.max(256, Number(limitKB) || 2048)` (`39` / `49`) —— ngưỡng tối thiểu 256KB
  - Toàn bộ hàm bọc trong try/catch, thất bại trả false (`41-44`)

### Cạm bẫy và bất biến
1. **★ Tên tệp không kết thúc bằng `.log` sẽ mất nhật ký**: `bak === file`, thế là `rmSync(bak)` xóa luôn tệp, `renameSync` thất bại vì nguồn không tồn tại (ENOENT) → trả false, **nhật ký gốc đã bị xóa**. Hiện cả hai chỗ gọi đều truyền `*.log` (`app.log`, `emulator.log`), nên chưa nổ; mọi lời gọi mới phải tuân thủ hợp đồng ngầm "tên tệp kết thúc bằng .log".
2. **Cuộn diễn ra trước append** (`39` trước `40`): sau khi cuộn ghi ngay vào tệp mới, nhật ký liên tục, không xảy ra "cuộn xong mất dòng này".
3. **Bộ đếm ở cấp tiến trình**: sau khi tiến trình chính khởi động lại thì đếm lại từ 1 → mỗi lần khởi động chắc chắn làm một lần `statSync`, hành vi đúng (cũng có nghĩa là **khi lâu không khởi động lại** tối đa bỏ sót kiểm tra 199 dòng).
4. **Nhiều bên ghi không có khóa**: nếu tiến trình chính và tiến trình con (trong tương lai) ghi cùng một tệp, `rotate` có race (A xóa bak, B cũng xóa, A rename thành công, B rename thất bại → log của B ghi vào tệp mới, thực ra chấp nhận được).
5. **Ngữ nghĩa của `limitKB` là "ngưỡng cuộn" chứ không phải "giới hạn cứng"**: `line` của một lần append có thể dài tùy ý (emulator một lần ghi vài chục KB đầu ra khởi động), sau khi cuộn tệp vẫn có thể vượt xa ngưỡng, cho tới lần kiểm tra tiếp theo.
6. **`trimNow` là mã chết** (`48-50`, toàn dự án không có lời gọi nào): vốn dành cho "dọn trước khi khởi động", thực tế nhánh `n===1` của `append` đã bao phủ.
7. `limitKB` do bên gọi truyền không thống nhất: `main.js:84` dùng `settings.engine.logLimitKB`; `emulator.js:576` dùng `logLimitKB * 4` (và thêm `Math.max(2048, ...)`) —— cùng một mục cài đặt bị phóng to 4 lần ở hai chỗ, khi đọc con số trên trang cài đặt cần nhớ điều này.

### Được ai gọi
- `append`:
  - `src/main.js:85` (`appLog()`, `limit = store.getSettings().engine.logLimitKB || 2048`, xem `main.js:84`)
  - `src/core/emulator.js:577` (`_logWrite()`, `limit = max(2048, logLimitKB*4)`, xem `emulator.js:576`)
  - Lưu ý cả hai chỗ đều là **`require('./logfile')` bên trong hàm** (tải trễ), không phải ở đầu module
- `rotate`: `logfile.js:39` (chính nó), `test/auto-test.js:1408`
- `trimNow`: không có
- Test: `test/auto-test.js:1405`

### Độ bao phủ test
- `test/auto-test.js:1404` "Nhật ký vượt ngưỡng tự động cuộn, chỉ giữ một bản sao lưu" —— ghi 300KB, `rotate(f,256)`, assert tệp trở thành `rot.1.log`.
- Lỗ hổng: đường đếm/tự động cuộn của `append` (`n===1`, `n%200`) không có test case; `trimNow` không có; đường mất dữ liệu với tên tệp không phải `.log` không có.

---

## 10. Phụ lục: `src/core/display.js` (cũng thuộc nhóm module nhỏ công cụ thuần)

Tuy không thuộc chuỗi phân tích, nhưng đây là một module nhỏ khác trong `src/core` thuộc loại "tính toán thuần không phụ thuộc, unit test được", người tiếp nhận nên biết.

- **Trách nhiệm**: tính toán thuần cho thích ứng hiển thị (không phụ thuộc Electron/adb), hình chữ nhật cửa sổ ở chế độ toàn màn hình/cửa sổ và độ phân giải Android (`display.js:2-6`).
- **Giao diện**: `densityFor(w,h,manual)` → number (khi manual>0 thì clamp 120..640, nếu không thì `min(w,h)/2.57` clamp 200..480, `7-10`); `portraitSize(str)` → `{w,h}` (regex `^(\d{3,4})x(\d{3,4})$`, không phải dọc/vượt biên thì lùi về `900x1600`, `12-18`); `defaultBounds(area)` → `{x,y,w,h}` (cao 84%, rộng = cao·9/16, căn giữa, `20-28`); `fullscreenBounds(portrait,area)` (phủ kín chiều cao, tính chiều rộng theo tỷ lệ dọc, căn giữa theo chiều ngang, `36-46`); `sizeFor(mode,portrait,area)` (`55-57`).
- **Cạm bẫy chính**: `sizeFor` **hoàn toàn bỏ qua tham số `mode`** (`55-57`, luôn trả về preset dọc). Đây không phải bug: chú thích (`48-54`) giải thích tỷ lệ rộng/cao của cửa sổ trình giả lập bị LCD khóa lúc khởi động, đổi độ phân giải Android sẽ làm hình ảnh biến dạng; "toàn màn hình" chỉ là phóng to cửa sổ tối đa.
- **Được ai gọi**: `src/main.js:32` (require), `main.js:276` (`display.portraitSize(d.portrait || '540x960')`); test `test/auto-test.js:465`.
- **Test**: `auto-test.js:465` "Thích ứng hiển thị: cửa sổ/toàn màn hình dùng chung độ phân giải dọc, tỷ lệ cửa sổ 9:16 có thể kéo giãn", bao phủ `sizeFor`/`defaultBounds`/`fullscreenBounds`/`densityFor`.

---

# 11. Tổng quan ngăn xếp phân tích ngoại tuyến

## 11.1 Điểm vào và chuỗi gọi

**Bốn điểm vào**
| Điểm vào | Đường đi |
|---|---|
| UI phân tích xem trước | `ui/app.js` → `preload.js:10` `parseApk` → `main.js:756` `apk:parse` → `parseApk` |
| UI cài đặt (đường chính thực tế) | `ui/app.js:484` `api.installApk` → `main.js:758` `apk:install` → `installer.install` (`installer.js:141`) → `parseApk` (`149`) hoặc `parseBundle` (`146`) |
| Nhấp đúp .apk (liên kết tệp) | `command` do `assoc.js` ghi → `apkstart.exe "%1"` → `main.js:206` `parseArgs` nhận diện `.apk` → luồng cài đặt |
| Tự kiểm tra bằng dòng lệnh | `scripts/selftest.js:142` → `parseApk` |

**Chuỗi gọi dạng văn bản bắt đầu từ `parseApk(filePath)`**

```
parseApk(filePath)                                   apk.js:75
├─ fs.statSync(filePath)                            apk.js:76   → sizeBytes
├─ fs.readFileSync(filePath)                        apk.js:78   ← [toàn bộ gói vào bộ nhớ]
├─ new ZipArchive(buf)                              apk.js:79   → zip.js:13
│  ├─ _parse()                                      zip.js:20
│  │  ├─ quét ngược EOCD từ cuối (cửa sổ 65557B)    zip.js:23-26
│  │  ├─ total@+10 / cdOffset@+16                   zip.js:29-30
│  │  └─ vòng lặp central directory → entries(Map)  zip.js:32-47
│  ├─ has('AndroidManifest.xml')                    apk.js:81   (không có → ném "có thể là .apks/.xapk")
│  ├─ read('AndroidManifest.xml')                   apk.js:85   → zip.js:54 (inflateRawSync)
│  └─ (chỉ read ảnh khi dùng biểu tượng dự phòng)   apk.js:43
├─ parseAxml(manifestBuf)                           apk.js:86   → axml.js:67
│  ├─ readStringPool (hai nhánh UTF-8/UTF-16)       axml.js:88  → 26
│  ├─ START_ELEMENT + attr×N (20B/cái, cơ sở +16)   axml.js:98-140
│  └─ trả về nút manifest                           axml.js:147
├─ attrValue(manifest,'package', ns=null)           apk.js:88
├─ new ResTable(zip.read('resources.arsc'))         apk.js:104  → arsc.js:79 (try/catch, thất bại→null)
│  ├─ string pool toàn cục (chỉ lấy cái đầu tiên)   arsc.js:99-100
│  ├─ packages[].types: Map<typeId, config[]>       arsc.js:101-103 / 141
│  └─ resolve(ref, 'string'|'file')                 arsc.js:200 → score() chọn config
│     ├─ label:  resolve(labelRef,'string')         apk.js:111
│     ├─ icon:   resolve(iconRef,'file')            apk.js:141
│     └─ thích ứng: iconFromAdaptiveXml → parseAxml → resolve → zip.read   apk.js:51-73
├─ isLauncherActivity(activity|activity-alias)      apk.js:122 → 15
├─ !icon → pickIconFromZip(zip)                     apk.js:152 → 27 (chấm điểm theo tên+uncompSize)
├─ abis = lib/<abi>/ trong zip.names() khử trùng    apk.js:155
└─ return { package,label,versionName,versionCode,minSdk,targetSdk,
            launchActivity,abis,iconPng,iconFile }  apk.js:160-174

──────────────── phía installer (siêu thông tin → biểu tượng → ICO → .lnk) ────────────────

installer.finishInstall(rt, meta, ...)               installer.js:179
├─ store.iconPath(pkg) → ghi <ICON_DIR>/<pkg>.png    installer.js:208-209 (nội dung có thể là WebP!)
├─ iconToIco(meta.iconPng, {decode: ctx.decodeIcon}) installer.js:212 → shortcut.js:109
│  ├─ ① nativeImage.createFromBuffer → pngToIco     shortcut.js:112-116 → 39
│  │     └─ resize ×9(16..256) → buildDib → ICONDIR  shortcut.js:13 / 45-72
│  ├─ ② decodeIcon(raw) (BrowserWindow ẩn+canvas)   main.js:213-229
│  │     └─ canvas.toDataURL('image/png') → pngBytesToIco  shortcut.js:83
│  └─ ③ drawAppIcon(256) → pngBytesToIco            shortcut.js:127-129 → png.js:80
├─ ghi <ICON_DIR>/<pkg>.ico                          installer.js:214-215
├─ store.upsertApp(app)                              installer.js:259
└─ createShortcut(app)                               installer.js:265 / 286
   ├─ safeFileName(label) → hai đường dẫn desktop / Start Menu   installer.js:75 / 88
   └─ writeShortcut({target,args,iconIcoPath,...})   installer.js:292 → shortcut.js:144
      └─ shell.writeShortcutLink + đọc lại fs.existsSync  shortcut.js:155-167
```

## 11.2 Hồ sơ bộ nhớ và thời gian

| Giai đoạn | Dạng dữ liệu | Chi phí đỉnh |
|---|---|---|
| `readFileSync` (`apk.js:78`) | Buffer của toàn bộ APK | ≈ kích thước tệp (APK 500MB → 500MB) |
| `ZipArchive._parse` | `Map` siêu thông tin central directory | Mỗi mục ~100B; 10 nghìn mục ≈ 1MB |
| `zip.read(manifest)` | Kết quả inflate | Manifest thường vài chục KB |
| `zip.read(resources.arsc)` | Kết quả inflate | Vài MB (App của hãng lớn có thể 10MB+) |
| `ResTable._parse` | Cây Map của `packages[].types` | Tỷ lệ thuận với số tài nguyên, App cỡ trăm MB khoảng vài MB~hơn chục MB |
| `zip.read(icon)` | Byte gốc của biểu tượng | Thường < 1MB (webp xxxhdpi vài chục KB) |
| Toàn quá trình | Buffer cũ không được thu hồi (`zip.buf` giữ tham chiếu) | **Trước khi phân tích kết thúc, toàn bộ APK thường trú trong bộ nhớ** |

Thời gian: APK bình thường (cỡ 50MB) ≈ 100–300ms, chủ yếu tốn ở `inflateRawSync(resources.arsc)` và duyệt entry của `ResTable`; `drawAppIcon(256)` cỡ khoảng 10ms (và `main.js:175` chỉ tính một lần khi khởi động rồi cache).

## 11.3 Những chỗ mong manh nhất, đáng tái cấu trúc nhất (sắp theo "lợi ích/rủi ro")

1. **`parseApk` đọc toàn gói vào bộ nhớ (`apk.js:78`) —— nên sửa đầu tiên**
   `ZipFile` hiện có đã có thể chỉ đọc central directory + đọc stream mục theo nhu cầu, `provision.js:594-595` chính là tiền lệ "dùng ZipFile khi >64MB". Đổi `parseApk` thành `new ZipFile(filePath)` chỉ đọc ba thứ `AndroidManifest.xml` / `resources.arsc` / biểu tượng, bộ nhớ đỉnh sẽ giảm từ "kích thước tệp" xuống "vài MB", tiện thể vượt qua giới hạn Buffer 2GB. Thay đổi giới hạn trong `apk.js:75-175` + một `finally close()`, `installer.parseBundle` cũng chép y như vậy là được (hiện nó ở `installer.js:27` cũng `readFileSync` toàn gói).
   Lưu ý ngữ nghĩa giá trị rỗng của `zip.read` trên hai lớp khác nhau (`ZipArchive` trả null / `ZipFile` ném lỗi), khi thay thế cần bổ sung kiểm tra `has()`.

2. **Không có Zip64 (`zip.js:29-30`, `37`, `161-162`, `180`)**
   Khi số mục >65535, hoặc một mục >4GiB, hoặc trong EOCD `cdOffset === 0xffffffff`:
   - `ZipArchive`: `zip.js:30` lấy được `offset = 0xffffffff`, sau đó `readUInt32LE(offset)` ở `zip.js:33` trực tiếp `RangeError` nổi lên khỏi hàm khởi tạo (thông báo lỗi không liên quan gì tới "không phải ZIP hợp lệ", khó điều tra);
   - `ZipFile`: `cdOffset > eocdAbs` rơi vào `zip.js:166-169`, `len` thành số âm → ném "Offset central directory của ZIP bất thường"; khi `total === 0xffff` chỉ phân tích 65535 mục đầu, các mục dư **mất âm thầm**.
   Bản thân APK hiếm khi >4GB, nhưng **ảnh hệ thống/gói cập nhật** (`provision.js` / `updater.js` dùng cùng bộ mã) sớm muộn sẽ đụng phải. Cách sửa: khi phát hiện `0xffff/0xffffffff` trong EOCD thì định vị Zip64 EOCD (`0x06064b50`) và Zip64 locator (`0x07064b50`), đổi `compSize/uncompSize/localOffset/cdOffset/total` sang u64 (dùng `readBigUInt64LE` rồi chuyển sang Number, chú ý độ chính xác 2^53).

3. **Giải mã WebP phụ thuộc cửa sổ ẩn của Electron (`main.js:213-229` + `shortcut.js:120-126`)**
   Biểu tượng APK phần lớn là WebP, `nativeImage` không giải được, chỉ có thể mở một `BrowserWindow` + `canvas` + base64 (`raw.toString('base64')` khiến bộ nhớ tức thời ×1.33, cộng thêm chuỗi data URL). Ba vấn đề:
   - Khi không có GUI / headless / không có Electron (`selftest` Node thuần, test) sẽ **âm thầm hạ cấp thành ảnh giữ chỗ thương hiệu**, người dùng thấy tam giác xanh lá chứ không phải biểu tượng thật;
   - Lỗi của `executeJavaScript` không được phân loại, giải mã WebP thất bại và tạo cửa sổ thất bại đều là cùng một kiểu "không có biểu tượng";
   - Mỗi lần gọi đều đi một vòng kiểu IPC, khi cài hàng loạt là nút thắt tuần tự rõ rệt.
   Đề xuất: tích hợp một bộ giải mã WebP tối giản (hoặc ít nhất trong `iconToIco` phân biệt "ảnh giữ chỗ" với "giải mã thật thất bại", đưa nguyên nhân ra warnings của `installer`, để UI có thể báo "không phân tích được biểu tượng").

4. **Danh sách trắng định dạng khi trích xuất biểu tượng quá hẹp (`apk.js:29`, `apk.js:67`)**
   Chỉ nhận `.png`/`.webp`. Dẫn tới: biểu tượng `.jpg`/`.jpeg`, tổ hợp `<inset>`/`<layer-list>`/`<bitmap>` trong `<adaptive-icon>`, tài nguyên shape trong `drawable` đều rơi xuống dự phòng heuristic của `pickIconFromZip`, có thể trích ra ảnh khởi động/ảnh nền (chấm điểm chỉ nhìn `uncompSize` và tên tệp). Đề xuất: thêm `jpe?g` vào ứng viên; với XML đệ quy một tầng lấy `<bitmap android:src>` đầu tiên; chấm điểm đổi sang kích thước pixel thật đọc từ header PNG/WebP (`png.js` không có bộ giải mã, nhưng đọc header IHDR/VP8 chỉ mất hơn chục dòng).

5. **Việc chọn config của `arsc.js` là heuristic (`arsc.js:65-77`)**
   `anydpi` phạt 500, `language` phạt 40, `sdkVersion/1000` đều là hằng số ước chừng; không khớp locale (ứng dụng tiếng Trung có thể lấy ra tên tiếng Anh), không khớp chính xác "theo mật độ màn hình". Hơn nữa ba kiểu mã hóa entry (sparse / offset16 / u32) **không có bất kỳ test nào** —— một khi phiên bản toolchain Android nào đó đổi mã hóa, biểu hiện sẽ là "mọi biểu tượng và tên đột nhiên thành giá trị mặc định", nhưng không báo lỗi (try/catch ở `apk.js:103-105` sẽ nuốt nó thành `res=null`).
   Đề xuất: thêm test case byte tổng hợp cho `ResTable`, và đưa các hằng số của `score()` ra cấu hình tường minh.

6. **Cơ sở tương đối của `attributeStart` không có bất kỳ tuyến phòng thủ nào (`axml.js:105-106`)**
   Dòng dễ bị "tiện tay tái cấu trúc" làm hỏng nhất cả chuỗi, và khi hỏng thì **không báo lỗi, chỉ lệch**. Đề xuất thêm một test case byte AXML tối giản viết tay 20 dòng (string pool + một start element + hai thuộc tính), assert `attr()` lấy được `package` và `android:label`.

7. **`assoc.unregisterAssociation` xóa trống giá trị mặc định của `.apk` vô điều kiện (`assoc.js:62-63`)**
   Sự bảo vệ mà chú thích hứa hẹn không tồn tại, sẽ xóa mất liên kết `.apk` vốn có của người dùng; và toàn bộ module không có test. Cách sửa xem cạm bẫy 1 ở mục 7.

8. **`logfile.rotate` với tên tệp không phải `*.log` sẽ xóa trước rồi rename (`logfile.js:19-21`)**
   Chỉ một biên `bak === file` là đủ làm mất nhật ký; đề xuất thêm guard tường minh `if (bak === file) return false;`.

9. **Hai bản mã phân tích string pool bị trùng lặp (`axml.js:26` / `arsc.js:23`)**
   Logic hoàn toàn giống nhau (gồm cả điểm dễ sai là hai độ dài varint của UTF-8). Đề xuất tách ra `src/core/respool.js`, sửa một chỗ có hiệu lực cả hai.

10. **Mã chết/export vô dụng rải rác** (chi phí dọn thấp, nhưng sẽ gây hiểu lầm cho người mới tiếp nhận)
    `quickCheck` (`apk.js:178`, chỉ test dùng), `trimNow` (`logfile.js:48`, không có lời gọi), export `TYPE_REFERENCE` (`arsc.js:233`), export `ICO_SIZES` (`shortcut.js:182`), import không dùng `ANDROID_NS` (`apk.js:9`), noop ở `apk.js:38`, toán tử ba ngôi hai nhánh giống nhau ở `shortcut.js:46-48`, `pkgCount` đọc ra không dùng ở `arsc.js:92`, IPC `apk:parse` không có bên tiêu thụ ở UI (`main.js:756` + `preload.js:10`).

## 11.4 Danh sách lỗ hổng test (theo rủi ro)

`npm test` thực tế chạy `node test/run-tests.js && node test/engine-test.js && node test/auto-test.js` (`package.json:37`), **`test/electron-integration.js` không nằm trong đó** (phải chạy thủ công `electron test/electron-integration.js`).

| Lỗ hổng | Ảnh hưởng |
|---|---|
| AXML / ARSC không có test case byte tổng hợp, khi thiếu fixture APK thật thì bỏ qua cả đoạn (`run-tests.js:130-132`) | Trên CI `axml.js`/`arsc.js`/`apk.js` có độ bao phủ bằng 0 |
| `arsc.resolve()` không có assertion nào | Ba kiểu mã hóa entry + chấm điểm config hoàn toàn "chạy trần" |
| `.apks` / `.xapk` (`installer.parseBundle`) không có test case | Đường gói tách hoàn toàn dựa vào kiểm tra thủ công |
| `assoc.js` độ bao phủ bằng 0 | Ghi sai/xóa sai registry không ai biết |
| `pngToIco` / `writeShortcut` chỉ "chạy thông" trong tích hợp Electron, không vào `npm test` | `npm test` xanh không có nghĩa ICO/.lnk dùng được |
| Đường tự động cuộn của `logfile.append` chưa test | Chỉ test gọi trực tiếp `rotate` |
| Biên của `safeFileName` / `cmpVer` chưa test | Tên tệp không hợp lệ, `1.0` vs `1.0.0` |
| Không có ca âm Zip64 / mục siêu lớn / central directory bị cắt cụt | Vấn đề tệp lớn chỉ có thể tái hiện trên môi trường thật |

---

*Tài liệu này là WIP: số dòng dựa trên ảnh chụp 0.3.4, sau khi sửa các tệp liên quan xin cập nhật đồng bộ.*
