# Embeddings (semantic search)

Memoree runs a local embedding daemon (nomic-embed-text-v1.5, ~130 MB) so
semantic recall can rank captured sessions and summaries. Embeddings are **on
by default**. The daemon depends on `@huggingface/transformers`, which pulls
onnxruntime-node and sharp (~600 MB total with native binaries). Those
dependencies are installed once into `~/.memoree/embed-deps/` and shared by
Claude Code, Codex, and Antigravity.

## Install

`memoree install` enables embeddings and preloads the default model unless you
opt out:

```bash
memoree install --no-embeddings    # lexical-only retrieval
memoree embeddings install         # add embeddings later
```

`memoree embeddings install` installs `@huggingface/transformers` **once** into
`~/.memoree/embed-deps/` and symlinks every detected agent integration to it.
Re-run the same command after installing a new agent and the new symlink is
added (the npm install is skipped because it is cached).

The nomic model is downloaded on first use and cached under
`~/.memoree/models/` (Hugging Face may also write `~/.cache/huggingface/`).

## Other commands

```bash
memoree embeddings status              # show shared deps + per-agent state
memoree embeddings enable|disable
memoree embeddings uninstall           # remove the per-agent symlinks
memoree embeddings uninstall --prune   # also delete the shared dir (~600 MB)
```

Restart your agents after enabling. From the next session, captured messages
and AI-generated summaries include a 768-dim embedding, and semantic recall
queries route through the local daemon.

## Lexical-only fallback

If `@huggingface/transformers` is **not** present, or embeddings are disabled,
Memoree degrades to lexical-only mode:

- Capture continues; rows still land in Memoree.
- `Grep` still works via BM25 / `ILIKE` matching on text columns.
- The `message_embedding` / `summary_embedding` columns stay `NULL`.
- The hook log notes `embeddings: no-transformers` once at session start.

Force lexical-only mode with `MEMOREE_EMBEDDINGS=false` (useful for CI or
air-gapped environments).
