@echo off
rem One-time setup for the MV Booth tuning backend (Python 3.10-3.12 recommended).
cd /d "%~dp0"
where py >nul 2>nul && (py -3 -m venv .venv) || (python -m venv .venv)
if not exist .venv\Scripts\python.exe (
  echo Python not found. Install Python 3.11 from https://www.python.org/downloads/ ^(tick "Add to PATH"^), then run this again.
  pause ^& exit /b 1
)
.venv\Scripts\python -m pip install --upgrade pip
rem CPU-only torch keeps the download small; no GPU needed for offline tuning.
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
.venv\Scripts\python -m pip install -r requirements.txt
if errorlevel 1 (
  echo.
  echo pyworld failed to build. Fix: install "Desktop development with C++" from
  echo https://visualstudio.microsoft.com/visual-cpp-build-tools/ and run setup.bat again,
  echo or use conda:  conda install -c conda-forge pyworld
  pause ^& exit /b 1
)
.venv\Scripts\python -c "import torchcrepe, pyworld, torch; print('Backend ready.')"
pause
