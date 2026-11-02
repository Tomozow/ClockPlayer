@echo off
rem Clock Player: stop the local server started by start_background.bat
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Stop
timeout /t 3 >nul
