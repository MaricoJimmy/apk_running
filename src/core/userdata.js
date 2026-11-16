'use strict';
/**
 * Tạo một image ext4 rỗng tối thiểu nhưng **hợp lệ**, làm hạt giống userdata cho Android Emulator.
 *
 * Vì sao cần nó (những cái hố đã từng dẫm, đừng lặp lại):
 * 1. Gói system image (system-images/.../userdata.img) thực ra chỉ chứa một file giữ chỗ toàn số 0
 *    1MB, việc định dạng thật lẽ ra do avdmanager gọi mke2fs của SDK làm. ApkStart thì trực tiếp
 *    ghi config.ini rồi khởi chạy emulator, bỏ qua bước đó —— vì vậy /data luôn toàn số 0,
 *    kernel báo "Invalid ext4 superblock on /dev/block/vdc", guest rơi vào
 *    vòng lặp khởi động lại recovery, adbd không bao giờ lên. Biểu hiện là「mở app chờ mấy phút rồi thất bại」.
 *    (emulator chỉ kèm e2fsck/resize2fs/tune2fs, **không kèm mke2fs**, nên nó cũng không tự định dạng.)
 *
 * 2. Kích thước block phải là 4096. /data của Android 13 dùng metadata encryption,
 *    vold sẽ chồng một lớp dm-default-key lên userdata. Kích thước block logic của thiết bị dm đó là
 *    4096, mà kernel sb_set_blocksize() yêu cầu fs block size >= kích thước block logic,
 *    image dùng block 1KB sẽ nhận mount() = EINVAL, log trông như sau:
 *      vold: [libfs_mgr] Cannot mount filesystem on /dev/block/dm-40 at /data: Invalid argument
 *      vold: fs_mgr_do_mount failed with rc -1
 *    Đổi sang block 4KB là bình thường.
 *
 * 3. Bắt buộc có EXT4_FEATURE_INCOMPAT_ENCRYPT(0x10000), nếu không
 *    `cryptfs init_user0` của vold thất bại ngay (exit 25) → lại một lần khởi động lại recovery.
 *
 * Image chỉ 64MB, emulator khi khởi động sẽ tự resize tới kích thước dataPartition cấu hình trong AVD,
 * e2fsck/resize2fs trong guest sẽ nới hệ thống file cho đầy, nên ở đây không cần lớn.
 */

const BLOCK = 4096;
const INODE_SIZE = 128;
const FIRST_INO = 11;

// Các bit feature của ext4
const COMPAT_EXT_ATTR = 0x8;    // thiếu nó thì setxattr trả EOPNOTSUPP ngay: không ghi được nhãn SELinux,
                                // netd / media / tombstoned sẽ cùng exit status 1
const COMPAT_DIR_INDEX = 0x20;
const INCOMPAT_FILETYPE = 0x2;
const INCOMPAT_ENCRYPT = 0x10000;
const RO_COMPAT_SPARSE_SUPER = 0x1;
const RO_COMPAT_LARGE_FILE = 0x2;

/**
 * @param {{sizeMB?: number, encrypt?: boolean}} [opts]
 *   Khi encrypt=false thì không có bit ENCRYPT —— chỉ dùng để「trước tiên cho
 *   e2fsck/resize2fs đi kèm emulator (1.42.12, không nhận encrypt) nới hệ thống file tới kích thước phân vùng」,
 *   sau đó mới bổ sung lại bit này.
 * @returns {Buffer} các byte có thể ghi thẳng thành image userdata
 */
