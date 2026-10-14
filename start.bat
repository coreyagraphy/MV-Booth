@echo off
cd /d "%~dp0"
set AUTO_EXIT=0
node serve.mjs
pause
