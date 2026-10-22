@echo off
echo Updating BGM playlist...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0update_bgm.ps1"
echo Done.
pause
