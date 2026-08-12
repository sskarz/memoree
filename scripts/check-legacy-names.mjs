#!/usr/bin/env node

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = process.cwd();
const ignoredDirectories = new Set([".git", "node_modules", "coverage", "jscpd-report"]);
const bannedBrands = ["deep" + "lake", "hive" + "mind", "active" + "loop"];
const legalAttributionFiles = new Set(["LICENSE"]);
const legalAttributionLines = new Map([
  ["README.md", [new RegExp(
    `^Memoree began as a fork of \\[${bannedBrands[1]}\\]\\(https:\\/\\/github\\.com\\/${bannedBrands[2]}ai\\/${bannedBrands[1]}\\)\\. ` +
    "It is now maintained as an independent project, with gratitude to the original project and its contributors\\.$",
    "i",
  )]],
]);
const removedCommands = ["log" + "in", "log" + "out", "who" + "ami", "account", "organization", "org", "workspaces", "workspace", "members", "invite", "remove", "update", "autoupdate"];
const removedVariables = ["TOKEN", "API_URL", "ORG_ID", "WORKSPACE_ID"].map(name => `MEMOREE_${name}`);
const removedCredentialPath = ".memoree/" + "credentials.json";
const forbidden = new RegExp(
  `${bannedBrands.join("|")}|\\.${bannedBrands[0]}|\\.${bannedBrands[1]}|${bannedBrands[1]}_|` +
  `${removedVariables.join("|")}|${removedCredentialPath.replace(".", "\\.")}|` +
  `memoree\\s+(?:${removedCommands.join("|")})(?:\\s|[\"])|api\\.memoree\\.ai`,
  "i",
);
const failures = [];

function scan(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory() && ignoredDirectories.has(entry.name)) continue;
    const absolute = join(directory, entry.name);
    const path = relative(root, absolute);
    if (forbidden.test(path)) failures.push(`${path}: forbidden legacy name in path`);
    if (entry.isDirectory()) {
      scan(absolute);
      continue;
    }
    if (!entry.isFile() || legalAttributionFiles.has(path) || statSync(absolute).size > 5_000_000) continue;
    let content;
    try { content = readFileSync(absolute, "utf-8"); } catch { continue; }
    if (content.includes("\0")) continue;
    const lines = content.split(/\r?\n/);
    for (let index = 0; index < lines.length; index++) {
      if (legalAttributionLines.get(path)?.some(pattern => pattern.test(lines[index]))) continue;
      if (forbidden.test(lines[index])) failures.push(`${path}:${index + 1}: ${lines[index].trim().slice(0, 160)}`);
    }
  }
}

scan(root);
if (failures.length > 0) {
  console.error("Legacy branding check failed:");
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log("legacy-name check: ok");
