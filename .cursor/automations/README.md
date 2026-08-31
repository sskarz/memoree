# Cursor PR automations

Cursor has no public API to create dashboard Automations. This repo launches the two PR agents with GitHub Actions → [Cloud Agents API](https://cursor.com/docs/cloud-agent/api/endpoints).

| Agent | Prompt | When |
|---|---|---|
| PR test (verify, build, test, e2e when keys exist) | `pr-test.md` | PR opened, ready, or pushed |
| PR review | `pr-review.md` | same |

Fork PRs are skipped. Each launch comments the cloud agent URL on the PR.

## Activate

1. Connect GitHub for this repo in the [Cursor dashboard](https://cursor.com/dashboard) (Integrations).
2. Create an API key at [Cursor Dashboard → API Keys](https://cursor.com/dashboard).
3. Add a repository secret named `CURSOR_API_KEY` (Settings → Secrets and variables → Actions).
4. Optional live e2e: give the Cloud Agent environment authenticated `claude` / `codex` CLIs and isolated `MEMOREE_*` paths. Without those, the test agent still runs `npm run verify` / `npm test` and reports `LIVE_SKIPPED`.

Do **not** also create the same two workflows at [cursor.com/automations](https://cursor.com/automations) or every PR will get duplicate agents. If you prefer dashboard Automations, disable `.github/workflows/cursor-pr-agents.yml` and paste `pr-test.md` / `pr-review.md` there (triggers: PR opened, Draft opened, PR pushed; tool: Comment on pull request).

Bugbot is separate. Enable it in Automations if you want Cursor’s built-in reviewer; it reads `.cursor/BUGBOT.md`.
