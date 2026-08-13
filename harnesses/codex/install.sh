#!/bin/bash
# Memoree — Codex CLI plugin installer.
# This script delegates to the source-built Memoree CLI.

set -e
repo_dir="$(cd "$(dirname "$0")/../.." && pwd)"
exec node "$repo_dir/bundle/cli.js" codex install
