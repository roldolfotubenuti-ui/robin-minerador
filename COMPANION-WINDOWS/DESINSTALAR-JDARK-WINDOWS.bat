@echo off
setlocal
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v JDarkCompanion /f >nul 2>&1
taskkill /IM "J-Dark Companion.exe" /F >nul 2>&1
set "DEST=%LOCALAPPDATA%\J-Dark"
if exist "%DEST%" rmdir /S /Q "%DEST%"
echo J-Dark Companion removido do Windows.
pause
