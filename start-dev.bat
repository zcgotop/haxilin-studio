@echo off
chcp 65001 >nul
REM ============================================================
REM  HaxiLin Studio — 本地开发一键启动脚本 (Windows)
REM  同时启动：博客编辑器（3001）+ 网站预览（4321）
REM  用法：双击本文件，或命令行 start-dev.bat
REM ============================================================
setlocal
set "ROOT=%~dp0"
set "EDITOR_DIR=%ROOT%admin-tool"

echo ============================================
echo   HaxiLin Studio — 本地开发环境启动中...
echo ============================================

REM 启动博客编辑器（新窗口）
echo [1/2] 启动博客编辑器 http://localhost:3001
start "博客编辑器" cmd /k "cd /d %EDITOR_DIR% && node server.js"

REM 启动网站预览（新窗口）
echo [2/2] 启动网站预览 http://localhost:4321
start "网站预览" cmd /k "cd /d %ROOT% && npx astro dev --port 4321"

echo ============================================
echo   博客编辑器: http://localhost:3001
echo   网站预览:   http://localhost:4321
echo ============================================
echo   两个窗口已分别打开，关闭窗口即可停止对应服务。
echo   按任意键退出此启动器（不影响已打开的服务窗口）...
pause >nul
endlocal
