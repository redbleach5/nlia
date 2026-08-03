/**
 * isMainModule — Windows-safe entrypoint detection.
 */

import { describe, it, expect } from "vitest";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { isMainModule } from "../src/util/is-main-module.js";

describe("isMainModule", () => {
  it("matches when argv[1] is the module path", () => {
    const entry = resolve(process.cwd(), "src/index.ts");
    const meta = pathToFileURL(entry).href;
    expect(isMainModule(meta, ["node", entry])).toBe(true);
  });

  it("matches under tsx watch (script later in argv)", () => {
    const entry = resolve(process.cwd(), "src/index.ts");
    const meta = pathToFileURL(entry).href;
    expect(isMainModule(meta, ["node", "/usr/bin/tsx", "watch", entry])).toBe(true);
  });

  it("matches relative entry from cwd", () => {
    const entry = resolve(process.cwd(), "src/index.ts");
    const meta = pathToFileURL(entry).href;
    expect(isMainModule(meta, ["node", "src/index.ts"])).toBe(true);
  });

  it("rejects unrelated argv", () => {
    const entry = resolve(process.cwd(), "src/index.ts");
    const meta = pathToFileURL(entry).href;
    expect(isMainModule(meta, ["node", "/usr/bin/tsx", "watch"])).toBe(false);
  });

  it("rejects empty argv", () => {
    const entry = resolve(process.cwd(), "src/index.ts");
    const meta = pathToFileURL(entry).href;
    expect(isMainModule(meta, ["node"])).toBe(false);
  });
});
