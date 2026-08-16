@echo off
REM Starts the Foundry web dev server on http://localhost:3005

cd /d "%~dp0.."
yarn gulp
