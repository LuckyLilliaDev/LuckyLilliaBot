#!/bin/bash

echo "=========================================="
echo "LuckyLillia Docker 安装配置向导"
echo "=========================================="

# Auth Token (必填; 此处不做校验, 有效性在登录/WebUI 侧判定)
AUTH_TOKEN=""
echo ""
echo "Auth Token（必填）"
echo "获取地址: https://auth.luckylillia.com"
while [ -z "$AUTH_TOKEN" ]; do
    read -p "请输入 Auth Token（必填）: " input_token
    AUTH_TOKEN=$(printf '%s' "$input_token" | tr -d '[:space:]')
    [ -z "$AUTH_TOKEN" ] && echo "错误：Auth Token 不能为空！"
done
echo "[OK] 已记录 Auth Token，将写入 auth_token.txt"

AUTO_LOGIN_QQ=""
echo ""
while [ -z "$AUTO_LOGIN_QQ" ]; do
    read -p "请输入 QQ 号（必填）: " AUTO_LOGIN_QQ
    [[ "$AUTO_LOGIN_QQ" =~ ^[0-9]+$ ]] || { echo "错误：QQ 号必须是数字！"; AUTO_LOGIN_QQ=""; continue; }
done

# 连接模式: direct=无头, 纯代码复刻协议(省内存); nativeqq=有头, 官方 QQ 客户端和 Bot 在同一个容器, 由 NativeQQ 桥接
PROTOCOL_MODE="direct"
echo ""
echo "连接模式："
echo "1) 无头（纯协议，省内存）"
echo "2) 有头（需包含 QQ 与 LLBot 的原生镜像）"
read -p "请选择 (默认 1): " mode_choice
[ "$mode_choice" == "2" ] && PROTOCOL_MODE="nativeqq"

echo ""
echo "请选择配置方式："
echo "1) 现在配置（命令行配置所有选项）"
echo "2) 稍后配置（仅配置 WebUI，其他选项在 WebUI 中配置）"
echo ""
read -p "请选择 (1/2): " config_mode

declare -A SERVICE_PORTS

WEBUI_PORT="3080"
WEBUI_TOKEN=""

echo ""
echo "WebUI 配置："

while [ -z "$WEBUI_TOKEN" ]; do
    read -p "WebUI 密码（必填，仅支持英文和数字）: " WEBUI_TOKEN
done

while true; do
    read -p "WebUI 端口 (默认 3080): " port
    port=${port:-3080}
    [[ "$port" =~ ^[0-9]+$ ]] || { echo "错误：端口必须是数字！"; continue; }
    WEBUI_PORT=$port
    SERVICE_PORTS["$WEBUI_PORT"]=1
    break
done

# 如果选择稍后配置，跳过协议配置
if [ "$config_mode" == "2" ]; then
    protocol_choices=""
else
    # 协议选择
    declare -a PROTOCOLS
    echo ""
    echo "请选择要启用的协议（可多选）："
    echo "1) OneBot 11"
    echo "2) Milky"
    echo "3) Satori"
    read -p "输入选项（用空格分隔，如: 1 3）: " protocol_choices
fi

# 选中的协议: 各自的插件包 (compose 的 command 里的 --plugin) 和配置 (插件在 llbot.launch 里声明的环境变量)
# 容器里要监听全部地址 (0.0.0.0) 才能从宿主机访问, 所以服务端的 Token 必填
PLUGINS=("@luckylillia-dev/plugin-nt-protocol")
PLUGIN_ENV=()

# 读一个端口到 REPLY: 第二个参数是默认值; 没有默认值时留空表示不启用
read_port() {
    local value
    while true; do
        read -p "$1" value
        value=${value:-$2}
        if [ -z "$value" ]; then REPLY=""; return; fi
        if [[ "$value" =~ ^[0-9]+$ ]] && [ "$value" -ge 1 ] && [ "$value" -le 65535 ]; then REPLY=$value; return; fi
        echo "错误：端口必须是 1-65535 的数字！"
    done
}

