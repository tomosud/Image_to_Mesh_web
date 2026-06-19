@echo off
chcp 65001 >nul
setlocal

pushd "%~dp0"

set PORT=8000

echo ======================================================================
echo Image to Mesh Web - Local Server
echo ======================================================================
echo.
echo  Opening http://localhost:%PORT%/
echo  Press Ctrl+C in this window to stop the server
echo.

REM Open the default browser after the server has had time to start
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/"

REM Start Python's built-in HTTP server
python -m http.server %PORT%

popd
endlocal
