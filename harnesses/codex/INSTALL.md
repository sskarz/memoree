# Installing Memoree for Codex

From any directory:

```sh
npx -y memoree install
```

The installer detects `~/.codex`, copies hook bundles to
`~/.codex/memoree/`, merges Memoree entries into `~/.codex/hooks.json`,
and links the Memoree skill into `~/.agents/skills/`. It preserves
unrelated user hooks and configuration and is safe to rerun after an
update.

Restart Codex, then open `/hooks` and trust Memoree. Codex skips
plugin-bundled hooks until that review happens.

`npx memoree codex install` wires Codex only, after a prior `install` has
initialized storage. Remove the integration with:

```sh
npx memoree codex uninstall
```

For repository development, do not `npm link` the development checkout.
Use the isolated runtime workflow in the root README instead.
