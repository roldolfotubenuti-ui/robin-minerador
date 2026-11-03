@echo off
setlocal
set "INSTALLED=%LOCALAPPDATA%\Robin\Robin Companion.exe"
if exist "%INSTALLED%" (
  start "" "%INSTALLED%"
) else (
  start "" "%~dp0Robin Companion.exe"
)