read_required() {
    local value=""
    while [ -z "$value" ]; do read -p "$1" value; done
    REPLY=$value
}

if [[ "$protocol_choices" =~ 1 ]]; then
    PLUGINS+=("@luckylillia-dev/plugin-onebot11")
    echo ""
    echo "OneBot 11 连接配置（每种连接一条，留空不启用；更多连接可以在 WebUI 里添加）："
    read_port "WebSocket 服务端端口: "
    if [ -n "$REPLY" ]; then
        port=$REPLY; read_required "WebSocket 服务端 Token (必填): "
        PLUGIN_ENV+=("ONEBOT_WS_HOST=0.0.0.0" "ONEBOT_WS_PORT=$port" "ONEBOT_WS_TOKEN=$REPLY")
        SERVICE_PORTS["$port"]=1
    fi
    read_port "HTTP 服务端端口: "
    if [ -n "$REPLY" ]; then
        port=$REPLY; read_required "HTTP 服务端 Token (必填): "
        PLUGIN_ENV+=("ONEBOT_HTTP_HOST=0.0.0.0" "ONEBOT_HTTP_PORT=$port" "ONEBOT_HTTP_TOKEN=$REPLY")
        SERVICE_PORTS["$port"]=1
    fi
    read -p "WebSocket 客户端（反向）地址: " url
    if [ -n "$url" ]; then
        read -p "WebSocket 客户端 Token (可选): " token
        PLUGIN_ENV+=("ONEBOT_WS_REVERSE_URL=$url")
        [ -n "$token" ] && PLUGIN_ENV+=("ONEBOT_WS_REVERSE_TOKEN=$token")
    fi
    read -p "HTTP 上报 (WebHook) 地址: " url
    if [ -n "$url" ]; then
        read -p "HTTP 上报 Token (可选): " token
        PLUGIN_ENV+=("ONEBOT_HTTP_POST_URL=$url")
        [ -n "$token" ] && PLUGIN_ENV+=("ONEBOT_HTTP_POST_TOKEN=$token")
    fi
fi

if [[ "$protocol_choices" =~ 2 ]]; then
    PLUGINS+=("@luckylillia-dev/plugin-milky")
    echo ""
    echo "Milky HTTP 配置："
    read_port "HTTP 端口 (默认 3000): " 3000
    port=$REPLY
    SERVICE_PORTS["$port"]=1
    read -p "HTTP 路径前缀 (默认 /milky): " prefix
    read_required "Access Token (必填): "
    PLUGIN_ENV+=("MILKY_HOST=0.0.0.0" "MILKY_PORT=$port" "MILKY_PREFIX=${prefix:-/milky}" "MILKY_TOKEN=$REPLY")
    echo ""
    read -p "是否配置 WebHook (y/n): " enable_webhook
    if [[ "$enable_webhook" =~ ^[yY]$ ]]; then
        read -p "WebHook URLs (用逗号分隔): " webhook_urls
        read -p "WebHook Access Token (可选): " token
        [ -n "$webhook_urls" ] && PLUGIN_ENV+=("MILKY_WEBHOOK_URL=$(printf '%s' "$webhook_urls" | tr -d '[:space:]')")
        [ -n "$token" ] && PLUGIN_ENV+=("MILKY_WEBHOOK_TOKEN=$token")
    fi
fi

# Satori 随 Bot 自带, 不用安装
if [[ "$protocol_choices" =~ 3 ]]; then
    echo ""
    echo "Satori 配置："
    read_port "端口 (默认 5500): " 5500
    port=$REPLY
    SERVICE_PORTS["$port"]=1
    read_required "Token (必填): "
    PLUGIN_ENV+=("SATORI_HOST=0.0.0.0" "SATORI_PORT=$port" "SATORI_TOKEN=$REPLY")
fi

mkdir -p llbot_config

