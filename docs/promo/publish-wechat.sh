#!/usr/bin/env bash
# Đẩy docs/promo/wechat-article.md vào hộp bản nháp của WeChat Official Account chỉ với một lệnh
# Cách dùng:
#   1) Đặt biến môi trường WECHAT_APP_ID / WECHAT_APP_SECRET, hoặc
#   2) Ghi vào $HOME/.baoyu-skills/.env (hoặc file do WECHAT_ENV_FILE chỉ định)
# Điều kiện: mục 「基本配置 → IP 白名单」 (Cấu hình cơ bản → Danh sách trắng IP) trong trang quản trị Official Account phải chứa IP công khai của máy này
set -e
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$ROOT"

ENV_FILE="${WECHAT_ENV_FILE:-$HOME/.baoyu-skills/.env}"
EXTRA=()
if [ -f "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
  EXTRA+=(--env-file "$ENV_FILE")
fi

if [ -z "$WECHAT_APP_ID" ] || [ -z "$WECHAT_APP_SECRET" ]; then
  echo "Thiếu thông tin xác thực: hãy đặt WECHAT_APP_ID / WECHAT_APP_SECRET, hoặc ghi vào $ENV_FILE" >&2
  exit 1
fi

wenyan publish \
  "${EXTRA[@]}" \
  -f docs/promo/wechat-article.md \
  -t lapis -h solarized-light --no-footnote

echo "Đã đẩy vào hộp bản nháp: đăng nhập https://mp.weixin.qq.com → 内容管理 (Quản lý nội dung) → 草稿箱 (Hộp bản nháp), duyệt rồi gửi hàng loạt"
