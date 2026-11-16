'use strict';
/**
 * Trình đọc ZIP tối giản (chỉ phụ thuộc zlib có sẵn của Node)
 * Chỉ phân tích central directory, giải nén từng mục khi cần, tránh giải nén toàn bộ APK lớn làm tràn bộ nhớ.
 *
 * Lưu ý: file này chỉ「đọc」, không「ghi」. Hai bất biến liên quan đến「kích thước」:
 *  - Một Buffer có giới hạn (Node khoảng 2GB), nên mục cỡ GB luôn đi qua ZipFile + pipeTo;
 *  - EOCD truyền thống của ZIP lưu số mục và offset bằng 16/32 bit, vượt quá thì thành 0xffff/0xffffffff,
 *    giá trị thật nằm trong Zip64 EOCD (0x06064b50) và trường mở rộng Zip64 (id=0x0001).
 *    Cả hai đường đều phải nhận diện, nếu không gói image lớn sẽ bị「cắt mục âm thầm」hoặc vượt biên.
 */
const zlib = require('zlib');
const fs = require('fs');

const EOCD_SIG = 0x06054b50;
const CEN_SIG = 0x02014b50;
const LOC_SIG = 0x04034b50;
const ZIP64_EOCD_SIG = 0x06064b50;
const ZIP64_LOC_SIG = 0x07064b50;
const MAX32 = 0xffffffff;
const MAX16 = 0xffff;
// Giới hạn một mục của read(): vượt quá thì yêu cầu bên gọi dùng pipeTo (stream), tránh đưa cả khối vào bộ nhớ
const MAX_READ = 256 * 1024 * 1024;

/** Chuyển offset BigInt sang Number một cách an toàn (ZIP không thể lớn hơn 2^53 byte) */
function toNum(v) { return typeof v === 'bigint' ? Number(v) : v; }

/**
 * Phân tích trường mở rộng Zip64 (0x0001), bổ sung các trường bị đặt thành 0xffffffff trong central directory.
 * Thứ tự trường cố định: kích thước chưa nén, kích thước nén, offset header cục bộ, số đĩa bắt đầu; chỉ xuất hiện những trường「bị đặt cờ」.
 * @param {Buffer} extra trường mở rộng của mục central directory
 * @param {{uncompSize:number, compSize:number, localOffset:number}} fields
 */
function applyZip64Extra(extra, fields) {
  if (!extra || extra.length < 4) return fields;
  let off = 0;
  while (off + 4 <= extra.length) {
    const id = extra.readUInt16LE(off);
    const len = extra.readUInt16LE(off + 2);
    const dataStart = off + 4;
    const dataEnd = dataStart + len;
    if (dataEnd > extra.length) break;
    if (id === 0x0001) {
      let p = dataStart;
      const take64 = () => {
        if (p + 8 > dataEnd) return null;
        const v = toNum(extra.readBigUInt64LE(p));
        p += 8;
        return v;
      };
      if (fields.uncompSize === MAX32) { const v = take64(); if (v !== null) fields.uncompSize = v; }
      if (fields.compSize === MAX32) { const v = take64(); if (v !== null) fields.compSize = v; }
      if (fields.localOffset === MAX32) { const v = take64(); if (v !== null) fields.localOffset = v; }
      break;
    }
    off = dataEnd;
  }
  return fields;
}

/**
 * Giải ra số mục / kích thước central directory / offset central directory từ vị trí EOCD, tự theo Zip64.
 * @param {Buffer} buf buffer chứa EOCD
 * @param {number} eocd chỉ số của EOCD trong buf
 * @param {number} base offset tuyệt đối trong file tương ứng buf[0] (dùng cho cửa sổ đuôi của ZipFile)
 * @returns {{total:number, cdSize:number, cdOffset:number, eocdAbs:number}}
 */
