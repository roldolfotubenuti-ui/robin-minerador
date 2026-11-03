@echo off
setlocal
title Instalador Robin Companion - Windows 64 bits
set "DEST=%LOCALAPPDATA%\Robin"

echo.
echo =============================================
echo   ROBIN COMPANION 1.0 - INSTALADOR WINDOWS
echo =============================================
echo.
echo Instalando o Robin Companion em:
echo %DEST%
echo.

:: Fecha instancias antigas se houver
taskkill /IM "J-Dark Companion.exe" /F >nul 2>&1
taskkill /IM "Robin Companion.exe" /F >nul 2>&1

if not exist "%DEST%" mkdir "%DEST%"
if not exist "%DEST%\resources" mkdir "%DEST%\resources"
copy /Y "%~dp0Robin Companion.exe" "%DEST%\Robin Companion.exe" >nul
if exist "%~dp0resources" xcopy /E /I /Y "%~dp0resources" "%DEST%\resources" >nul

if not exist "%DEST%\Robin Companion.exe" goto :error
start "" "%DEST%\Robin Companion.exe" --enable-autostart

echo Instalacao concluida com sucesso!
echo O Robin Companion ja esta rodando em 127.0.0.1:17832 e iniciara com o Windows.
echo Agora carregue a pasta EXTENSAO-ROBIN no Chrome ou Edge.
echo.
pause
exit /b 0

:error
echo.
echo Nao foi possivel concluir a instalacao.
echo.
pause
exit /b 1

