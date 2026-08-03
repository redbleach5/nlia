/**
 * SSRF protection tests — initial URL + redirect hop re-validation.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { checkSsrf, safeFetch } from "../src/infra/ssrf.js";

describe("checkSsrf", () => {
  it("blocks loopback IP literals", async () => {
    const r = await checkSsrf("http://127.0.0.1:8787/api/health");
    expect(r.allowed).toBe(false);
    expect(r.reason).toContain("blocked");
  });

  it("blocks private ranges", async () => {
    expect((await checkSsrf("http://10.0.0.1/")).allowed).toBe(false);
    expect((await checkSsrf("http://192.168.1.1/")).allowed).toBe(false);
    expect((await checkSsrf("http://172.16.0.1/")).allowed).toBe(false);
  });

  it("rejects non-http protocols", async () => {
    const r = await checkSsrf("file:///etc/passwd");
    expect(r.allowed).toBe(false);
  });
});

describe("safeFetch redirect re-check", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("blocks redirect to localhost", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "http://93.184.216.34/open") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://127.0.0.1:8787/secret" },
        });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    await expect(safeFetch("http://93.184.216.34/open")).rejects.toThrow(/SSRF blocked/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows a safe redirect once", async () => {
    const fetchIp = vi.fn(async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url === "http://93.184.216.34/a") {
        return new Response(null, {
          status: 302,
          headers: { Location: "http://93.184.216.34/b" },
        });
      }
      if (url === "http://93.184.216.34/b") {
        return new Response("ok", { status: 200 });
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    vi.stubGlobal("fetch", fetchIp);

    const res = await safeFetch("http://93.184.216.34/a");
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
    expect(fetchIp).toHaveBeenCalledTimes(2);
  });
});
