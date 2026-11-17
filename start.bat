@echo off
rem Console output is needed only for these options. Everything else starts without a console window.
rem The usual start has no arguments: skip the check (the pipe to findstr costs about 20 ms).
if "%~1"=="" goto headless
echo.%* | findstr /i "NoBrowser BuildOnly ShowServerLog" >nul
if not errorlevel 1 (
    powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\start.ps1" %*
    if errorlevel 1 pause
    exit /b
)
:headless
rem Windows 10 1809 (build 17763) or later: start PowerShell directly in a headless console (one process hop, about 0.3 s faster).
rem start.ps1 leaves .run\headless-ok once it has seen such a Windows, so later starts skip asking "ver" (about 20 ms).
if exist "%~dp0.run\headless-ok" if exist "%SystemRoot%\System32\conhost.exe" (
    start "" "%SystemRoot%\System32\conhost.exe" --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\start.ps1" -Hidden %*
    exit /b
)
set "SIMPLLM_BUILD=0"
for /f "tokens=2 delims=[]" %%v in ('ver') do set "SIMPLLM_VER=%%v"
for /f "tokens=4 delims=. " %%b in ("%SIMPLLM_VER%") do set "SIMPLLM_BUILD=%%b"
if %SIMPLLM_BUILD% GEQ 17763 if exist "%SystemRoot%\System32\conhost.exe" (
    start "" "%SystemRoot%\System32\conhost.exe" --headless powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0src\start.ps1" -Hidden %*
    exit /b
)
set "SIMPLLM_SCRIPT=%~dp0src\start.ps1"
set "SIMPLLM_ARGS=%*"
powershell -NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -Command "Start-Process powershell -WindowStyle Hidden -ArgumentList ('-NoProfile -ExecutionPolicy Bypass -File \"' + $env:SIMPLLM_SCRIPT + '\" -Hidden ' + $env:SIMPLLM_ARGS)"
