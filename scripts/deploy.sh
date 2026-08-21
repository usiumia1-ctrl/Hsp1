#!/usr/bin/env bash
# ==========================================================================
# 一键把这个 bot 装成系统服务。
#
# 用法（在仓库根目录下执行，不要加 sudo，脚本自己会在需要时提权）：
#   bash scripts/deploy.sh
#
# 幂等的，可以重复跑——升级代码后再跑一次就完成更新重启。
# ==========================================================================
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE_NAME="aibot"
RUN_USER="$(id -un)"
NODE_MAJOR=22

info()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
warn()  { printf '\033[1;33m警告:\033[0m %s\n' "$*"; }
die()   { printf '\033[1;31m错误:\033[0m %s\n' "$*" >&2; exit 1; }

[[ $EUID -eq 0 ]] && die "别用 root 跑这个脚本，用你平时登录的普通用户执行即可。"

# -------------------------------------------------------------- 1. swap
# e2-micro 只有 1GB 内存，装依赖和跑 Node 都容易顶到上限，先垫 2GB swap。
if [[ "$(swapon --show --noheadings | wc -l)" -eq 0 ]]; then
  info "没有 swap，正在创建 2GB swap 文件"
  sudo fallocate -l 2G /swapfile || sudo dd if=/dev/zero of=/swapfile bs=1M count=2048
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  grep -q '^/swapfile' /etc/fstab || echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  info "swap 已启用"
else
  info "已有 swap，跳过"
fi

# -------------------------------------------------------------- 2. Node.js
need_node=1
if command -v node >/dev/null 2>&1; then
  current="$(node -v | sed 's/^v\([0-9]*\).*/\1/')"
  if [[ "$current" -ge 20 ]]; then
    info "Node.js 已安装：$(node -v)"
    need_node=0
  else
    warn "Node.js 版本过低（$(node -v)），需要 20 以上，将升级"
  fi
fi

if [[ $need_node -eq 1 ]]; then
  info "正在安装 Node.js ${NODE_MAJOR}.x"
  curl -fsSL "https://deb.nodesource.com/setup_${NODE_MAJOR}.x" | sudo -E bash -
  sudo apt-get install -y nodejs
  info "Node.js 装好了：$(node -v)"
fi

# better-sqlite3 在没有预编译包时要现场编译，得有编译工具链
if ! dpkg -s build-essential >/dev/null 2>&1; then
  info "正在安装编译工具链（better-sqlite3 可能需要）"
  sudo apt-get install -y build-essential python3
fi

# -------------------------------------------------------------- 3. 依赖
info "正在安装 npm 依赖"
cd "$REPO_DIR"
if [[ -f package-lock.json ]]; then
  npm ci --omit=dev
else
  npm install --omit=dev
fi

# -------------------------------------------------------------- 4. .env
if [[ ! -f "$REPO_DIR/.env" ]]; then
  cp "$REPO_DIR/.env.example" "$REPO_DIR/.env"
  chmod 600 "$REPO_DIR/.env"
  warn "已经生成 .env，但里面是空的。"
  warn "现在去填：  nano $REPO_DIR/.env"
  warn "填完再跑一次这个脚本，就会自动注册命令并启动服务。"
  exit 0
fi
chmod 600 "$REPO_DIR/.env"

# shellcheck disable=SC1090
set -a; source "$REPO_DIR/.env"; set +a

[[ -n "${DISCORD_TOKEN:-}" ]]     || die ".env 里的 DISCORD_TOKEN 还是空的"
[[ -n "${DISCORD_CLIENT_ID:-}" ]] || die ".env 里的 DISCORD_CLIENT_ID 还是空的"
if [[ -z "${GEMINI_API_KEY:-}${OPENAI_API_KEY:-}${ANTHROPIC_API_KEY:-}" ]]; then
  die "三个 AI 供应商的 key 一个都没填，bot 起来了也没法说话"
fi
[[ -n "${ADMIN_USER_IDS:-}" ]] || warn "ADMIN_USER_IDS 是空的，管理类命令谁都用不了"

# -------------------------------------------------------------- 5. 注册斜杠命令
info "正在向 Discord 注册斜杠命令"
npm run register

# -------------------------------------------------------------- 6. systemd
info "正在安装 systemd 服务"
NODE_BIN="$(command -v node)"
sed -e "s|__DIR__|${REPO_DIR}|g" \
    -e "s|__USER__|${RUN_USER}|g" \
    -e "s|__NODE__|${NODE_BIN}|g" \
    "$REPO_DIR/scripts/aibot.service" | sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" >/dev/null

mkdir -p "$REPO_DIR/data"

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl restart "$SERVICE_NAME"

sleep 3
if systemctl is-active --quiet "$SERVICE_NAME"; then
  info "启动成功，bot 已经在跑了"
else
  warn "服务没起来，下面是最近的日志："
  sudo journalctl -u "$SERVICE_NAME" -n 30 --no-pager
  exit 1
fi

cat <<EOF

--------------------------------------------------------
常用命令：
  看实时日志     sudo journalctl -u ${SERVICE_NAME} -f
  重启           sudo systemctl restart ${SERVICE_NAME}
  停止           sudo systemctl stop ${SERVICE_NAME}
  查看状态       sudo systemctl status ${SERVICE_NAME}

改了代码之后更新：
  cd ${REPO_DIR} && git pull && bash scripts/deploy.sh
--------------------------------------------------------
EOF
