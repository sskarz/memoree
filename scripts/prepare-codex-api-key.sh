#!/usr/bin/env bash
# Per-boot Codex API-key auth for Cloud Agent / live VMs.
#
# `codex exec` does not read OPENAI_API_KEY. It needs either:
#   - CODEX_API_KEY on the process, or
#   - ~/.codex/auth.json from `printenv OPENAI_API_KEY | codex login --with-api-key`
#
# This script copies OPENAI_API_KEY into CODEX_API_KEY, writes the chmod-600
# live env file, and persists a Codex login. It never prints key material.
set -euo pipefail

export PATH="${HOME}/.npm-global/bin:${PATH}"

if [ -z "${CODEX_API_KEY:-}" ] && [ -n "${OPENAI_API_KEY:-}" ]; then
  export CODEX_API_KEY="${OPENAI_API_KEY}"
fi

if [ -z "${CODEX_API_KEY:-}" ] && [ -z "${OPENAI_API_KEY:-}" ]; then
  echo "prepare-codex-api-key: no OPENAI_API_KEY or CODEX_API_KEY; skipping"
  exit 0
fi

python3 - <<'PY'
import os
import shlex
from pathlib import Path

home = Path(os.environ["HOME"])
config_dir = home / ".config"
config_dir.mkdir(parents=True, exist_ok=True)
path = config_dir / "memoree-live.env"

existing: dict[str, str] = {}
if path.exists():
    for raw in path.read_text(encoding="utf-8").splitlines():
        line = raw.strip()
        if not line.startswith("export ") or "=" not in line:
            continue
        name, value = line[len("export "):].split("=", 1)
        existing[name] = value.strip().strip("'\"")

def env_or_existing(name: str) -> str:
    return (os.environ.get(name) or existing.get(name) or "").strip()

openai = env_or_existing("OPENAI_API_KEY")
codex = env_or_existing("CODEX_API_KEY") or openai
anthropic = env_or_existing("ANTHROPIC_API_KEY")

lines: list[str] = []
for name, value in (
    ("ANTHROPIC_API_KEY", anthropic),
    ("OPENAI_API_KEY", openai),
    ("CODEX_API_KEY", codex),
):
    if value:
        lines.append(f"export {name}={shlex.quote(value)}")

path.write_text("\n".join(lines) + "\n", encoding="utf-8")
path.chmod(0o600)
print("prepare-codex-api-key: wrote ~/.config/memoree-live.env")
PY

if [ "${MEMOREE_SKIP_CODEX_LOGIN:-}" = "1" ]; then
  echo "prepare-codex-api-key: skipped Codex login"
  exit 0
fi

if ! command -v codex >/dev/null 2>&1; then
  echo "prepare-codex-api-key: codex not on PATH; wrote live env only"
  exit 0
fi

printenv CODEX_API_KEY | codex login --with-api-key
echo "prepare-codex-api-key: Codex API-key login complete"
