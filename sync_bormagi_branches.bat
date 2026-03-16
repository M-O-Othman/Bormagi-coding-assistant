@echo off
setlocal enabledelayedexpansion

REM ======= CONFIG =======
set REPO_DIR=%~dp0
set REMOTE_URL=https://github.com/M-O-Othman/Bormagi-coding-assistant.git
REM ======================

echo.
echo [1/7] Moving to repo folder...
cd /d "%REPO_DIR%"
if errorlevel 1 (
  echo ERROR: Could not access repo folder: %REPO_DIR%
  exit /b 1
)

echo.
echo [2/7] Verifying this is a git repo...
git rev-parse --is-inside-work-tree >nul 2>&1
if errorlevel 1 (
  echo ERROR: This folder is not a git repository.
  exit /b 1
)

echo.
echo [3/7] Configure credential helper (Git Credential Manager)...
git config --global credential.helper manager-core
if errorlevel 1 (
  echo WARNING: manager-core not available, falling back to 'store'
  git config --global credential.helper store
)

echo.
echo [4/7] Set remote URL...
git remote set-url origin %REMOTE_URL%
if errorlevel 1 (
  echo ERROR: Failed to set remote URL.
  exit /b 1
)

echo.
echo [5/7] Fetch latest from origin...
git fetch origin --prune
if errorlevel 1 (
  echo ERROR: Fetch failed. You may be prompted for GitHub username/PAT.
  exit /b 1
)

echo.
echo [6/7] Update local new_features from origin/new_features...
git checkout new_features
if errorlevel 1 (
  echo ERROR: Branch 'new_features' not found locally.
  exit /b 1
)
git reset --hard origin/new_features
if errorlevel 1 (
  echo ERROR: Could not reset new_features to origin/new_features.
  exit /b 1
)

echo.
echo [7/7] Update local master from origin/master...
git checkout master
if errorlevel 1 (
  echo ERROR: Branch 'master' not found locally.
  exit /b 1
)
git reset --hard origin/master
if errorlevel 1 (
  echo ERROR: Could not reset master to origin/master.
  exit /b 1
)

echo.
echo ===== Local sync complete =====
echo Current heads:
git log --oneline -n 1 new_features
git log --oneline -n 1 master

echo.
choice /m "Do you also want to push local new_features and master to origin now"
if errorlevel 2 goto end

echo.
echo Pushing new_features...
git checkout new_features
git push origin new_features
if errorlevel 1 (
  echo ERROR: Push new_features failed.
  goto end
)

echo.
echo Pushing master...
git checkout master
git push origin master
if errorlevel 1 (
  echo ERROR: Push master failed.
  goto end
)

echo.
echo Push complete for both branches.

:end
echo.
echo Done.
exit /b 0