## Summary

<!-- What does this PR do? -->

## Version Bump

Do not bump `"version"` in PRs. Merges to `main` that contain `feat` / `fix` /
`perf` commits are published automatically by `.github/workflows/publish.yml`
(`npx -y @sskarz/memoree` tracks that npm release). Docs-only merges do not
publish.

Users upgrade with:

```sh
npx -y @sskarz/memoree install
```

## Test plan

Follow `AGENTS.md` (PR verification loop) and `docs/TESTING.md`.

- [ ] `npm run verify` (every PR)
- [ ] Runtime-affecting: `npm run build`, `npm test`, `git diff --check`
- [ ] Live, when keys exist: `npm run runtime:validate` (and `npm run live:e2e` for unaided hooks)
- [ ] Isolated DBs only; no writes to the operator `~/.memoree`
- [ ] If Codex, Claude, or Antigravity live was skipped, say so — do not mark it passed
- [ ] Relevant new tests added
- [ ] Version left unchanged (publish happens on merge to `main`, not in the PR)
