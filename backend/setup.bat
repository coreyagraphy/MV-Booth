@echo off
rem One-time setup for the MV Booth tuning backend (Python 3.10-3.12 recommended).
cd /d "%~dp0"
rem Prefer a Python that has prebuilt pyworld wheels; the newest one may need a C++ compiler.
set "PY="
for %%V in (3.12 3.11 3.10) do if not defined PY py -%%V -c "" >nul 2>nul && set "PY=py -%%V"
if not defined PY where py >nul 2>nul && set "PY=py -3"
if not defined PY where python >nul 2>nul && set "PY=python"
if not defined PY goto nopython
echo Using %PY%
if not exist .venv\Scripts\python.exe %PY% -m venv .venv
if not exist .venv\Scripts\python.exe goto nopython
.venv\Scripts\python -m pip install --upgrade pip
rem CPU-only torch keeps the download small; no GPU needed for offline tuning.
.venv\Scripts\python -m pip install torch --index-url https://download.pytorch.org/whl/cpu
if errorlevel 1 goto failed
.venv\Scripts\python -m pip install -r requirements.txt
if errorlevel 1 goto pyworld
.venv\Scripts\python -c "import torchcrepe, pyworld, torch; print('Backend ready.')"
if errorlevel 1 goto failed
pause
exit /b 0

:nopython
echo Python not found. Install Python 3.11 from https://www.python.org/downloads/ (tick "Add to PATH"), then run this again.
pause
exit /b 1

:pyworld
echo.
echo pyworld failed to build. Fix: install "Desktop development with C++" from
echo https://visualstudio.microsoft.com/visual-cpp-build-tools/ and run setup.bat again,
echo or use conda:  conda install -c conda-forge pyworld
pause
exit /b 1

:failed
echo.
echo Setup failed (see the messages above). Check your internet connection and run setup.bat again.
pause
exit /b 1
