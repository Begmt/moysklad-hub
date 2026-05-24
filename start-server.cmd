@echo off
cd /d "%~dp0"
node dist\app.js 1>server.out.log 2>server.err.log
