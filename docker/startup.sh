#!/bin/sh

cd /app/llbot

# Unified gateway address: bind all interfaces in the container by default and honour WEBUI_PORT
export LLBOT_WEBUI_HOST="${LLBOT_WEBUI_HOST-}"
export LLBOT_WEBUI_PORT="${LLBOT_WEBUI_PORT:-${WEBUI_PORT:-3080}}"

mkdir -p /app/llbot/data

case "$PROTOCOL_MODE" in
  ""|direct|nativeqq) ;;
  *) echo "PROTOCOL_MODE=$PROTOCOL_MODE 不认识，只能是 direct 或 nativeqq" >&2; exit 1 ;;
esac

# NativeQQ: the official QQ installation and Bot share this container.
if [ "$PROTOCOL_MODE" = "nativeqq" ]; then
  exec node --enable-source-maps ./llbot.js --nativeqq --nativeqq-config="${NATIVEQQ_CONFIG:-/app/llbot/data/nativeqq_config.json}" "$@"
fi

# 纯协议 (PROTOCOL_MODE 为空或 direct): --direct 锁定登录方式, 标准镜像里没有 QQ, 不能切到桥接
# 指定 AUTO_LOGIN_QQ 重启后自动免扫码快速登录（仅作用于目标实例，默认 default）。
# 不设 AUTO_LOGIN_QQ 则起在 WebUI, 可在实例管理页管理多个实例并扫码/快速登录
if [ -n "$AUTO_LOGIN_QQ" ]; then
  exec node --enable-source-maps ./llbot.js --direct -q "$AUTO_LOGIN_QQ" "$@"
fi
exec node --enable-source-maps ./llbot.js --direct "$@"
