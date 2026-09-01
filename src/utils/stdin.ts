/** Read hook JSON from a stream without requiring the writer to close stdin. */

import type { Readable } from "node:stream";

type Releaseable = {
  pause?: () => void;
  unref?: () => void;
  removeListener: (event: string, listener: (...args: unknown[]) => void) => void;
};

/**
 * Parse a complete JSON value from buffered hook stdin.
 * Returns undefined while the buffer is empty or still incomplete.
 */
export function tryParseJsonValue<T>(raw: string): T | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    const value = JSON.parse(trimmed) as T;
    // Hook payloads are objects. Scalars like `1` can appear as prefixes of
    // a larger number, so only complete objects/arrays early-resolve.
    if (value !== null && typeof value === "object") return value;
    return undefined;
  } catch {
    return undefined;
  }
}

function releaseStream(stream: Releaseable): void {
  try { stream.pause?.(); } catch { /* ignore */ }
  try { stream.unref?.(); } catch { /* ignore */ }
}

/**
 * Read all of stdin (or `stream`) and parse it as JSON.
 *
 * Antigravity's `agy -p` writes the hook payload then keeps the pipe open until
 * the child exits. Waiting for EOF hangs until the hooks.json timeout, so we
 * resolve as soon as a complete JSON value is buffered and unref the stream
 * so the hook process can exit and return stdout (injectSteps / deny / stop).
 */
export function readStdin<T>(stream: Readable = process.stdin): Promise<T> {
  return new Promise((resolve, reject) => {
    let data = "";
    let settled = false;
    const releaseable = stream as unknown as Releaseable;

    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      stream.removeListener("data", onData);
      stream.removeListener("end", onEnd);
      stream.removeListener("error", onError);
      releaseStream(releaseable);
      fn();
    };

    const onData = (chunk: string | Buffer): void => {
      data += typeof chunk === "string" ? chunk : chunk.toString("utf8");
      const parsed = tryParseJsonValue<T>(data);
      if (parsed !== undefined) settle(() => resolve(parsed));
    };

    const onEnd = (): void => {
      settle(() => {
        try {
          resolve(JSON.parse(data) as T);
        } catch (err) {
          reject(new Error(`Failed to parse hook input: ${err}`));
        }
      });
    };

    const onError = (err: Error): void => {
      settle(() => reject(err));
    };

    if (typeof stream.setEncoding === "function") stream.setEncoding("utf-8");
    stream.on("data", onData);
    stream.on("end", onEnd);
    stream.on("error", onError);
  });
}
