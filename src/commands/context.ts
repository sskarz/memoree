#!/usr/bin/env node

/**
 * CLI surface for `memoree context`.
 *
 * Prints the same rules + open-goals + HOW-TO block that the
 * SessionStart forks inject into agent context. Two consumers:
 *
 *   1. Any agent or human debugging the inject — `memoree context`
 *      is a read-only diagnostic that surfaces what the renderer
 *      would produce right now without firing SessionStart.
 *
 * The CLI is thin: load config → construct the storage backend → call
 * renderContextBlock → print. No flags in v1 (the renderer's
 * maxRules / maxGoals defaults of 10 are the v1 contract).
 */

import { loadRoutedConfig } from "../dir-config.js";
import { createStorageBackend } from "../storage/factory.js";
import { renderContextBlock } from "../hooks/shared/context-renderer.js";

const USAGE = `
memoree context — print the rules + open-goals block on demand

Usage:
  memoree context

Same output that SessionStart auto-injects for Claude Code and Codex:
active rules plus the current user's open goals. This is a read-only
diagnostic that shows what the renderer would produce right now.
`.trim();

export async function runContextCommand(args: string[]): Promise<void> {
  if (args[0] === "--help" || args[0] === "-h" || args[0] === "help") {
    console.log(USAGE);
    return;
  }

  const cfg = loadRoutedConfig();
  if (!cfg) {
    console.error("Memoree storage is unavailable. Run `memoree doctor`.");
    process.exit(2);
    throw new Error("unreachable");
  }

  const api = createStorageBackend(cfg, cfg.tableName);

  const known = await api.knownTablesOrNull();
  const tableExists = known ? (name: string) => known.includes(name) : undefined;
  const block = await renderContextBlock(
    (sql: string) => api.query(sql) as Promise<Array<Record<string, unknown>>>,
    {
      rulesTable: cfg.rulesTableName,
      goalsTable: cfg.goalsTableName,
      currentUser: cfg.userName,
    },
    { tableExists },
  );

  if (!block) {
    // Renderer returns "" on empty state OR caught failure. Either
    // way the user-facing message is the same: nothing to print.
    // Print to stderr so a caller pipe-ing the output gets an empty
    // stdout (the documented "nothing to inject" signal).
    console.error("(no active rules or open goals)");
    return;
  }

  console.log(block);
}
