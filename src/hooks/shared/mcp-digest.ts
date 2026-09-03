/**
 * Classifier for Antigravity MCP capture-digest summaries.
 *
 * Marked rows carry {@link MCP_DIGEST_MARKER}. Older rows only had a
 * description prefix. Index and recall must agree so a legacy digest cannot
 * inject as Key Facts after being dropped from `index.md`.
 */

export const MCP_DIGEST_MARKER = "<!-- memoree-mcp-summary -->";

const LEGACY_DIGEST_PREFIXES = [
  "Antigravity MCP tools ran",
  "Antigravity MCP capture digest",
];

export function isMcpDigestText(summary?: unknown, description?: unknown): boolean {
  const body = typeof summary === "string" ? summary : "";
  if (body.includes(MCP_DIGEST_MARKER)) return true;
  const desc = typeof description === "string" ? description : "";
  return LEGACY_DIGEST_PREFIXES.some(prefix => desc.startsWith(prefix));
}
