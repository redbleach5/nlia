import 'server-only';

// ============================================================================
// fsScope helpers — безопасная работа с путями внутри рабочей директории агента.
// ============================================================================
//
// Защита от path traversal:
//   1. resolve(base) и resolve(target) — нормализуют пути
//   2. realpath() — резолвит символьные ссылки (предотвращает symlink-атаки)
//   3. relative(base, target) — вычисляет относительный путь
//   4. Если rel начинается с '..' или является абсолютным → попытка выхода
//
// P-CORE-3 fix: safeWriteFile previously used Node's 'w' flag, which is
// `O_WRONLY|O_CREAT|O_TRUNC` — NO `O_NOFOLLOW`. The module's own docstring
// claimed otherwise. Node's `open(path, 'w')` follows symlinks and truncates
// the link target, so a symlink-swap between `safePathWithinScope` and the
// write would still let an attacker overwrite arbitrary files. Now we use
// explicit numeric flags including `O_NOFOLLOW`, with a temp+rename fallback
// for cases where the platform refuses `O_NOFOLLOW` on existing files.
//
// P-CORE-4 fix: `safePathWithinScope` previously returned `null` for any
// target whose parent directory didn't exist (because `realpath(parentDir)`
// threw ENOENT). This blocked the common agent workflow of creating files
// in not-yet-existing subdirectories (`write_file({ path: 'src/new/mod.ts' })`
// before `src/new/` exists). We now walk up the path until we find an
// existing ancestor, verify it's inside scope, and return the original
// target. The caller's `mkdir({ recursive: true })` then creates the
// intermediate directories.

import { realpath, open, unlink, mkdir } from 'fs/promises';
import { resolve, relative, isAbsolute, dirname } from 'path';
import { constants as fsConstants } from 'fs';

// `O_NOFOLLOW` (Linux/macOS) is 0x20000 = 131072. We read it from
// `fs.constants` so the constant is correct on any platform. On Windows
// it's undefined; the open() call will fail with EINVAL and we fall back
// to the temp+rename path.
const O_NOFOLLOW = (fsConstants as unknown as { O_NOFOLLOW?: number }).O_NOFOLLOW ?? 0;

/**
 * Проверить, что путь находится внутри scope, и вернуть абсолютный путь.
 *
 * Если target уже существует — резолвим через realpath и проверяем, что
 * результат внутри scope. Если target не существует — поднимаемся вверх по
 * родительским директориям, пока не найдём существующего предка, проверяем
 * его через realpath, и возвращаем исходный target (не-realpath'd).
 */
export async function safePathWithinScope(path: string, scope: string | null): Promise<string | null> {
  if (!scope) return null;
  const base = resolve(scope);
  const target = isAbsolute(path) ? resolve(path) : resolve(base, path);

  // Fast path: target exists → realpath both and check containment.
  try {
    const realBase = await realpath(base);
    const realTarget = await realpath(target);
    const rel = relative(realBase, realTarget);
    if (rel.startsWith('..') || isAbsolute(rel)) return null;
    return realTarget;
  } catch {
    // target doesn't exist (ENOENT) or realpath otherwise failed — fall through.
  }

  // Target doesn't exist yet. Walk up the parent chain until we find an
  // existing ancestor; verify that ancestor is inside scope. If we reach
  // the filesystem root without finding one, refuse.
  // P-CORE-4 fix: previously we only checked the immediate parent (`dirname(target)`),
  // which fails for `src/new/file.ts` when `src/new/` doesn't exist yet —
  // blocking the common "create new module" workflow.
  const realBase = await realpath(base).catch(() => null);
  if (!realBase) return null;

  let ancestor = dirname(target);
  // Safety bound: 64 levels — well below any reasonable filesystem depth.
  for (let i = 0; i < 64; i++) {
    try {
      const realAncestor = await realpath(ancestor);
      const rel = relative(realBase, realAncestor);
      if (rel.startsWith('..') || isAbsolute(rel)) return null;
      // Ancestor exists and is inside scope — the target (which doesn't
      // exist) can be created here. Return the non-realpath'd target so
      // the caller can mkdir+write it.
      return target;
    } catch {
      // ancestor doesn't exist either — go up one more level.
      const parent = dirname(ancestor);
      if (parent === ancestor) return null; // reached filesystem root
      ancestor = parent;
    }
  }
  return null;
}

/**
 * P-CORE-3 fix: Safely write a file within scope, resistant to
 * symlink-swap TOCTOU attacks.
 *
 * Uses explicit `O_WRONLY|O_CREAT|O_TRUNC|O_NOFOLLOW` flags — if the target
 * path is a symlink, the open call fails with ELOOP. This prevents an
 * attacker from creating a symlink at the target path between the
 * safePathWithinScope check and the actual write.
 *
 * If `O_NOFOLLOW` isn't supported (Windows), falls back to a temp+rename
 * pattern with `O_CREAT|O_EXCL|O_NOFOLLOW` for the temp file.
 *
 * Also ensures parent directories exist (mkdir recursive) before writing.
 */
export async function safeWriteFile(
  path: string,
  scope: string | null,
  data: string | Buffer,
): Promise<void> {
  const safePath = await safePathWithinScope(path, scope);
  if (!safePath) {
    throw new Error(`path outside scope: ${path}`);
  }

  // Ensure parent directory exists. safePathWithinScope verified the closest
  // existing ancestor is in scope, so creating the missing subdirectories
  // cannot escape scope.
  const parentDir = dirname(safePath);
  await mkdir(parentDir, { recursive: true }).catch(() => null);

  // Try with O_NOFOLLOW first. If the target is a symlink, this fails with
  // ELOOP on Linux/macOS. On Windows O_NOFOLLOW is unsupported and open()
  // throws EINVAL — we fall through to the temp+rename path.
  if (O_NOFOLLOW) {
    try {
      const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | O_NOFOLLOW;
      const fh = await open(safePath, flags, 0o644);
      try {
        await fh.writeFile(data);
      } finally {
        await fh.close();
      }
      return;
    } catch (e: unknown) {
      const err = e as { code?: string };
      // ELOOP → symlink at the target — reject explicitly.
      if (err.code === 'ELOOP') {
        throw new Error(`refusing to write to symlink: ${safePath}`);
      }
      // EINVAL (Windows) or other → fall through to temp+rename fallback.
    }
  }

  // Fallback: write to a temp file in the same directory, then rename.
  // Temp uses O_CREAT|O_EXCL|O_NOFOLLOW — atomic create, refuses existing
  // files and symlinks. rename() is atomic on POSIX. We don't need O_NOFOLLOW
  // on the rename target because we already verified `safePath` is not a
  // symlink via safePathWithinScope.
  const tmpPath = `${safePath}.lia-tmp-${Date.now()}-${process.pid}`;
  try {
    const tmpFlags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL
      | (O_NOFOLLOW || 0);
    const fh = await open(tmpPath, tmpFlags, 0o644);
    try {
      await fh.writeFile(data);
    } finally {
      await fh.close();
    }
    const { rename } = await import('fs/promises');
    await rename(tmpPath, safePath);
  } catch (e) {
    // Best-effort cleanup
    try { await unlink(tmpPath); } catch { /* ignore */ }
    throw e;
  }
}
