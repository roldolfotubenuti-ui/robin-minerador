@echo off
setlocal
title Instalador J-Dark Companion - Windows 64 bits
set "DEST=%LOCALAPPDATA%\J-Dark"

echo.
echo =============================================
echo   J-DARK COMPANION 1.0 - INSTALADOR WINDOWS
echo =============================================
echo.
echo Instalando o J-Dark Companion em:
echo %DEST%
echo.

if not exist "%DEST%" mkdir "%DEST%"
if not exist "%DEST%\resources" mkdir "%DEST%\resources"
copy /Y "%~dp0J-Dark Companion.exe" "%DEST%\J-Dark Companion.exe" >nul
if exist "%~dp0resources" xcopy /E /I /Y "%~dp0resources" "%DEST%\resources" >nul

if not exist "%DEST%\J-Dark Companion.exe" goto :error
start "" "%DEST%\J-Dark Companion.exe" --enable-autostart

echo Instalacao concluida com sucesso!
echo O J-Dark Companion ja esta rodando em 127.0.0.1:17832 e iniciara com o Windows.
echo Agora carregue a pasta EXTENSAO-JDARK no Chrome ou Edge.
echo.
pause
exit /b 0

:error
echo.
echo Nao foi possivel concluir a instalacao.
echo.
pause
exit /b 1
