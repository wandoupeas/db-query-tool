@echo off
REM Clear environment variables that interfere with Electron
set ELECTRON_RUN_AS_NODE=
set NODE_OPTIONS=
start "" "%~dp0node_modules\electron\dist\electron.exe" "%~dp0."