function readEndOfCentralDirectory(buf, eocd, base) {
  let total = buf.readUInt16LE(eocd + 10);
  let cdSize = buf.readUInt32LE(eocd + 12);
  let cdOffset = buf.readUInt32LE(eocd + 16);
  const eocdAbs = base + eocd;

  const needsZip64 = total === MAX16 || cdSize === MAX32 || cdOffset === MAX32;
  if (!needsZip64) return { total, cdSize, cdOffset, eocdAbs };

  // Zip64 EOCD locator luôn nằm sát trước EOCD 20 byte
  const loc = eocd - 20;
  if (loc < 0) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(loc) !== ZIP64_LOC_SIG) return { total, cdSize, cdOffset, eocdAbs };
  const z64Abs = toNum(buf.readBigUInt64LE(loc + 8));
  const z64 = z64Abs - base;
  if (z64 < 0 || z64 + 56 > buf.length) return { total, cdSize, cdOffset, eocdAbs };
  if (buf.readUInt32LE(z64) !== ZIP64_EOCD_SIG) return { total, cdSize, cdOffset, eocdAbs };

  total = toNum(buf.readBigUInt64LE(z64 + 32));
  cdSize = toNum(buf.readBigUInt64LE(z64 + 40));
  cdOffset = toNum(buf.readBigUInt64LE(z64 + 48));
  return { total, cdSize, cdOffset, eocdAbs };
}

class ZipArchive {
  constructor(buffer) {
    this.buf = buffer;
    this.entries = new Map();
    this._parse();
  }