function buildEmptyExt4(opts = {}) {
  const sizeMB = Math.max(8, Math.min(96, Math.round(opts.sizeMB || 64)));
  const blocks = Math.floor((sizeMB * 1024 * 1024) / BLOCK);
  // Một block group: với block 4KB một nhóm tối đa 8*4096 = 32768 block (128MB)
  const blocksPerGroup = Math.min(blocks, 8 * BLOCK);

  let inodes = Math.max(256, Math.round(blocks / 4));
  inodes = Math.ceil(inodes / 8) * 8;
  const inodeTableBlocks = Math.ceil((inodes * INODE_SIZE) / BLOCK);

  const GD_BLOCK = 1;
  const BB_BLOCK = 2;
  const IB_BLOCK = 3;
  const ITABLE_BLOCK = 4;
  const DIR_BLOCK = ITABLE_BLOCK + inodeTableBlocks;
  const usedBlocks = DIR_BLOCK + 1; // số block đã dùng (0..DIR_BLOCK)

  const buf = Buffer.alloc(blocks * BLOCK, 0);
  const now = Math.floor(Date.now() / 1000);
  const sb = 1024; // superblock cố định ở offset 1024

  // ---------- superblock ----------
  const reserved = Math.floor(blocks * 0.05);
  buf.writeUInt32LE(inodes, sb + 0x00);                       // s_inodes_count
  buf.writeUInt32LE(blocks, sb + 0x04);                       // s_blocks_count_lo
  buf.writeUInt32LE(reserved, sb + 0x08);                     // s_r_blocks_count
  buf.writeUInt32LE(blocks - usedBlocks, sb + 0x0C);          // s_free_blocks_count
  buf.writeUInt32LE(inodes - (FIRST_INO - 1), sb + 0x10);     // s_free_inodes_count (phải trừ các số 1~10 dành riêng)
  buf.writeUInt32LE(0, sb + 0x14);                            // s_first_data_block (bằng 0 khi 4K)
  buf.writeUInt32LE(2, sb + 0x18);                            // s_log_block_size = 2 → 4096
  buf.writeUInt32LE(2, sb + 0x1C);                            // s_log_cluster_size (phải bằng block size, nếu không EINVAL)
  buf.writeUInt32LE(blocksPerGroup, sb + 0x20);               // s_blocks_per_group
  buf.writeUInt32LE(blocksPerGroup, sb + 0x24);               // s_clusters_per_group
  buf.writeUInt32LE(inodes, sb + 0x28);                       // s_inodes_per_group
  buf.writeUInt32LE(now, sb + 0x2C);                          // s_mtime
  buf.writeUInt32LE(now, sb + 0x30);                          // s_wtime
  buf.writeUInt16LE(0, sb + 0x34);                            // s_mnt_count
  buf.writeUInt16LE(0xFFFF, sb + 0x36);                       // s_max_mnt_count
  buf.writeUInt16LE(0xEF53, sb + 0x38);                       // magic
  buf.writeUInt16LE(1, sb + 0x3A);                            // s_state = clean
  buf.writeUInt16LE(1, sb + 0x3C);                            // s_errors = continue (tuyệt đối đừng để 0)
  buf.writeUInt16LE(0, sb + 0x3E);                            // s_minor_rev_level
  buf.writeUInt32LE(now, sb + 0x40);                          // s_lastcheck
  buf.writeUInt32LE(0, sb + 0x44);                            // s_checkinterval
  buf.writeUInt32LE(0, sb + 0x48);                            // s_creator_os = Linux
  buf.writeUInt32LE(1, sb + 0x4C);                            // s_rev_level = dynamic
  buf.writeUInt16LE(0, sb + 0x50);                            // s_def_resuid
  buf.writeUInt16LE(0, sb + 0x52);                            // s_def_resgid
  buf.writeUInt32LE(FIRST_INO, sb + 0x54);                    // s_first_ino
  buf.writeUInt16LE(INODE_SIZE, sb + 0x58);                   // s_inode_size
  buf.writeUInt16LE(0, sb + 0x5A);                            // s_block_group_nr
  buf.writeUInt32LE(COMPAT_EXT_ATTR | COMPAT_DIR_INDEX, sb + 0x5C); // s_feature_compat
  buf.writeUInt32LE(INCOMPAT_FILETYPE | (opts.encrypt === false ? 0 : INCOMPAT_ENCRYPT), sb + 0x60); // s_feature_incompat
  buf.writeUInt32LE(RO_COMPAT_SPARSE_SUPER | RO_COMPAT_LARGE_FILE, sb + 0x64);
  Buffer.from('61706b7374617274303031', 'hex').copy(buf, sb + 0x68); // s_uuid
  buf.write('data', sb + 0x78, 'ascii');                      // s_volume_name
  buf.write('/data', sb + 0x88, 'ascii');                      // s_last_mounted
  buf.writeUInt32LE(0, sb + 0xC8);                             // s_algorithm_usage_bitmap
  buf.writeUInt8(0, sb + 0xCC + 1);                            // s_prealloc_blocks
  buf.writeUInt8(0, sb + 0xCE);
  // Thuật toán mã hóa được hỗ trợ: 1 = AES-256-XTS, 2 = AES-256-CTS (tổ hợp mặc định của Android)
  buf.writeUInt32LE(1, sb + 0x274);
  buf.writeUInt32LE(2, sb + 0x278);
  buf.writeUInt8(2, sb + 0xFC);                                // s_def_hash_version = half_md4
  buf.writeUInt16LE(0, sb + 0xFE);                             // s_desc_size (không phải 64bit thì dùng 0)

  // ---------- group descriptor（block 1）----------
  const gd = GD_BLOCK * BLOCK;
  buf.writeUInt32LE(BB_BLOCK, gd + 0x00);                      // bg_block_bitmap
  buf.writeUInt32LE(IB_BLOCK, gd + 0x04);                      // bg_inode_bitmap
  buf.writeUInt32LE(ITABLE_BLOCK, gd + 0x08);                  // bg_inode_table
  buf.writeUInt16LE(blocksPerGroup - usedBlocks, gd + 0x0C);   // bg_free_blocks_count
  buf.writeUInt16LE(inodes - FIRST_INO + 1, gd + 0x0E);        // bg_free_inodes_count
  buf.writeUInt16LE(1, gd + 0x10);                             // bg_used_dirs_count
  buf.writeUInt16LE(0, gd + 0x12);                             // bg_flags

  // ---------- block bitmap（block 2）：bit i ↔ block i ----------
  const bb = BB_BLOCK * BLOCK;
  for (let blk = 0; blk < usedBlocks; blk += 1) {
    buf[bb + (blk >> 3)] |= 1 << (blk & 7);
  }
  // Các padding bit vượt quá số block thực phải đặt 1 (bitmap trải đầy theo blocks_per_group)
  for (let bit = blocks; bit < blocksPerGroup; bit += 1) {
    buf[bb + (bit >> 3)] |= 1 << (bit & 7);
  }

  // ---------- inode bitmap (block 3): 1..10 dành riêng cho hệ thống ----------
  const ib = IB_BLOCK * BLOCK;
  for (let i = 0; i < FIRST_INO - 1; i += 1) {
    buf[ib + (i >> 3)] |= 1 << (i & 7);
  }

  // ---------- root inode（inode 2）----------
  const rootOff = ITABLE_BLOCK * BLOCK + (2 - 1) * INODE_SIZE;
  buf.writeUInt16LE(0x41ED, rootOff + 0x00);        // S_IFDIR | 0755
  buf.writeUInt16LE(0, rootOff + 0x02);             // i_uid
  buf.writeUInt32LE(BLOCK, rootOff + 0x04);         // i_size
  buf.writeUInt32LE(now, rootOff + 0x08);           // i_atime
  buf.writeUInt32LE(now, rootOff + 0x0C);           // i_ctime
  buf.writeUInt32LE(now, rootOff + 0x10);           // i_mtime
  buf.writeUInt32LE(0, rootOff + 0x14);             // i_dtime
  buf.writeUInt16LE(0, rootOff + 0x18);             // i_gid
  buf.writeUInt16LE(2, rootOff + 0x1A);             // i_links_count
  buf.writeUInt32LE(BLOCK / 512, rootOff + 0x1C);   // i_blocks (đơn vị 512B)
  buf.writeUInt32LE(0, rootOff + 0x20);             // i_flags
  buf.writeUInt32LE(DIR_BLOCK, rootOff + 0x28);     // i_block[0] (không có extents, dùng block trực tiếp)

  // ---------- block dữ liệu thư mục root ----------
  const dir = DIR_BLOCK * BLOCK;
  buf.writeUInt32LE(2, dir + 0);                    // "." → inode 2
  buf.writeUInt16LE(12, dir + 4);
  buf.writeUInt8(1, dir + 6);                       // name_len
  buf.writeUInt8(2, dir + 7);                       // file_type = DIR
  buf.write('.', dir + 8, 'ascii');

  buf.writeUInt32LE(2, dir + 12);                   // ".." → inode 2
  buf.writeUInt16LE(BLOCK - 12, dir + 16);
  buf.writeUInt8(2, dir + 18);
  buf.writeUInt8(2, dir + 19);
  buf.write('..', dir + 20, 'ascii');

  return buf;
}

