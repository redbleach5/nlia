import 'server-only';

// save_artifact — сохранить артефакт (SVG, HTML, код) как файл для пользователя.
//
// Файлы кладутся в <project_root>/download/lia-artifacts/ (кросс-платформенно).
// Скачиваются через /api/artifacts/[filename].
//
// Phase 1 fix: атомарный create-or-rename через fs.open(path, 'wx') (O_EXCL).
// P3-6 fix: size limit (10MB) + EEXIST retry loop with random suffix.

import { mkdir, open } from 'fs/promises';
import path from 'path';
import { db } from '@/lib/db';
import { randomUUID } from 'crypto';
import { PATHS, sanitizeFilename } from '@/lib/paths';

// P3-6 fix (M-DB-10.2): max artifact size — 10MB.
// LLM could previously pass a 500MB string, causing OOM or disk fill.
const MAX_ARTIFACT_SIZE = 10 * 1024 * 1024;

export type SaveArtifactResult = {
  id: string;
  filename: string;
  path: string;
  url: string;
  size: number;
  mime: string;
};

export async function saveArtifact(params: {
  filename: string;
  content: string;
  mime: string;
}): Promise<SaveArtifactResult> {
  const { content, mime } = params;

  // P3-6 fix (M-DB-10.2): enforce size limit before any I/O.
  const contentBytes = Buffer.byteLength(content, 'utf8');
  if (contentBytes > MAX_ARTIFACT_SIZE) {
    throw new Error(
      `Artifact too large: ${contentBytes} bytes (max ${MAX_ARTIFACT_SIZE} bytes = ${MAX_ARTIFACT_SIZE / 1024 / 1024}MB)`
    );
  }

  let filename = sanitizeFilename(params.filename);

  // Strip any path components (defensive — sanitizeFilename already did this)
  const basename = path.basename(filename);

  // Prevent hidden files
  if (basename.startsWith('.')) {
    filename = 'artifact-' + basename;
  }

  // Ensure artifacts directory exists
  await mkdir(PATHS.artifacts, { recursive: true });

  // Атомарный create-or-rename через fs.open(path, 'wx') (O_EXCL).
  // P3-6 fix (M-DB-10.1): EEXIST branch now uses O_EXCL retry loop with random
  // suffix instead of plain writeFile (which had its own TOCTOU race).
  let finalName = basename;
  let finalPath = path.join(PATHS.artifacts, finalName);

  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const handle = await open(finalPath, 'wx');
      await handle.writeFile(content, 'utf8');
      await handle.close();
      break;
    } catch (e: unknown) {
      const err = e as NodeJS.ErrnoException;
      if (err.code === 'EEXIST') {
        // File exists — prepend timestamp + random suffix and retry with O_EXCL.
        const ext = path.extname(basename);
        const stem = path.basename(basename, ext);
        const suffix = attempt === 0
          ? String(Date.now())
          : `${Date.now()}-${randomUUID().slice(0, 8)}`;
        finalName = `${stem}-${suffix}${ext}`;
        finalPath = path.join(PATHS.artifacts, finalName);
        continue;  // retry with O_EXCL
      }
      throw e;
    }
  }

  // Persist to DB for listing.
  const id = randomUUID();
  // P3-6 fix (M-DB-10.4): don't store full filesystem path in DB — only filename.
  // If the DB leaks, it shouldn't reveal the host's directory structure.
  const record = {
    id,
    filename: finalName,
    url: `/api/artifacts/${finalName}`,
    size: contentBytes,
    mime,
  };
  await db.setting.upsert({
    where: { key: `artifact:${id}` },
    create: {
      key: `artifact:${id}`,
      value: JSON.stringify(record),
    },
    update: {
      value: JSON.stringify(record),
    },
  });

  return {
    ...record,
    path: finalPath, // internal only — not persisted in Setting
  };
}
