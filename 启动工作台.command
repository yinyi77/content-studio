#!/bin/zsh
cd -- "$(dirname -- "$0")" || exit 1
if ! command -v node >/dev/null 2>&1; then
  echo "请先安装 Node.js 20 或更新版本，然后重新启动。"
  read -r "?按回车退出"
  exit 1
fi
echo "浏览器打开 http://127.0.0.1:${PORT:-4318}"
node server.mjs
