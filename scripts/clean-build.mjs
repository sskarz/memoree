#!/usr/bin/env node

import { rmSync } from "node:fs";

for (const path of [
  "dist",
  "bundle",
  "harnesses/claude-code/bundle",
  "harnesses/codex/bundle",
  "harnesses/antigravity/bundle",
]) {
  rmSync(path, { recursive: true, force: true });
}
