@echo off
chcp 65001 >nul
setlocal

pushd "%~dp0"

set PORT=8000

echo ======================================================================
echo Image to Mesh Web - Local Server
echo ======================================================================
echo.
echo  http://localhost:%PORT%/ を開きます
echo  停止するには この画面で Ctrl+C を押してください
echo.

REM 既定ブラウザで開く（サーバー起動後に少し待ってから）
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/"

REM Python の簡易 HTTP サーバーを起動
python -m http.server %PORT%

popd
endlocal
