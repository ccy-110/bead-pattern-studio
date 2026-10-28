@echo off
rem ---------------------------------------------------------------
rem  Bead Pattern Studio - launcher (frontend + backend)
rem  Double-click this file, then open http://localhost:5173/
rem
rem  Two windows will appear:
rem    - "bead-backend" : the API server (port 8787)
rem    - this window    : the site (Vite, port 5173)
rem
rem  KEEP BOTH WINDOWS OPEN while you use the site.
rem  Closing a window stops that part; the site still works
rem  without the backend (cloud save/share just become unavailable).
rem
rem  Note: the file content is ASCII on purpose - cmd.exe renders
rem  UTF-8 Chinese as mojibake unless the codepage is changed.
rem ---------------------------------------------------------------

setlocal
set "PATH=C:\Program Files\nodejs;%PATH%"
cd /d "%~dp0"

echo.
echo   Starting the backend (a second window will open)...
rem PATH and the working directory are inherited from this window, so no quoting needed
start "bead-backend" cmd /k npm run server

echo   Starting the site...
echo   Then open:  http://localhost:5173/
echo.
echo   Keep both windows open while using the site.
echo.

call npm run dev

echo.
echo   The site has stopped. Press any key to close this window.
echo   (The backend window stays open - close it separately.)
pause >nul
