#!/usr/bin/env node

import { rmSync } from "node:fs";

for (const path of [
  "dist",
  "bundle",
  "harnesses/claude-code/bundle",
  "harnesses/codex/bundle",
  "harnesses/cursor/bundle",
  "harnesses/hermes/bundle",
  "harnesses/pi/bundle",
  "harnesses/openclaw/dist",
  "mcp/bundle",
]) {
  rmSync(path, { recursive: true, force: true });
}
