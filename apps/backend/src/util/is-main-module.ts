/**
 * Detect whether this module is the process entrypoint.
 * Works on Windows (C:\… vs file:///C:/…) and under tsx/node/watch.
 */

import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

function sameFile(a: string, b: string): boolean {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
}

export function isMainModule(
  metaUrl: string,
  argv: readonly string[] = process.argv,
): boolean {
  let metaPath: string;
  try {
    metaPath = resolve(fileURLToPath(metaUrl));
  } catch {
    return false;
  }

  // argv[1] is usually the entry; under `tsx watch` it may be later.
  for (let i = 1; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg || arg.startsWith("-")) continue;
    if (sameFile(metaPath, arg)) return true;
    if (sameFile(metaPath, resolve(process.cwd(), arg))) return true;
  }
  return false;
}
