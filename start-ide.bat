@echo off
title Claude Code IDE

:: Check for admin rights
net session >nul 2>&1
if %errorlevel% neq 0 (
    echo Requesting admin privileges...
    powershell -Command "Start-Process -Verb RunAs -FilePath '%~f0'"
    exit /b
)

cd /d "%~dp0"
call .venv\Scripts\activate
start "" http://localhost:5050
python app.py