echo "$WEBUI_TOKEN" > "llbot_config/webui_token.txt"
echo "WebUI 密码文件已生成: llbot_config/webui_token.txt"

# Both modes share the same instance-owned authorization watcher.
echo "$AUTH_TOKEN" > "llbot_config/auth_token.txt"
echo "Auth Token 文件已生成: llbot_config/auth_token.txt"

# 设置配置目录权限，确保 Docker 容器可以读写
chmod -R 777 llbot_config

echo ""
read -p "是否使用 Docker 镜像源 (y/n): " use_docker_mirror

docker_mirror=""
LLBOT_TAG="latest"

get_npm_version() {
  local package=$1
  local version=$(curl -s --connect-timeout 5 "https://registry.npmjs.org/${package}/latest" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)
  if [ -n "$version" ]; then
    echo "$version"
    return 0
  fi
  return 1
}

echo ""
echo "正在获取最新版本信息..."

# 获取 LuckyLillia 版本
LLBOT_TAG=$(get_npm_version "llonebot-dist")
if [ -n "$LLBOT_TAG" ]; then
  echo "LuckyLillia 最新版本: $LLBOT_TAG"
else
  echo "无法获取 LuckyLillia 版本，将使用 latest"
  LLBOT_TAG="latest"
fi

if [[ "$use_docker_mirror" =~ ^[yY]$ ]]; then
  DOCKER_MIRRORS=(
    "docker.gh-proxy.cn"
  )

  test_mirror() {
    local mirror=$1
    local image=$2
    local tag=$3
    echo "测试镜像源 ${mirror} 的 ${image}:${tag} ..." >&2
    if timeout 30 docker manifest inspect "${mirror}/linyuchen/${image}:${tag}" > /dev/null 2>&1; then
      return 0
    fi
    return 1
  }

  # direct 模式使用标准 Bot 镜像；NativeQQ 模式稍后指定包含 QQ 的镜像
  find_available_mirror() {
    local llbot_tag=$1

    for mirror in "${DOCKER_MIRRORS[@]}"; do
      if test_mirror "$mirror" "llbot" "$llbot_tag"; then
        echo "找到可用镜像源: ${mirror}" >&2
        echo "${mirror}/"
        return 0
      fi
      echo "镜像源 ${mirror} 不可用或版本不存在" >&2
    done

    echo "所有镜像源均不可用或不支持该版本" >&2
    echo "将回退到 Docker 官方源使用 latest 标签" >&2
    LLBOT_TAG="latest"
        echo ""
    return 1
  }

  echo ""
  echo "正在检测可用的镜像源..."
  docker_mirror=$(find_available_mirror "$LLBOT_TAG")
fi

