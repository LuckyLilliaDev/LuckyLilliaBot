#!/bin/sh

cd /app/llbot

# Unified gateway address: bind all interfaces in the container by default and honour WEBUI_PORT
export LLBOT_WEBUI_HOST="${LLBOT_WEBUI_HOST-}"
export LLBOT_WEBUI_PORT="${LLBOT_WEBUI_PORT:-${WEBUI_PORT:-3080}}"

mkdir -p /app/llbot/data

# The NTQQ protocol plugin reads NTQQ_MODE, NTQQ_ACCOUNT and the rest (llbot.env in its package.json) once it is
# installed. The variables the image had before are passed on as those.
lower() { printf '%s' "$1" | tr 'A-Z' 'a-z'; }
if [ -z "$NTQQ_MODE" ]; then
  # The standard image has no QQ to bridge; PROTOCOL_MODE called the bridge nativeqq
  case "$PROTOCOL_MODE" in
    nativeqq) export NTQQ_MODE=native ;;
    "") export NTQQ_MODE=direct ;;
    *) export NTQQ_MODE="$PROTOCOL_MODE" ;;
  esac
fi
if [ -z "$NTQQ_ACCOUNT" ] && [ -n "$AUTO_LOGIN_QQ" ]; then export NTQQ_ACCOUNT="$AUTO_LOGIN_QQ"; fi
if [ -z "$NTQQ_PROTOCOL" ] && [ -n "$PROTOCOL" ]; then export NTQQ_PROTOCOL="$(lower "$PROTOCOL")"; fi
if [ -z "$NTQQ_SIGN_CDN" ] && [ -n "$CDN" ]; then
  if [ "$(lower "$CDN")" = china ]; then export NTQQ_SIGN_CDN=china; else export NTQQ_SIGN_CDN=cf; fi
fi
# The account in a NativeQQ configuration file the install script wrote, when no variable gives one
nativeqq_config="${NATIVEQQ_CONFIG:-/app/llbot/data/nativeqq_config.json}"
if [ -z "$NTQQ_ACCOUNT" ] && [ -f "$nativeqq_config" ]; then
  uin=$(sed -n 's/.*"quick_login_qq" *: *"\{0,1\}\([1-9][0-9]*\).*/\1/p' "$nativeqq_config")
  if [ -n "$uin" ]; then export NTQQ_ACCOUNT="$uin"; fi
fi

exec node --enable-source-maps ./llbot.js "$@"
