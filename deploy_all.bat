@echo off
setlocal enabledelayedexpansion

set "SCRIPT_DIR=%~dp0"
if "%SCRIPT_DIR:~-1%"=="\" set "SCRIPT_DIR=%SCRIPT_DIR:~0,-1%"

if "%~1"=="" (
    set "EXT_DIR=%SCRIPT_DIR%"
) else (
    set "EXT_DIR=%~1"
)

if "%~2"=="" (
    set "WORKSPACE_TO_OPEN=%SCRIPT_DIR%\tmp"
) else (
    set "WORKSPACE_TO_OPEN=%~2"
)

if not exist "%EXT_DIR%\package.json" (
    echo ERROR: package.json not found in extension directory:
    echo        %EXT_DIR%
    pause
    exit /b 1
)

set "CODE_CMD="
where code >nul 2>nul && set "CODE_CMD=code"
if not defined CODE_CMD (
    where code-insiders >nul 2>nul && set "CODE_CMD=code-insiders"
)
if not defined CODE_CMD (
    echo ERROR: VS Code CLI not found. Install "code" or "code-insiders" in PATH.
    pause
    exit /b 1
)

echo ============================================================
echo  Bormagi Extension — Build, Package and Install
echo ============================================================
echo.

:: ── 1. Install / refresh dependencies ──────────────────────────
echo [1/5] Installing npm dependencies...
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
echo [2/5] Compiling extension (webpack)...
call npm run compile
if errorlevel 1 (
    echo ERROR: Compilation failed. Fix errors above before packaging.
    pause
    exit /b 1
)
echo Done.
echo.

:: ── 3. Package with vsce ───────────────────────────────────────
echo [3/5] Packaging extension (.vsix)...
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
echo [4/5] Installing extension into VS Code...
call %CODE_CMD% --install-extension "%EXT_DIR%\%VSIX_FILE%" --force
if errorlevel 1 (
    echo ERROR: Installation failed. Make sure VS Code is in your PATH.
    echo        Run: %CODE_CMD% --install-extension "%EXT_DIR%\%VSIX_FILE%"
    pause
    exit /b 1
)

for /f "delims=" %%i in ('node -p "const p=require('./package.json'); (p.publisher + '.' + p.name).toLowerCase()"') do set "EXT_ID=%%i"
call %CODE_CMD% --list-extensions | findstr /i /x "%EXT_ID%" >nul
if errorlevel 1 (
    echo WARNING: Could not verify installed extension id: %EXT_ID%
) else (
    echo Installed extension id: %EXT_ID%
)

:: ── 5. Reset test workspace ──────────────────────────────────────
echo [5/5] Resetting test workspace: %WORKSPACE_TO_OPEN%
if exist "%WORKSPACE_TO_OPEN%" (
    rd /s /q "%WORKSPACE_TO_OPEN%"
)
mkdir "%WORKSPACE_TO_OPEN%"
echo Done.
echo.

echo ============================================================
echo  SUCCESS — Bormagi installed from %VSIX_FILE%
echo  Bormagi stays installed and enabled in normal VS Code sessions.
echo  Reload VS Code (Ctrl+Shift+P ^> Developer: Reload Window) if already open.
echo ============================================================
echo.
echo Opening test workspace: %WORKSPACE_TO_OPEN%
call %CODE_CMD% "%WORKSPACE_TO_OPEN%" >nul 2>nul
echo.
pause