PORTS_CONFIG=""
if [ ${#SERVICE_PORTS[@]} -gt 0 ]; then
    PORTS_CONFIG="    ports:"
    for port in "${!SERVICE_PORTS[@]}"; do
        PORTS_CONFIG="${PORTS_CONFIG}
      - \"${port}:${port}\""
    done
fi

# llbot 健康检查：探测 WebUI HTTP（镜像是 debian slim，无 ps/curl，用 node 自带 fetch）
LLBOT_HEALTHCHECK="    healthcheck:
      test:
        - CMD-SHELL
        - node -e \"fetch('http://127.0.0.1:'+(process.env.WEBUI_PORT||3080)).then(()=>process.exit(0),()=>process.exit(1))\"
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 40s"

# YAML 双引号字符串: 值里的 \ 和 " 要转义
yaml_quote() { local v=${1//\\/\\\\}; printf '"%s"' "${v//\"/\\\"}"; }

COMMAND_CONFIG="    # 第一次启动时安装这些插件, 下面的 NTQQ_* 等环境变量是它们的配置
    command: ["
for i in "${!PLUGINS[@]}"; do
    [ $i -gt 0 ] && COMMAND_CONFIG+=", "
    COMMAND_CONFIG+="\"--plugin\", \"${PLUGINS[$i]}\""
done
COMMAND_CONFIG+="]"

NTQQ_MODE="direct"
[ "$PROTOCOL_MODE" == "nativeqq" ] && NTQQ_MODE="native"
ENV_CONFIG="    environment:
      - WEBUI_PORT=${WEBUI_PORT}
      - NTQQ_MODE=${NTQQ_MODE}
      # NTQQ_ACCOUNT 留空=WebUI 登录页扫码或点选账号; 填 QQ 号=启动时自动快速登录该号
      - NTQQ_ACCOUNT=${AUTO_LOGIN_QQ}"
for item in "${PLUGIN_ENV[@]}"; do
    ENV_CONFIG+="
      - $(yaml_quote "$item")"
done

if [ "$PROTOCOL_MODE" == "nativeqq" ]; then
    read -p "NativeQQ 镜像（按 docker/Dockerfile.nativeqq 构建，需包含 QQ）: " NATIVE_QQ_IMAGE
    [ -n "$NATIVE_QQ_IMAGE" ] || { echo "必须提供包含 QQ 和 LLBot 的镜像"; exit 1; }
    cat << EOF > docker-compose.yml
services:
  llbot:
    image: ${NATIVE_QQ_IMAGE}
    init: true
    stop_grace_period: 30s
${PORTS_CONFIG}
${COMMAND_CONFIG}
${ENV_CONFIG}
    volumes:
      - ./llbot_config:/app/llbot/data:rw
      - qq_volume:/root/.config/QQ
    restart: unless-stopped
${LLBOT_HEALTHCHECK}
volumes:
  qq_volume:
EOF
else
    cat << EOF > docker-compose.yml
services:
  llbot:
    image: ${docker_mirror}linyuchen/llbot:${LLBOT_TAG}
${PORTS_CONFIG}
${COMMAND_CONFIG}
    extra_hosts:
      - "host.docker.internal:host-gateway"
${ENV_CONFIG}
    volumes:
      - ./llbot_config:/app/llbot/data:rw
    restart: unless-stopped
${LLBOT_HEALTHCHECK}
EOF
fi

echo ""
echo "Docker Compose 配置已生成: docker-compose.yml"

printLogin(){
    echo ""
    echo "=========================================="
    echo "配置完成！"
    echo "=========================================="
    echo ""
    echo "生成的文件："
    echo "  - llbot_config/webui_token.txt"
    echo "  - llbot_config/auth_token.txt"
    echo "  - docker-compose.yml"
    echo ""
    echo "WebUI 访问地址: http://localhost:${WEBUI_PORT}"
    echo "WebUI 密码: ${WEBUI_TOKEN}"
    echo ""
    if [ "$PROTOCOL_MODE" == "nativeqq" ]; then
        echo "连接模式: 有头 (QQ 和 Bot 在同一个原生宿主容器内)"
        echo ""
    fi
    echo "登录方式: 启动后打开 WebUI 扫码登录，"
    echo "          或运行 sudo docker compose logs -f llbot 在日志中查看二维码"
    if [ "$config_mode" == "2" ]; then
        echo ""
        echo "提示: 您选择了稍后配置模式"
        echo "请在 WebUI 中完成 QQ 登录、协议配置等所有设置"
    fi
    echo ""
    echo "启动命令: sudo docker compose up -d"
    echo "查看日志: sudo docker compose logs -f"
    echo "=========================================="
}

# 检查root权限
if [ "$(id -u)" -ne 0 ]; then
    echo "没有 root 权限，请手动运行 sudo docker compose up -d"
    printLogin
    exit 1
fi

if ! command -v docker &> /dev/null; then
  echo "没有安装 Docker！安装后运行 sudo docker compose up -d"
  printLogin
  exit 1
fi

echo ""
read -p "是否立即启动 Docker 容器 (y/n): " start_docker
if [[ "$start_docker" =~ ^[yY]$ ]]; then
    docker compose up -d
fi

printLogin
