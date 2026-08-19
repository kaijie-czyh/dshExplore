## Summary

One or two sentences. Link the issue with `Closes #123` if applicable.

## What changed

- …
- …

## Checklist

- [ ] `npm run build` exits 0
- [ ] `npm test` exits 0
- [ ] New behavior is covered by a `node:test` case in `test/`
- [ ] Public event shapes in `src/core/events.ts` are unchanged, or the
      change is documented in `CHANGELOG.md`
- [ ] New CLI subcommands appear in `--help` and in `README.md`
- [ ] No new runtime dependencies, or a justification is in the PR body
- [ ] I have read `CONTRIBUTING.md`

## Risk

What could break? How did you test it?

## Security

If this PR touches anything that broadens the package's read/write
footprint (see `SECURITY.md`), call it out explicitly.