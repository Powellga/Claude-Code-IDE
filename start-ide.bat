@echo off
title Claude Code IDE
cd /d "%~dp0"
call .venv\Scripts\activate
start "" http://localhost:5050
python app.py
