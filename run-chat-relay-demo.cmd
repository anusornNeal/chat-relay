@echo off
setlocal
title Chat Relay - TUI Demo (Offline)
cd /d "%~dp0"

where node >nul 2>&1
if errorlevel 1 (
    echo Node.js is not available in PATH.
    pause
    exit /b 1
)

if not exist "bin\chat-relay.js" (
    echo Chat Relay source entrypoint was not found.
    pause
    exit /b 1
)

rem Offline preview: does not start the local agent or connect to Relay.
node "bin\chat-relay.js" demo
set "exitCode=%ERRORLEVEL%"
if not "%exitCode%"=="0" (
    echo TUI Demo exited with code %exitCode%.
    pause
)
exit /b %exitCode%
