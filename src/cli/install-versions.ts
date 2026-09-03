import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getVersion } from "./version.js";
import { pkgRoot } from "./util.js";
import { findInstalledClaudeHookBundle, parseSemver } from "../commands/doctor.js";
import { readCurrentVersionFromManifest, DEFAULT_MANIFEST_PATH } from "../utils/plugin-cache.js";

/**
 * Probe env so `memoree --version` can exec PATH `memoree --version` once
 * without forking forever once this binary is itself on PATH.
 */
export const VERSION_PROBE_ENV = "MEMOREE_VERSION_PROBE";

function readStamp(dir: string): string | null {
  const path = join(dir, ".memoree_version");
  if (!existsSync(path)) return null;
  try {
    const stamp = readFileSync(path, "utf-8").trim();
    return stamp && stamp !== "0.0.0" ? stamp : null;
  } catch {
    return null;
  }
}

export function pathCliVersion(
  execFile: typeof execFileSync = execFileSync,
): string | null {
  if (process.env[VERSION_PROBE_ENV] === "1") return null;
  try {
    const raw = execFile("memoree", ["--version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      env: { ...process.env, [VERSION_PROBE_ENV]: "1" },
    });
    return parseSemver(String(raw));
  } catch {
    return null;
  }
}

export function hookStampVersion(home: string = homedir()): string | null {
  const installedClaude = findInstalledClaudeHookBundle(home);
  const stamps = [
    readStamp(join(home, ".codex", "memoree")),
    installedClaude ? readStamp(join(installedClaude, "..")) : null,
    readStamp(join(home, ".gemini", "config", "plugins", "memoree")),
    readStamp(join(home, ".gemini", "antigravity-cli", "plugins", "memoree")),
    readStamp(pkgRoot()),
  ].filter((stamp): stamp is string => Boolean(stamp));
  return stamps[0] ?? null;
}

export interface VersionReport {
  hook: string;
  pathCli: string | null;
  claudeActive: string | null;
}

export function collectVersionReport(
  home: string = homedir(),
  execFile: typeof execFileSync = execFileSync,
): VersionReport {
  return {
    hook: hookStampVersion(home) ?? getVersion(),
    pathCli: pathCliVersion(execFile),
    claudeActive: readCurrentVersionFromManifest(
      home === homedir() ? DEFAULT_MANIFEST_PATH : join(home, ".claude", "plugins", "installed_plugins.json"),
    ),
  };
}

export function formatVersionReport(report: VersionReport = collectVersionReport()): string {
  const lines = [`memoree ${getVersion()}`];
  lines.push(`  hook stamp:     ${report.hook}`);
  if (!report.pathCli) {
    lines.push("  PATH CLI:       (not on PATH)");
  } else if (report.pathCli !== report.hook && report.pathCli !== getVersion()) {
    lines.push(
      `  PATH CLI:       ${report.pathCli} ≠ hook stamp (leftover npm -g; run npx -y @sskarz/memoree install)`,
    );
  } else {
    lines.push(`  PATH CLI:       ${report.pathCli}`);
  }
  if (report.claudeActive) {
    lines.push(`  Claude plugin:  ${report.claudeActive} (active)`);
  }
  return lines.join("\n");
}
