import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { pkgRoot, readVersionStamp } from "./util.js";

function packageJsonVersion(root: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf-8"));
    if (typeof pkg.version === "string" && pkg.version.length > 0 && pkg.version !== "0.0.0") {
      return pkg.version;
    }
  } catch {
    /* missing or unreadable */
  }
  return null;
}

function stampVersionNear(root: string): string | null {
  let dir = root;
  for (let i = 0; i < 8; i++) {
    const stamp = readVersionStamp(dir);
    if (stamp && stamp !== "0.0.0") return stamp;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

export function getVersion(): string {
  const root = pkgRoot();
  return packageJsonVersion(root) ?? stampVersionNear(root) ?? "0.0.0";
}
