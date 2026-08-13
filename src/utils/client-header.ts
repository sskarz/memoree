/**
 * X-Memoree-Client header helper.
 *
 * The memoree-api backend reads X-Memoree-Client to attribute traffic by
 * client family (distinguishes memoree traffic from sskarz-cli /
 * device-code-flow traffic). Every outbound request to memoree-api carries
 * this header.
 *
 * Static "memoree" — no version dimension. The version part used to be
 * baked in via esbuild's `define: { __MEMOREE_VERSION__: ... }`, but
 * keeping every per-bundle build step in sync was a recurring source of
 * bugs across independently built artifacts, and the backend doesn't actively use the
 * version dimension. If version-level attribution becomes useful again,
 * re-introduce the define on every build step that ships a bundle hitting
 * memoree-api.
 */
export const MEMOREE_CLIENT_HEADER = "X-Memoree-Client";

/** Returns "memoree" — the value for the X-Memoree-Client header. */
export function memoreeClientValue(): string {
  return "memoree";
}

/** Returns { "X-Memoree-Client": "memoree" } for spreading into a headers object. */
export function memoreeClientHeader(): Record<string, string> {
  return { [MEMOREE_CLIENT_HEADER]: memoreeClientValue() };
}
