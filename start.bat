@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 扫码签到助手
echo.
echo   ============================================
echo    扫码签到助手
echo   ============================================
echo.
echo   [1/2] 启动后台服务 ...
start "" /min "runtime\node.exe" "app\server.mjs"
timeout /t 2 >nul
echo   [2/2] 打开控制台 ...
start "" http://127.0.0.1:62010
echo.
echo   --------------------------------------------
echo    接下来：在微信里打开「扫码签到」小程序
echo    进到要签到的那个页面，浏览器里点
echo    「使用签到点坐标」，然后回小程序点签到
echo.
echo    这个窗口不要关（关掉就失效了）
echo   --------------------------------------------
echo.
"runtime\python\python.exe" -u wmpf_watch.py
echo.
echo   注入器已退出。按任意键关闭。
pause >nul