#!/bin/sh
set -eu

status=0

check_file() {
  if [ -e "$1" ]; then
    printf 'ok  %s\n' "$1"
  else
    printf 'FAIL  %s\n' "$1" >&2
    status=1
  fi
}

printf '%s\n' 'Memoree supported integration check'
memoree doctor || status=1

if [ -d "$HOME/.codex" ]; then
  check_file "$HOME/.codex/hooks.json"
  check_file "$HOME/.codex/memoree/bundle/session-start.js"
  check_file "$HOME/.codex/memoree/bundle/capture.js"
  check_file "$HOME/.agents/skills/memoree-memory"
fi

exit "$status"
