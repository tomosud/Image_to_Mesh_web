@echo off
chcp 65001 >nul
setlocal

pushd "%~dp0"

if not defined PORT set "PORT=8000"
set "START_PORT=%PORT%"

:find_port
netstat -ano -p tcp | findstr /R /C:":%PORT% .*LISTENING" >nul
if not errorlevel 1 (
    echo Port %PORT% is already in use. Trying next port...
    set /a PORT+=1
    goto find_port
)

echo ======================================================================
echo Image to Mesh Web - Local Server
echo ======================================================================
echo.
if not "%PORT%"=="%START_PORT%" echo  Requested port %START_PORT% was busy; using %PORT% instead.
echo  Opening http://localhost:%PORT%/
echo  Press Ctrl+C in this window to stop the server
echo.

REM Open the default browser after the server has had time to start
start "" cmd /c "timeout /t 2 >nul & start http://localhost:%PORT%/"

REM Start Python's built-in HTTP server
python -m http.server %PORT%

popd
endlocal
