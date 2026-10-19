@echo off
setlocal
title Anisong Dungeon
cd /d "%~dp0"

rem Update check. Kept on ONE line: an update may rewrite this file, and cmd reads it line by
rem line, so the restart must already be parsed. Exit code 10 = files updated -> relaunch.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\update.ps1" & if errorlevel 10 (start "" "%~f0" & exit /b)

cls
echo.
echo   ==================================================
echo      A N I S O N G   D U N G E O N
echo   ==================================================
echo.
echo     [1] Host a game   - your PC runs the server
echo     [2] Join a game   - enter a friend's room code
echo     [Q] Quit
echo.
choice /c 12Q /n /m "  Select an option: "
if errorlevel 3 goto :eof
if errorlevel 2 (set "MODE=join") else (set "MODE=host")

echo.
echo   Starting... your browser will open in a moment.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0launcher\serve.ps1" -Mode %MODE%

echo.
echo   The launcher stopped.
pause
