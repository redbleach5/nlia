/**
 * Resources API + WorkspaceService smoke tests.
 *
 * Covers:
 *   - attachInline (multipart upload) → resource created with textPreview
 *   - mount folder → resource created with license config (Addendum A.2)
 *   - list → episode-scoped + global resources
 *   - read → returns content for inline + folder
 *   - delete → removes resource (+ inline file on disk)
 *   - license column / distributionAllowed flag
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { app } from "../src/index.js";
import { closeDb, getDb } from "../src/db/client.js";
import { pushSchema } from "../src/db/push.js";
import { createEpisode } from "../src/services/episodes.js";
import { ATTACHMENTS_DIR } from "../src/workspace/service.js";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Resource } from "@lia/shared";

// Use a real temp folder for mount tests
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

describe("Resources API (WorkspaceService)", () => {
  let episodeId: string;
  let tempFolder: string;

  beforeAll(() => {
    getDb();
    pushSchema();
    const ep = createEpisode({ title: "Resources test episode" });
    episodeId = ep.id;
    tempFolder = mkdtempSync(join(tmpdir(), "lia-test-"));
    writeFileSync(join(tempFolder, "file1.txt"), "content of file 1");
    writeFileSync(join(tempFolder, "file2.md"), "# File 2\nmarkdown content");
  });

  afterAll(() => {
    closeDb();
  });

  // ─── attachInline ────────────────────────────────────────────────
  it("POST /api/episodes/:episodeId/resources/inline uploads a text file", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File(["Hello, this is test content for the attachment."], "test.txt", {
        type: "text/plain",
      }),
    );

    const res = await app.request(
      `/api/episodes/${episodeId}/resources/inline`,
      {
        method: "POST",
        body: formData,
      },
    );
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resource: Resource };
    expect(body.resource.kind).toBe("inline");
    expect(body.resource.name).toBe("test.txt");
    expect(body.resource.status).toBe("ready");
    expect(body.resource.byteSize).toBeGreaterThan(0);
    expect(body.resource.config.mimeType).toBe("text/plain");
    expect(body.resource.config.textPreview).toContain("Hello, this is test content");
    expect(body.resource.config.storageKey).toContain(episodeId);
  });

  it("rejects unsupported MIME type", async () => {
    const formData = new FormData();
    formData.append(
      "file",
      new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], "evil.exe", {
        type: "application/x-msdownload",
      }),
    );

    const res = await app.request(
      `/api/episodes/${episodeId}/resources/inline`,
      {
        method: "POST",
        body: formData,
      },
    );
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("attach_failed");
  });

  // ─── mount folder ────────────────────────────────────────────────
  it("POST /api/episodes/:episodeId/resources mounts a folder", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "folder",
        path: tempFolder,
        name: "Test folder",
        license: "MIT",
        distributionAllowed: true,
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { resource: Resource };
    expect(body.resource.kind).toBe("folder");
    expect(body.resource.name).toBe("Test folder");
    expect(body.resource.status).toBe("idle");
    expect(body.resource.config.folderPath).toBe(tempFolder);
    expect(body.resource.config.license).toBe("MIT");
    expect(body.resource.config.distributionAllowed).toBe(true);
  });

  it("rejects mount with non-existent path", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/resources`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "folder",
        path: "/nonexistent/path/that/does/not/exist",
      }),
    });
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error).toBe("mount_failed");
  });

  // ─── list ────────────────────────────────────────────────────────
  it("GET /api/episodes/:episodeId/resources lists episode + global resources", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/resources`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Resource[] };
    expect(body.resources.length).toBeGreaterThanOrEqual(2); // 1 inline + 1 folder
    const inlineCount = body.resources.filter((r) => r.kind === "inline").length;
    const folderCount = body.resources.filter((r) => r.kind === "folder").length;
    expect(inlineCount).toBeGreaterThanOrEqual(1);
    expect(folderCount).toBeGreaterThanOrEqual(1);
  });

  it("GET /api/episodes/:episodeId/resources?kind=inline filters by kind", async () => {
    const res = await app.request(`/api/episodes/${episodeId}/resources?kind=inline`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resources: Resource[] };
    expect(body.resources.length).toBeGreaterThanOrEqual(1);
    expect(body.resources.every((r) => r.kind === "inline")).toBe(true);
  });

  // ─── read ────────────────────────────────────────────────────────
  it("GET /api/resources/:id/read returns inline text preview", async () => {
    // Find the inline resource we created
    const listRes = await app.request(`/api/episodes/${episodeId}/resources?kind=inline`);
    const { resources } = (await listRes.json()) as { resources: Resource[] };
    const inline = resources[0];

    const res = await app.request(`/api/resources/${inline.id}/read`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("Hello, this is test content");
    expect(body.truncated).toBe(false);
    expect(body.mimeType).toBe("text/plain");
  });

  it("GET /api/resources/:id/read returns folder manifest", async () => {
    const listRes = await app.request(`/api/episodes/${episodeId}/resources?kind=folder`);
    const { resources } = (await listRes.json()) as { resources: Resource[] };
    const folder = resources[0];

    const res = await app.request(`/api/resources/${folder.id}/read`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.content).toContain("file1.txt");
    expect(body.content).toContain("file2.md");
  });

  it("GET /api/resources/:id/read returns 404 for unknown id", async () => {
    const res = await app.request(`/api/resources/nonexistent-id/read`);
    expect(res.status).toBe(404);
  });

  // ─── get single ──────────────────────────────────────────────────
  it("GET /api/resources/:id returns single resource", async () => {
    const listRes = await app.request(`/api/episodes/${episodeId}/resources?kind=inline`);
    const { resources } = (await listRes.json()) as { resources: Resource[] };
    const inline = resources[0];

    const res = await app.request(`/api/resources/${inline.id}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resource: Resource };
    expect(body.resource.id).toBe(inline.id);
    expect(body.resource.kind).toBe("inline");
  });

  // ─── delete ──────────────────────────────────────────────────────
  it("DELETE /api/resources/:id removes inline resource + file on disk", async () => {
    // Upload a new file specifically for this test
    const formData = new FormData();
    formData.append(
      "file",
      new File(["delete me"], "to-delete.txt", { type: "text/plain" }),
    );
    const uploadRes = await app.request(
      `/api/episodes/${episodeId}/resources/inline`,
      { method: "POST", body: formData },
    );
    const { resource } = (await uploadRes.json()) as { resource: Resource };
    const storageKey = resource.config.storageKey!;
    const filePath = join(ATTACHMENTS_DIR, storageKey);
    expect(existsSync(filePath)).toBe(true);

    const delRes = await app.request(`/api/resources/${resource.id}`, {
      method: "DELETE",
    });
    expect(delRes.status).toBe(200);
    expect(existsSync(filePath)).toBe(false);

    // Verify gone from list
    const listRes = await app.request(`/api/episodes/${episodeId}/resources?kind=inline`);
    const { resources } = (await listRes.json()) as { resources: Resource[] };
    expect(resources.find((r) => r.id === resource.id)).toBeUndefined();
  });

  it("DELETE /api/resources/:id returns 404 for unknown id", async () => {
    const res = await app.request(`/api/resources/nonexistent-id`, {
      method: "DELETE",
    });
    expect(res.status).toBe(404);
  });

  it("returns 404 for unknown episode when listing", async () => {
    const res = await app.request(`/api/episodes/nonexistent-episode/resources`);
    expect(res.status).toBe(404);
  });
});
