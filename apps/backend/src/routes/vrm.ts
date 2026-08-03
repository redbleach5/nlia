/**
 * VRM avatar file routes — upload + download.
 *
 * GET  /api/settings/vrm       — download current VRM file (or 404)
 * POST /api/settings/vrm       — upload a new VRM file (multipart)
 * DELETE /api/settings/vrm     — remove VRM file
 *
 * VRM files are stored at data/vrm/avatar.vrm.
 * M7 stub: single file, no metadata. M8 may add per-persona VRM selection.
 */

import { Hono } from "hono";
import { readFile, writeFile, unlink, mkdir, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname as pathDirname } from "node:path";
import { logger } from "../util/logger.js";

export const vrmRoute = new Hono();

const here = pathDirname(fileURLToPath(import.meta.url));
// apps/backend/src/routes/ → apps/backend/data/vrm
const VRM_DIR = resolve(here, "../../data/vrm");
const VRM_PATH = resolve(VRM_DIR, "avatar.vrm");
const MAX_VRM_SIZE = 50 * 1024 * 1024; // 50 MB

// GET / — download current VRM file
vrmRoute.get("/", async (c) => {
  if (!existsSync(VRM_PATH)) {
    return c.json({ error: "no_vrm", message: "No VRM file uploaded yet" }, 404);
  }
  try {
    const buffer = await readFile(VRM_PATH);
    return new Response(buffer, {
      headers: {
        "Content-Type": "application/octet-stream",
        "Content-Disposition": 'attachment; filename="avatar.vrm"',
      },
    });
  } catch (e) {
    logger.error({ err: e }, "failed to read VRM file");
    return c.json({ error: "read_failed" }, 500);
  }
});

// POST / — upload a new VRM file
vrmRoute.post("/", async (c) => {
  let formData: FormData;
  try {
    formData = await c.req.formData();
  } catch {
    return c.json({ error: "invalid_form_data" }, 400);
  }

  const file = formData.get("file");
  if (!(file instanceof File)) {
    return c.json({ error: "missing_file", message: "formData must include a 'file' field" }, 400);
  }

  if (file.size > MAX_VRM_SIZE) {
    return c.json({ error: "file_too_large", message: `Max ${MAX_VRM_SIZE / (1024 * 1024)} MB` }, 400);
  }

  // Basic VRM validation: check file extension + magic bytes
  if (!file.name.toLowerCase().endsWith(".vrm")) {
    return c.json({ error: "invalid_file", message: "File must have .vrm extension" }, 400);
  }

  try {
    const buffer = Buffer.from(await file.arrayBuffer());
    // VRM files are glTF binary (.glb) — magic header is "glTF" (0x67 0x6C 0x54 0x46)
    if (buffer.length < 4 || buffer[0] !== 0x67 || buffer[1] !== 0x6C || buffer[2] !== 0x54 || buffer[3] !== 0x46) {
      return c.json({ error: "invalid_vrm", message: "File does not appear to be a valid VRM/glTF binary" }, 400);
    }

    await mkdir(VRM_DIR, { recursive: true });
    await writeFile(VRM_PATH, buffer);

    logger.info({ size: buffer.length, name: file.name }, "VRM file uploaded");
    return c.json({ ok: true, size: buffer.length, name: file.name });
  } catch (e) {
    logger.error({ err: e }, "failed to save VRM file");
    return c.json({ error: "save_failed" }, 500);
  }
});

// DELETE / — remove VRM file
vrmRoute.delete("/", async (c) => {
  if (!existsSync(VRM_PATH)) {
    return c.json({ error: "no_vrm" }, 404);
  }
  try {
    await unlink(VRM_PATH);
    logger.info("VRM file deleted");
    return c.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, "failed to delete VRM file");
    return c.json({ error: "delete_failed" }, 500);
  }
});

// GET /exists — check if VRM file exists (lighter than downloading)
vrmRoute.get("/exists", async (c) => {
  if (!existsSync(VRM_PATH)) {
    return c.json({ exists: false });
  }
  try {
    const s = await stat(VRM_PATH);
    return c.json({ exists: true, size: s.size, modifiedAt: s.mtimeMs });
  } catch {
    return c.json({ exists: false });
  }
});
