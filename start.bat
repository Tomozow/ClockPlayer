@echo off
rem Clock Player: start the local server in this window (close the window to stop)
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0server.ps1"
if errorlevel 1 pause
