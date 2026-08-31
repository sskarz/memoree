## Summary

<!-- What does this PR do? -->

## Version Bump

> **To trigger a release**, bump `"version"` in `package.json` before merging.
>
> | Change type     | Version bump          | Example              |
> | --------------- | --------------------- | -------------------- |
> | Bug fix         | patch (1.2.0 → 1.2.1) | `"version": "1.2.1"` |
> | New feature     | minor (1.2.0 → 1.3.0) | `"version": "1.3.0"` |
> | Breaking change | major (1.2.0 → 2.0.0) | `"version": "2.0.0"` |
>
> If you don't bump the version, no release will be created.

## Test plan

Follow `AGENTS.md` (PR verification loop) and `docs/TESTING.md`.

- [ ] `npm run verify` (every PR)
- [ ] Runtime-affecting: `npm run build`, `npm test`, `git diff --check`
- [ ] Live, when keys exist: `npm run runtime:validate` (and `npm run live:e2e` for unaided hooks)
- [ ] Isolated DBs only; no writes to the operator `~/.memoree`
- [ ] If Codex or Claude live was skipped, say so — do not mark it passed
- [ ] Relevant new tests added
- [ ] Version bumped in `package.json`, or no release needed for this change
