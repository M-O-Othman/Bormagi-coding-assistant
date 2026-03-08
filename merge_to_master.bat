@echo off
setlocal

set BRANCH=claude/plan-context-token-enhancements-fKSEL

git checkout master
git fetch origin master
git reset --hard origin/master
git merge --no-ff "%BRANCH%" -m "merge(context-pipeline): Phases 1-4 token budget, repo map, retrieval, prompt assembly, memory and compaction"
git push origin master

endlocal
