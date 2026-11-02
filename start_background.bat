@echo off
rem Clock Player: start the local server without a window (stop it with stop_background.bat)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1" -Background
if errorlevel 1 (pause) else (timeout /t 10)