  _parse() {
    const buf = this.buf;
    let eocd = -1;
    const maxScan = Math.max(0, buf.length - 65557);
    for (let i = buf.length - 22; i >= maxScan; i--) {
      if (buf.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Không phải file ZIP/APK hợp lệ (không tìm thấy EOCD)');

    const { total, cdOffset } = readEndOfCentralDirectory(buf, eocd, 0);
    let offset = cdOffset;

    for (let i = 0; i < total; i++) {
      if (offset + 46 > buf.length || buf.readUInt32LE(offset) !== CEN_SIG) break;
      const flags = buf.readUInt16LE(offset + 8);
      const method = buf.readUInt16LE(offset + 10);
      const nameLen = buf.readUInt16LE(offset + 28);
      const extraLen = buf.readUInt16LE(offset + 30);
      const commentLen = buf.readUInt16LE(offset + 32);
      const nameEnd = offset + 46 + nameLen;
      if (nameEnd > buf.length) break;
      const fields = applyZip64Extra(
        buf.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: buf.readUInt32LE(offset + 24),
          compSize: buf.readUInt32LE(offset + 20),
          localOffset: buf.readUInt32LE(offset + 42),
        },
      );
      const name = buf.toString('utf8', offset + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      offset = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }

  names() { return [...this.entries.keys()]; }

  read(name) {
    const e = this.entries.get(name);
    if (!e) return null;
    const buf = this.buf;
    if (e.localOffset + 30 > buf.length) throw new Error(`Header file cục bộ vượt biên: ${name}`);
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      throw new Error(`Header file cục bộ bị hỏng: ${name}`);
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    if (start + e.compSize > buf.length) throw new Error(`Dữ liệu mục vượt biên: ${name}`);
    const raw = buf.subarray(start, start + e.compSize);
    if (e.method === 0) return Buffer.from(raw);
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Không hỗ trợ phương thức nén ${e.method}: ${name}`);
  }

  /** Liệt kê tên các mục khớp một tiền tố/regex */
  find(re) {
    return [...this.entries.keys()].filter((n) => re.test(n));
  }

  /**
   * Giải nén stream một mục vào writable stream.
   * Các mục cỡ GB như system.img không thể inflate cả khối vào bộ nhớ (sẽ chạm giới hạn 2GB của một Buffer trong Node),
   * bắt buộc vừa giải nén vừa ghi đĩa.
   */
  pipeTo(name, dest) {
    const e = this.entries.get(name);
    if (!e) return Promise.reject(new Error(`Mục không tồn tại: ${name}`));
    const buf = this.buf;
    if (buf.readUInt32LE(e.localOffset) !== LOC_SIG) {
      return Promise.reject(new Error(`Header file cục bộ bị hỏng: ${name}`));
    }
    const nameLen = buf.readUInt16LE(e.localOffset + 26);
    const extraLen = buf.readUInt16LE(e.localOffset + 28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    const raw = buf.subarray(start, start + e.compSize);

    return new Promise((resolve, reject) => {
      const done = (err) => { if (err) reject(err); else resolve(e.uncompSize); };
      dest.on('error', done);
      dest.on('finish', () => done(null));

      if (e.method === 0) {
        dest.end(raw);
        return;
      }
      if (e.method !== 8) return done(new Error(`Không hỗ trợ phương thức nén ${e.method}: ${name}`));

      const inflater = zlib.createInflateRaw();
      // Đưa vào theo từng mảnh, tránh nhét một lần dữ liệu GB vào buffer của zlib
      const SLICE = 1 << 20;
      let pos = 0;
      const pump = () => {
        while (pos < raw.length) {
          const end = Math.min(pos + SLICE, raw.length);
          const chunk = raw.subarray(pos, end);
          pos = end;
          if (!inflater.write(chunk)) {
            inflater.once('drain', pump);
            return;
          }
        }
        inflater.end();
      };
      inflater.on('error', done);
      inflater.pipe(dest);
      pump();
    });
  }
}

/**
 * Trình đọc ZIP theo file: chỉ đọc central directory ở đuôi vào bộ nhớ, các mục được đọc stream từ fd khi cần.
 * Dùng cho gói cài đặt cỡ GB như emulator / system image —— bản cũ dùng fs.readFileSync đọc cả gói sẽ
 * OOM ngay trên máy ít RAM, biểu hiện là「tải xong rồi mà không cài được」.
 */
class ZipFile {
  constructor(filePath) {
    this.path = filePath;
    this.fd = fs.openSync(filePath, 'r');
    this.size = fs.statSync(filePath).size;
    this.entries = new Map();
    try { this._parse(); } catch (e) { this.close(); throw e; }
  }

  close() {
    if (this.fd != null) { try { fs.closeSync(this.fd); } catch (_) { /* ignore */ } }
    this.fd = null;
  }

  _readAt(pos, len) {
    const n = Math.max(0, Math.min(len, this.size - pos));
    const b = Buffer.alloc(n);
    if (n > 0) {
      let got = 0;
      while (got < n) {
        // readSync có thể đọc thiếu (nhất là khối lớn), bắt buộc lặp đến khi đọc đủ
        const r = fs.readSync(this.fd, b, got, n - got, pos + got);
        if (r <= 0) break;
        got += r;
      }
    }
    return b;
  }

  _parse() {
    if (this.size < 22) throw new Error('Không phải file ZIP/APK hợp lệ (file quá nhỏ)');
    const tailLen = Math.min(this.size, 22 + 65557 + 4096);
    const tailBase = this.size - tailLen;
    const tail = this._readAt(tailBase, tailLen);
    let eocd = -1;
    for (let i = tail.length - 22; i >= 0; i -= 1) {
      if (tail.readUInt32LE(i) === EOCD_SIG) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('Không phải file ZIP/APK hợp lệ (không tìm thấy EOCD)');

    const { total, cdSize, cdOffset, eocdAbs } = readEndOfCentralDirectory(tail, eocd, tailBase);
    if (cdOffset + cdSize > this.size) {
      throw new Error('Offset central directory của ZIP bất thường');
    }

    let cd = tail;
    let cdBase = tailBase;
    if (cdOffset < tailBase || cdOffset + cdSize > eocdAbs) {
      // Central directory không nằm trong buffer đuôi (comment siêu lớn / nhiều volume), đọc chính xác một đoạn theo kích thước khai báo
      const len = Math.min(cdSize, 256 * 1024 * 1024);
      if (len <= 0) throw new Error('Offset central directory của ZIP bất thường');
      cd = this._readAt(cdOffset, len);
      cdBase = cdOffset;
    }

    let off = cdOffset - cdBase;
    for (let i = 0; i < total; i += 1) {
      if (off + 46 > cd.length || cd.readUInt32LE(off) !== CEN_SIG) break;
      const flags = cd.readUInt16LE(off + 8);
      const method = cd.readUInt16LE(off + 10);
      const nameLen = cd.readUInt16LE(off + 28);
      const extraLen = cd.readUInt16LE(off + 30);
      const commentLen = cd.readUInt16LE(off + 32);
      const nameEnd = off + 46 + nameLen;
      if (nameEnd > cd.length) break;
      const fields = applyZip64Extra(
        cd.subarray(nameEnd, nameEnd + extraLen),
        {
          uncompSize: cd.readUInt32LE(off + 24),
          compSize: cd.readUInt32LE(off + 20),
          localOffset: cd.readUInt32LE(off + 42),
        },
      );
      const name = cd.toString('utf8', off + 46, nameEnd);
      this.entries.set(name, {
        name, flags, method,
        compSize: fields.compSize,
        uncompSize: fields.uncompSize,
        localOffset: fields.localOffset,
      });
      off = nameEnd + extraLen + commentLen;
    }
  }

  has(name) { return this.entries.has(name); }
  names() { return [...this.entries.keys()]; }
  find(re) { return this.names().filter((n) => re.test(n)); }

  _range(name) {
    const e = this.entries.get(name);
    if (!e) throw new Error(`Mục không tồn tại: ${name}`);
    const head = this._readAt(e.localOffset, 30);
    if (head.length < 30 || head.readUInt32LE(0) !== LOC_SIG) throw new Error(`Header file cục bộ bị hỏng: ${name}`);
    const nameLen = head.readUInt16LE(26);
    const extraLen = head.readUInt16LE(28);
    const start = e.localOffset + 30 + nameLen + extraLen;
    return { e, start, end: start + e.compSize - 1 };
  }

  read(name) {
    const { e, start } = this._range(name);
    // read() sẽ giải cả mục vào bộ nhớ: đặt một giới hạn rõ ràng, tránh sau này có chỗ gọi nào đó tiện tay
    // dùng nó đọc image cỡ GB (đó chính là dạng「gói lớn chắc chắn nổ」trong issue #21).
    if (e.compSize > MAX_READ) {
      throw new Error(`Mục quá lớn (${(e.compSize / 1048576).toFixed(0)}MB), vui lòng dùng pipeTo: ${name}`);
    }
    const raw = this._readAt(start, e.compSize);
    if (raw.length < e.compSize) throw new Error(`Dữ liệu mục bị cắt cụt: ${name}`);
    if (e.method === 0) return raw;
    if (e.method === 8) return zlib.inflateRawSync(raw);
    throw new Error(`Không hỗ trợ phương thức nén ${e.method}: ${name}`);
  }

  pipeTo(name, dest) {
    let r;
    try { r = this._range(name); } catch (e) { return Promise.reject(e); }
    const { e, start, end } = r;
    return new Promise((resolve, reject) => {
      const done = (err) => (err ? reject(err) : resolve(e.uncompSize));
      dest.on('error', done);
      dest.on('finish', () => done(null));
      if (e.compSize === 0) { dest.end(); return undefined; }
      if (e.method !== 0 && e.method !== 8) return done(new Error(`Không hỗ trợ phương thức nén ${e.method}: ${name}`));
      const src = fs.createReadStream(null, {
        fd: this.fd, autoClose: false, start, end: Math.max(start, end),
      });
      src.on('error', done);
      if (e.method === 0) return src.pipe(dest);
      const inflater = zlib.createInflateRaw();
      inflater.on('error', done);
      return src.pipe(inflater).pipe(dest);
    });
  }
}

module.exports = { ZipArchive, ZipFile };
