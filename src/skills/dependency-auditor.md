## Skill: Dependency Auditor

### When to activate
When asked to audit, clean up, verify, or update project dependencies.

### Required tool sequence
1. grep_content — search for import statements (pattern: `^import|require\(`)
2. glob_files — locate package manifests (`**/package.json`, `**/pyproject.toml`, `**/go.mod`)
3. read_file_range — read only the dependencies sections of manifests (not whole files)
4. Cross-reference: identify imports not declared in manifest, or manifest entries not imported anywhere
5. Propose minimal removals or additions only
6. run_command — run `npm audit` or equivalent to check for vulnerabilities

### Constraints
- Do not modify manifests without a clear unused/missing dependency finding
- Do not run npm install without user approval
- Read only the relevant section of manifests — not the entire file
