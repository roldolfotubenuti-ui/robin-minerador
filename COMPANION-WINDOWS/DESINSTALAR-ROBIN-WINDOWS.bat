@echo off
setlocal
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v RobinCompanion /f >nul 2>&1
reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v JDarkCompanion /f >nul 2>&1
taskkill /IM "Robin Companion.exe" /F >nul 2>&1
taskkill /IM "J-Dark Companion.exe" /F >nul 2>&1
set "DEST=%LOCALAPPDATA%\Robin"
if exist "%DEST%" rmdir /S /Q "%DEST%"
set "OLDDEST=%LOCALAPPDATA%\J-Dark"
if exist "%OLDDEST%" rmdir /S /Q "%OLDDEST%"
echo Robin Companion removido do Windows.
pause

