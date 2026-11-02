@echo off
rem Clock Player: start the local server without a window (stop it with stop_background.bat)
start "" powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "%~dp0server.ps1" -Background
