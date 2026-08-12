# Installing Memoree for Codex CLI

The fastest path installs memoree into every AI coding assistant on your machine (Claude Code, Codex, OpenClaw) with one command:

```bash
npx memoree@latest install
```

Or install for Codex only:

```bash
npx memoree@latest codex install
```

The installer:

- Enables the `hooks` feature flag (and strips the legacy `codex_hooks` key, if a previous install added it)
- Writes `~/.codex/hooks.json` with memoree entries
- Copies the plugin bundle to `~/.codex/memoree/`
- Symlinks the skill into `~/.agents/skills/memoree-memory`
- Opens a browser once for login (shared across all assistants)

Restart Codex (quit and relaunch the CLI) to activate.

## Prerequisites

- Node.js >= 22
- [Codex CLI](https://github.com/openai/codex) installed

## Verify

```bash
cat ~/.codex/hooks.json | head -3
ls -la ~/.agents/skills/memoree-memory
ls ~/.codex/memoree/bundle/
```

## Updating

```bash
npx memoree@latest codex install
```

Re-running is idempotent — hooks and skills get replaced in place.

## Uninstalling

```bash
npx memoree@latest codex uninstall
```

Removes `~/.codex/hooks.json` and the skill symlink. Plugin files remain at `~/.codex/memoree/` so a reinstall is cheap; delete the directory manually if you want a full cleanup.
