import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/** Directory that contains the file identified by an `import.meta.url`. */
export function bundleDirFromImportMeta(importMetaUrl: string): string {
  return dirname(fileURLToPath(importMetaUrl));
}