/** Kiểm tra một image có magic ext4 hợp lệ không (dùng để tự phục hồi: toàn 0/hỏng thì dựng lại) */
function hasExt4Superblock(file) {
  let fd;
  try {
    fd = require('fs').openSync(file, 'r');
    const head = Buffer.alloc(2048);
    const n = require('fs').readSync(fd, head, 0, 2048, 0);
    if (n < 2048) return false;
    return head.readUInt16LE(1024 + 0x38) === 0xEF53;
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { require('fs').closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

/**
 * Bổ sung lại bit tính năng ENCRYPT (fscrypt) vào superblock.
 * Thứ tự rất quan trọng: phải để resize2fs đi kèm emulator nới hệ thống file tới kích thước phân vùng trước,
 * rồi mới bổ sung bit này —— bộ e2fsprogs bản cygwin đó là 1.42.12, không nhận encrypt,
 * có bit này thì e2fsck/resize2fs sẽ từ chối chạy ngay.
 */
function setEncryptFlag(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    const at = 1024 + 0x60; // s_feature_incompat
    fs.readSync(fd, b, 0, 4, at);
    b.writeUInt32LE(b.readUInt32LE(0) | INCOMPAT_ENCRYPT, 0);
    fs.writeSync(fd, b, 0, 4, at);
  } finally {
    fs.closeSync(fd);
  }
}

/** Trước khi resize2fs phải gỡ bit ENCRYPT (e2fsprogs bản cũ không nhận nó sẽ từ chối chạy) */
function clearEncryptFlag(file) {
  const fs = require('fs');
  const fd = fs.openSync(file, 'r+');
  try {
    const b = Buffer.alloc(4);
    const at = 1024 + 0x60;
    fs.readSync(fd, b, 0, 4, at);
    b.writeUInt32LE(b.readUInt32LE(0) & ~INCOMPAT_ENCRYPT, 0);
    fs.writeSync(fd, b, 0, 4, at);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Đọc dung lượng **của chính** hệ thống file (byte).
 * Mục đích then chốt: file image được qemu-img nới tới 8GB không có nghĩa ext4 bên trong cũng lớn tới 8GB.
 * Nếu resize2fs không chạy thành công (qemu-img bản cũ viết sai thứ tự tham số sẽ bị vậy),
 * file trông có 6GB mà Android chỉ có 64MB dùng được —— biểu hiện chính là「không đủ dung lượng khi cài game/cập nhật」.
 * Ở đây đọc thẳng số block và kích thước block trong superblock, để quyết định có cần chạy bổ sung resize2fs không.
 */
function fsBytes(file) {
  let fd;
  try {
    fd = require('fs').openSync(file, 'r');
    const sb = Buffer.alloc(2048);
    const n = require('fs').readSync(fd, sb, 0, sb.length, 0);
    if (n < 2048) return 0;
    if (sb.readUInt16LE(1024 + 0x38) !== 0xEF53) return 0;
    const blocksLo = sb.readUInt32LE(1024 + 0x4);
    const logBlock = sb.readUInt32LE(1024 + 0x18) & 0xffff;
    const blockSize = 1024 << logBlock;
    return blocksLo * blockSize;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { require('fs').closeSync(fd); } catch (_) { /* ignore */ }
    }
  }
}

module.exports = {
  buildEmptyExt4, hasExt4Superblock, setEncryptFlag, clearEncryptFlag, fsBytes, BLOCK,
};
