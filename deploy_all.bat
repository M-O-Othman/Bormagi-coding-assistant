@echo off
setlocal enabledelayedexpansion

set "EXT_DIR=C:\Users\mothm\Downloads\VS code Extension\bormagi-extension"

echo ============================================================
echo  Bormagi Extension — Build, Package and Install
echo ============================================================
echo.

:: ── 1. Install / refresh dependencies ──────────────────────────
echo [1/4] Installing npm dependencies...
cd /d "%EXT_DIR%"
call npm install
if errorlevel 1 (
    echo ERROR: npm install failed.
    pause
    exit /b 1
)
echo Done.
echo.

:: ── 2. Compile (webpack) ────────────────────────────────────────
echo [2/4] Compiling extension (webpack)...
call npm run compile
if errorlevel 1 (
    echo ERROR: Compilation failed. Fix errors above before packaging.
    pause
    exit /b 1
)
echo Done.
echo.

:: ── 3. Package with vsce ───────────────────────────────────────
echo [3/4] Packaging extension (.vsix)...
call npm run vsce:package
if errorlevel 1 (
    echo ERROR: vsce package failed.
    pause
    exit /b 1
)

:: Find the generated .vsix file
for /f "delims=" %%f in ('dir /b /o-d "%EXT_DIR%\*.vsix" 2^>nul') do (
    set "VSIX_FILE=%%f"
    goto :found_vsix
)
echo ERROR: No .vsix file found after packaging.
pause
exit /b 1

:found_vsix
echo Packaged: %VSIX_FILE%
echo.

:: ── 4. Install into VS Code ─────────────────────────────────────
echo [4/4] Installing extension into VS Code...
code --install-extension "%EXT_DIR%\%VSIX_FILE%" --force
if errorlevel 1 (
    echo ERROR: Installation failed. Make sure VS Code is in your PATH.
    echo        Run: code --install-extension "%EXT_DIR%\%VSIX_FILE%"
    pause
    exit /b 1
)

echo.
echo ============================================================
echo  SUCCESS — Bormagi installed from %VSIX_FILE%
echo  Reload VS Code (Ctrl+Shift+P -> Developer: Reload Window)
echo  to activate the updated extension.
echo ============================================================
echo.
pause
