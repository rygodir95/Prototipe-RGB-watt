@echo off
rem RGB Watt Controller - PC simulator launcher (Windows)
rem Starts the simulator; the existing web GUI then opens in your browser.
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (
  py -3 simulator.py %*
) else (
  python simulator.py %*
)
if errorlevel 1 pause