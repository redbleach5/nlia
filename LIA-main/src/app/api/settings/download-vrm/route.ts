// POST /api/settings/download-vrm — download the sample VRM from Pixiv repo
//
// Saves to public/models/sample.vrm
// Useful when the user doesn't have their own VRM yet.

import { NextResponse } from 'next/server';
import { writeFile, mkdir, access } from 'fs/promises';
import path from 'path';
import { PATHS } from '@/lib/paths';
import { db } from '@/lib/db';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 60; // 1 min for download

const SAMPLE_VRM_URL = 'https://raw.githubusercontent.com/pixiv/three-vrm/dev/packages/three-vrm/examples/models/VRM1_Constraint_Twist_Sample.vrm';
const SAMPLE_VRM_FILENAME = 'sample.vrm';

export async function POST() {
  try {
    // Check if already exists
    const localPath = path.join(PATHS.publicModels, SAMPLE_VRM_FILENAME);
    try {
      await access(localPath);
      // Already exists — just set as active
      await db.setting.upsert({
        where: { key: 'avatar_vrm_path' },
        create: { key: 'avatar_vrm_path', value: `/models/${SAMPLE_VRM_FILENAME}` },
        update: { value: `/models/${SAMPLE_VRM_FILENAME}` },
      });
      return NextResponse.json({
        ok: true,
        message: 'Sample VRM already exists',
        url: `/models/${SAMPLE_VRM_FILENAME}`,
        alreadyExisted: true,
      });
    } catch {
      // Doesn't exist — download
    }

    // Download
    const res = await fetch(SAMPLE_VRM_URL, {
      signal: AbortSignal.timeout(30_000),
    });

    if (!res.ok) {
      return NextResponse.json({
        error: `Failed to download sample VRM: HTTP ${res.status}`,
      }, { status: 502 });
    }

    // P3-5 fix (M-DB-15.2): check Content-Length before buffering.
    // A compromised CDN serving a 1GB file would OOM the worker before the
    // 30s timeout fires (timeout is on socket inactivity, not total size).
    const contentLength = parseInt(res.headers.get('content-length') ?? '0', 10);
    const MAX_VRM_SIZE = 50 * 1024 * 1024;  // 50MB — same as upload-vrm
    if (contentLength > MAX_VRM_SIZE) {
      return NextResponse.json({
        error: `Sample VRM too large (${(contentLength / 1024 / 1024).toFixed(1)}MB, max ${MAX_VRM_SIZE / 1024 / 1024}MB)`,
      }, { status: 413 });
    }

    // P3-5 fix (M-DB-15.3): verify Content-Type is glTF-related.
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('model/') && !contentType.includes('application/octet-stream') && !contentType.includes('binary/octet-stream')) {
      return NextResponse.json({
        error: `Sample VRM has unexpected content-type: ${contentType}`,
      }, { status: 422 });
    }

    const buffer = Buffer.from(await res.arrayBuffer());

    // P3-5 fix (M-DB-15.1): magic bytes check — same as upload-vrm.
    // VRM files are glTF binary, starting with 0x46546C67 (glTF magic in LE).
    const GLTF_MAGIC = 0x46546C67;
    if (buffer.length < 4 || buffer.readUInt32LE(0) !== GLTF_MAGIC) {
      return NextResponse.json({
        error: 'Sample VRM failed magic bytes check (not a valid glTF binary)',
      }, { status: 422 });
    }

    // Ensure dir
    await mkdir(PATHS.publicModels, { recursive: true });

    // Write
    await writeFile(localPath, buffer);

    // Set as active
    await db.setting.upsert({
      where: { key: 'avatar_vrm_path' },
      create: { key: 'avatar_vrm_path', value: `/models/${SAMPLE_VRM_FILENAME}` },
      update: { value: `/models/${SAMPLE_VRM_FILENAME}` },
    });

    return NextResponse.json({
      ok: true,
      message: 'Sample VRM downloaded successfully',
      url: `/models/${SAMPLE_VRM_FILENAME}`,
      sizeMb: (buffer.length / 1024 / 1024).toFixed(1),
    });
  } catch (e) {
    // P2-2 fix (M-X-5): don't leak download URL / path info.
    return apiError(500, 'sample VRM download failed', {}, e);
  }
}
