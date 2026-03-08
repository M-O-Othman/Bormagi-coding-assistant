@echo on
setlocal

git checkout master
if errorlevel 1 goto :stop

git fetch origin
if errorlevel 1 goto :stop

git reset --hard origin/master
if errorlevel 1 goto :stop

git merge --no-ff origin/claude/plan-context-token-enhancements-fKSEL -m "merge(context-pipeline): Phases 1-6 ball done"
if errorlevel 1 goto :stop

git push origin master
if errorlevel 1 goto :stop

echo.
echo DONE
goto :hold

:stop
echo.
echo FAILED with errorlevel %errorlevel%

:hold
pause
cmd /k