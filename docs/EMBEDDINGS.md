# Embeddings (semantic search)

Memoree runs a local embedding daemon (nomic-embed-text-v1.5, ~130 MB) so recall can use hybrid semantic and lexical ranking instead of lexical matching alone. Embeddings are **on by default**. The daemon depends on `@huggingface/transformers`, which pulls native runtime dependencies; Memoree installs those once under `~/.memoree/embed-deps/` so every supported agent can share them.

## Install

```bash
memoree install
```

The default installer provisions `@huggingface/transformers` once in the shared directory, downloads the model on first setup, and enables embeddings. Re-running the command reuses the installed dependencies and cached model.

To repair or reprovision the shared runtime without repeating the rest of onboarding:

```bash
memoree embeddings install
```

## Other commands

```bash
memoree embeddings disable             # use lexical retrieval only
memoree embeddings enable              # re-enable the installed runtime
memoree embeddings status              # show shared deps + per-agent state
memoree embeddings uninstall           # remove the per-agent symlinks
memoree embeddings uninstall --prune   # also delete the shared dir (~600 MB)
```

Restart your agents after enabling. From the next session, captured messages and AI-generated summaries will include a 768-dim embedding, and semantic recall queries will route through the local daemon. The model is cached under `~/.memoree/models/`.

## Lexical-only fallback

To choose lexical-only retrieval during initial setup:

```bash
memoree install --no-embeddings
```

If `@huggingface/transformers` is unavailable, Memoree degrades to lexical-only mode:

- ✅ Capture continues; rows still land in Memoree.
- ✅ `Grep` still works via BM25 / `ILIKE` matching on text columns.
- ⚪ The `message_embedding` / `summary_embedding` columns stay `NULL`.
- ⚪ The hook log notes `embeddings: no-transformers` once at session start.

Use `memoree embeddings disable` to switch an existing installation to lexical-only retrieval. Run `memoree embeddings enable` and restart the agent to turn semantic retrieval back on.
