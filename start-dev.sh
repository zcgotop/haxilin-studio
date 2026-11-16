#!/usr/bin/env bash
# ============================================================
#  HaxiLin Studio — 本地开发一键启动脚本
#  同时启动：博客编辑器（3001）+ 网站预览（4321）
#  用法： ./start-dev.sh
# ============================================================
set -e

ROOT="$(cd "$(dirname "$0")" && pwd)"
EDITOR_DIR="$ROOT/admin-tool"

# 颜色
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}============================================${NC}"
echo -e "${BLUE}  HaxiLin Studio — 本地开发环境启动中...${NC}"
echo -e "${BLUE}============================================${NC}"

# 检查端口是否被占用，占用则尝试释放
free_port() {
  local port=$1
  local pid
  pid=$(lsof -ti:"$port" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    echo "端口 $port 已被占用（PID $pid），尝试释放..."
    kill -9 "$pid" 2>/dev/null || true
    sleep 1
  fi
}

free_port 3001
free_port 4321

# 启动博客编辑器
echo -e "${GREEN}▶ 启动博客编辑器 (http://localhost:3001)${NC}"
cd "$EDITOR_DIR"
node server.js &
EDITOR_PID=$!

# 启动网站预览
echo -e "${GREEN}▶ 启动网站预览 (http://localhost:4321)${NC}"
cd "$ROOT"
npx astro dev --port 4321 &
SITE_PID=$!

echo -e "${BLUE}--------------------------------------------${NC}"
echo -e "  博客编辑器: ${GREEN}http://localhost:3001${NC}"
echo -e "  网站预览:   ${GREEN}http://localhost:4321${NC}"
echo -e "${BLUE}--------------------------------------------${NC}"
echo "  按 Ctrl+C 停止所有服务"

# 捕获退出信号，清理子进程
cleanup() {
  echo -e "\n${BLUE}正在停止服务...${NC}"
  kill $EDITOR_PID 2>/dev/null || true
  kill $SITE_PID 2>/dev/null || true
  exit 0
}
trap cleanup SIGINT SIGTERM

# 等待子进程
wait
