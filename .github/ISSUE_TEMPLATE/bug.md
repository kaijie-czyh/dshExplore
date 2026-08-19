---
name: Bug report
about: Report incorrect behavior, a crash, or a regression
labels: bug
---

## Summary

One or two sentences describing the defect.

## Environment

- `dsh-trajectory` version (from `node dist/cli/index.js --version`):
- Node.js version (`node --version`):
- OS:
- DeepSeek Harness version (`npx @deepseek-ai/dsh --version`, if applicable):
- Were you using the CLI, the Cordis plugin, or both?

## Reproduction steps

1. …
2. …
3. …

## Expected behavior

What you expected to happen.

## Actual behavior

What actually happened. Include the relevant terminal output and (if safe to
share) a snippet of the offending `dsh-trajectory.db` row.

## Severity

- [ ] Data loss / corruption
- [ ] Crash / unrecoverable error
- [ ] Wrong output but no crash
- [ ] Cosmetic / docs

## Security

If this bug exposes data, allows arbitrary code execution, or breaks the
read-only contract documented in `SECURITY.md`, **stop and follow
`SECURITY.md` instead of filing a public issue**.