# How to test Memoree

Testing and installing are different jobs. Tests never change what your everyday
Claude Code or Codex is running. Installing (`runtime:promote`) does.

Tests use throwaway folders and a fake home directory. They must not write into
the real `~/.memoree` database.

## Two files for this feature

**Product (no Claude, no Codex)** — does graph search and skill cleanup work?

```sh
npx vitest run tests/shared/graph-query-and-hygiene.test.ts
```

Calls the virtual filesystem and hygiene functions directly. Example: `query/store`
should find `persistGraph` even though that word is not in the name; `find/store`
should not. Hygiene dry-run must not delete files.

**Wiring (Claude Code and Codex hooks)** — does the app actually reach that code?

```sh
npx vitest run tests/shared/harness-wiring.test.ts
```

Only checks routing: `cat` / Read / `ls` hit the graph mount. It does not re-prove
ranking.

You can run both from any session. You do not need to close Claude or Codex.
That does **not** mean your daily apps already load this code.

## 1. Everyday (every change, every PR)

```sh
npm run verify
```

That type-checks, checks the runtime-validator script, and runs source tests —
including the two files above. No rebuild, no install.

Put agent-independent tests under `tests/shared/`. Inject filesystem, time, and
embedder fakes. Never call the real embedding daemon or the real home directory.

## 2. Bigger PRs (still no install)

```sh
npm run build
npm test
git diff --check
```

## 3. Install onto your laptop (rare, you type this)

Only after the tests above are green, and only when you want daily Claude Code
and Codex to load this commit.

1. Commit the work. Note the SHA (`git rev-parse HEAD`).
2. Close every interactive Claude Code and Codex session. Idle Cursor is fine.
3. Promote that SHA, then run the live check:

```sh
npm run runtime:promote -- <commit-sha>
npm run runtime:validate
```

`runtime:validate` talks to the real `claude` and `codex` CLIs, but still uses
a disposable database and home. It proves capture, summaries, embeddings,
recall, structured VFS, and the graph `query/` vs `find/` walkthrough through
the installed hook bundles.

To run everything except live `codex exec` (for example when Codex API credits
are unavailable):

```sh
npm run runtime:validate -- --skip-live-codex
```

If validate fails, fix it in the development checkout, commit, promote the new
SHA, and validate again. Do not run promote or validate from an agent session
or from unattended PR automation.

Roll back with `npm run runtime:rollback`.

## Adding a new agent later

Do not start with Docker. Add a few cases to `tests/shared/harness-wiring.test.ts`
(or a sibling file if that file gets crowded), plus product coverage in
`tests/shared/graph-query-and-hygiene.test.ts` when the feature is not harness-specific.
Then step 3 when you are ready for daily use.
