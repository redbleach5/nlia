// POST /api/settings/upload-vrm — upload a VRM file via multipart/form-data
//
// Saves to public/models/<original-name>.vrm
// Returns the public URL for the file.

import { NextRequest, NextResponse } from 'next/server';
import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import { PATHS, sanitizeFilename } from '@/lib/paths';
import { db } from '@/lib/db';
import { apiError } from '@/lib/infra/api-error';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MAX_VRM_SIZE = 50 * 1024 * 1024; // 50 MB

export async function POST(req: NextRequest) {
  try {
    const formData = await req.formData();
    const file = formData.get('file');

    if (!file || !(file instanceof File)) {
      return NextResponse.json({ error: 'No file uploaded' }, { status: 400 });
    }

    if (!file.name.toLowerCase().endsWith('.vrm')) {
      return NextResponse.json({ error: 'Only .vrm files are supported' }, { status: 400 });
    }

    if (file.size > MAX_VRM_SIZE) {
      return NextResponse.json({
        error: `File too large: ${(file.size / 1024 / 1024).toFixed(1)} MB. Max ${MAX_VRM_SIZE / 1024 / 1024} MB.`,
      }, { status: 413 });
    }

    // Sanitize filename
    const safeName = sanitizeFilename(file.name);
    if (!safeName.endsWith('.vrm')) {
      return NextResponse.json({ error: 'Invalid filename' }, { status: 400 });
    }

    // Read file into buffer for magic bytes check
    const buffer = Buffer.from(await file.arrayBuffer());

    // ── Magic bytes check ──
    // VRM files are glTF binary format. glTF binary starts with magic 0x46546C67
    // ('glTF' in little-endian: 0x67='g', 0x6C='l', 0x54='T', 0x46='F').
    // Without this check, any file with .vrm extension could be uploaded
    // (malicious script, executable, etc.). GLTFLoader would reject it later,
    // but we reject early — before saving to disk.
    //
    // glTF binary spec: https://registry.khronos.org/glTF/specs/2.0/glTF-2.0.html#binary-gltf-layout
    if (buffer.length < 12) {
      return NextResponse.json({
        error: 'File too small to be a valid VRM (glTF binary requires at least 12 bytes header)',
      }, { status: 400 });
    }
    const GLTF_MAGIC = 0x46546C67;  // 'glTF' little-endian
    const fileMagic = buffer.readUInt32LE(0);
    if (fileMagic !== GLTF_MAGIC) {
      const magicHex = buffer.slice(0, 4).toString('hex');
      return NextResponse.json({
        error: `Invalid VRM file: missing glTF magic. Expected 'glTF' (0x46546c67), got 0x${magicHex}. VRM files must be glTF binary format.`,
      }, { status: 400 });
    }

    // Ensure dir exists
    await mkdir(PATHS.publicModels, { recursive: true });

    // Write the file
    const fullPath = path.join(PATHS.publicModels, safeName);
    await writeFile(fullPath, buffer);

    const publicUrl = `/models/${safeName}`;

    // Set as active VRM
    await db.setting.upsert({
      where: { key: 'avatar_vrm_path' },
      create: { key: 'avatar_vrm_path', value: publicUrl },
      update: { value: publicUrl },
    });

    return NextResponse.json({
      ok: true,
      filename: safeName,
      url: publicUrl,
      size: file.size,
      sizeMb: (file.size / 1024 / 1024).toFixed(1),
    });
  } catch (e) {
    // P2-2 fix (M-X-5): don't leak filesystem path info.
    return apiError(500, 'VRM upload failed', {}, e);
  }
}
