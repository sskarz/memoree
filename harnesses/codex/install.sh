#!/bin/bash
# Memoree — Codex CLI plugin installer.
# This script now delegates to the unified `memoree` CLI, which handles
# Claude Code, Codex, and OpenClaw from a single entrypoint.
#
# Equivalent to: npx memoree@latest codex install

set -e
exec npx -y memoree@latest codex install
