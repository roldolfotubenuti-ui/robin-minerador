@echo off
setlocal
set "INSTALLED=%LOCALAPPDATA%\J-Dark\J-Dark Companion.exe"
if exist "%INSTALLED%" (
  start "" "%INSTALLED%"
) else (
  start "" "%~dp0J-Dark Companion.exe"
)
