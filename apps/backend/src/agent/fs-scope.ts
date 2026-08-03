/**
 * Validate agent fsScope against LIA_WORKSPACE_ROOT or episode mounts.
 */

import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve, relative, isAbsolute } from "node:path";
import type { ResourceConfig } from "@lia/shared";
import { list as listResources } from "../workspace/service.js";
import { env } from "../util/env.js";

export interface FsScopeValidation {
  ok: true;
  path: string;
}

export interface FsScopeValidationError {
  ok: false;
  error: string;
  message: string;
}

function canonicalize(input: string): string {
  const abs = isAbsolute(input) ? resolve(input) : resolve(input);
  try {
    if (existsSync(abs)) return realpathSync(abs);
  } catch {
    // fall through
  }
  // Path may not exist yet — canonicalize parent if possible
  try {
    const parent = resolve(abs, "..");
    if (existsSync(parent)) {
      return resolve(realpathSync(parent), abs.slice(parent.length + 1) || ".");
    }
  } catch {
    // fall through
  }
  return abs;
}

function isUnderRoot(candidate: string, root: string): boolean {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function mountRootsForEpisode(episodeId: string): string[] {
  const resources = listResources(episodeId);
  const roots: string[] = [];
  for (const r of resources) {
    if (r.kind !== "folder" && r.kind !== "codebase") continue;
    const cfg = r.config as ResourceConfig;
    const p = cfg.folderPath ?? cfg.projectPath;
    if (!p) continue;
    roots.push(canonicalize(p));
  }
  return roots;
}

/**
 * Validate and canonicalize an optional fsScope for an agent task.
 * - If unset/empty → ok with null path (caller stores null)
 * - If LIA_WORKSPACE_ROOT is set → must be under that root
 * - Else → must be under a mounted folder/codebase for the episode
 */
export function validateFsScope(
  episodeId: string,
  fsScope: string | undefined | null,
): FsScopeValidation | FsScopeValidationError | { ok: true; path: null } {
  if (!fsScope || !fsScope.trim()) {
    return { ok: true, path: null };
  }

  const trimmed = fsScope.trim();
  if (trimmed === "/" || trimmed === "\\" ) {
    return {
      ok: false,
      error: "fs_scope_forbidden",
      message: "fsScope cannot be filesystem root",
    };
  }

  const canonical = canonicalize(trimmed);

  try {
    if (existsSync(canonical) && !statSync(canonical).isDirectory()) {
      return {
        ok: false,
        error: "fs_scope_not_directory",
        message: "fsScope must be a directory",
      };
    }
  } catch {
    // ignore
  }

  const workspaceRoot = env.workspaceRoot;
  if (workspaceRoot) {
    const root = canonicalize(workspaceRoot);
    if (!isUnderRoot(canonical, root)) {
      return {
        ok: false,
        error: "fs_scope_outside_workspace",
        message: `fsScope must be under LIA_WORKSPACE_ROOT (${root})`,
      };
    }
    return { ok: true, path: canonical };
  }

  const mounts = mountRootsForEpisode(episodeId);
  if (mounts.length === 0) {
    return {
      ok: false,
      error: "fs_scope_no_mounts",
      message:
        "fsScope requires LIA_WORKSPACE_ROOT or a mounted folder/codebase on this episode",
    };
  }

  const allowed = mounts.some((root) => isUnderRoot(canonical, root));
  if (!allowed) {
    return {
      ok: false,
      error: "fs_scope_outside_mounts",
      message: "fsScope must be under a mounted folder/codebase for this episode",
    };
  }

  return { ok: true, path: canonical };
}
