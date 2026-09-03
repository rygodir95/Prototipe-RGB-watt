@echo off
rem Runs the PC simulator regression tests (Power + Heart Rate modes).
rem Usage: double-click or run from tools/pc-simulator/
cd /d "%~dp0"
where python >nul 2>nul
if errorlevel 1 (
  echo Python 3.8+ is required but was not found on PATH.
  pause
  exit /b 1
)
python -m unittest discover -s tests -v
echo.
pause