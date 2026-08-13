# Installing Memoree for Codex

Build Memoree from a source checkout, then install the Codex integration:

```sh
npm ci
npm run build
npm link
memoree codex install
```

The installer enables Codex hooks, merges Memoree entries into
`~/.codex/hooks.json`, copies the runtime bundle to `~/.codex/memoree/`, and
links the Memoree skill into `~/.agents/skills/`. It preserves unrelated user
hooks and configuration and is safe to rerun after an update.

For repository development, do not link the development checkout. Use the
isolated runtime workflow in the root README instead.

Restart Codex after installation. Remove the integration with:

```sh
memoree codex uninstall
```
