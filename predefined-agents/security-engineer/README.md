# Security Engineer Agent

## What It Does

The Security Engineer agent specialises in application security. Use it to identify vulnerabilities in your codebase, produce structured security reviews, build threat models, audit dependencies for CVEs, and obtain concrete remediation code for every finding.

## When to Use It

- Before merging a significant PR — ask for a security review of the changed files
- When designing a new authentication or authorisation flow
- To audit dependencies: `@security-engineer audit my package.json for CVEs`
- To produce an OWASP-mapped security checklist for the project
- When handling user-uploaded files, external API calls, or payment flows
- To review JWT/session management, password hashing, or cryptographic usage

## Example Prompts

```
@security-engineer Review src/auth/login.ts for OWASP A07 vulnerabilities.

@security-engineer Build a STRIDE threat model for the document upload flow.

@security-engineer Audit package.json and flag any dependencies with known CVEs.

@security-engineer Is this SQL query safe from injection? [paste code]
```

## Artefacts It Produces

- Security review reports with CWE classification and severity
- STRIDE threat models
- OWASP Top 10 checklists
- Dependency CVE reports with fixed versions
- Remediation code for every finding

## Provider Recommendation

Anthropic Claude (Sonnet or Opus) — strong reasoning across both code analysis and structured report generation.
