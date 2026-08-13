function singleQuoteLiteral(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/** Build a harmless host command that prints a handled sandbox result literally. */
export function safeStdoutReplacement(body: string): string {
  return `printf '%s\\n' ${singleQuoteLiteral(body)}`;
}

/**
 * Build a harmless host command that reproduces a sandbox failure without
 * exposing any part of the original command to the host shell.
 */
export function safeFailureReplacement(
  stderr: string,
  status: number | null,
  stdout = "",
): string {
  const exitStatus = status !== null && Number.isInteger(status) && status > 0 && status <= 125
    ? status
    : 1;
  const commands: string[] = [];
  if (stdout) commands.push(`printf '%s' ${singleQuoteLiteral(stdout)}`);
  if (stderr) commands.push(`printf '%s' ${singleQuoteLiteral(stderr)} >&2`);
  commands.push(`exit ${exitStatus}`);
  return commands.join("; ");
}
