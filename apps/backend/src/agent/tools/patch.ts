/**
 * apply_patch — surgically edit a file with a unified diff (Cursor-style).
 *
 * Unlike write_file (which rewrites the whole file), apply_patch lets the model
 * submit a minimal unified diff: only changed lines are touched. This is the
 * preferred tool for editing existing code — avoids clobbering user changes
 * outside the intended change.
 *
 * By default stages a propose for user Apply (same as write_file).
 * Set LIA_AUTO_APPLY_FILES=1 to write immediately.
 */

import { z } from "zod";
import { readFile } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { logger } from "../../util/logger.js";
import { registerTool } from "../tool-registry.js";
import { proposeOrApplyFileChange } from "../file-changes.js";

const ApplyPatchSchema = z.object({
  /** Path of the file inside the task fsScope */
  filePath: z.string().min(1).max(500).describe("Relative path inside fsScope"),
  /** Unified diff or full file content if impossible to diff */
  patch: z.string().min(1).describe("Unified diff (---/+++/@@ blocks) or full file content"),
  /** Create parent directories if they don't exist */
  createDirs: z.boolean().optional().describe("Create directories if needed (default: false)"),
});

/** Very small subset of unified diff that we support. */
interface DiffHunk {
  startLine: number;
  deleteCount: number;
  insertLines: string[];
}

function parseUnifiedDiff(patch: string): DiffHunk[] | null {
  const lines = patch.split("\n");
  if (lines.length < 2) return null;
  const hunks: DiffHunk[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("@@")) {
      const m = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) return null;
      const oldStart = parseInt(m[1]!, 10);
      const deleteCount = m[2] ? parseInt(m[2], 10) : 1;
      const insertLines: string[] = [];
      for (i++; i < lines.length; i++) {
        if (lines[i]!.startsWith("@@")) {
          i--;
          break;
        }
        if (lines[i]!.startsWith("---") || lines[i]!.startsWith("+++")) continue;
        if (lines[i]!.startsWith("+")) {
          insertLines.push(lines[i]!.slice(1));
        } else if (lines[i]!.startsWith("-")) {
          // delete — skip
        } else if (lines[i]!.startsWith(" ")) {
          insertLines.push(lines[i]!.slice(1));
        } else if (lines[i] === "") {
          insertLines.push("");
        }
      }
      hunks.push({ startLine: oldStart, deleteCount, insertLines });
    }
  }

  return hunks.length > 0 ? hunks : null;
}

/** Apply hunks to file content. */
function applyHunks(content: string, hunks: DiffHunk[]): string {
  const lines = content.split("\n");
  const result: string[] = [];
  let cursor = 0;

  for (const hunk of hunks) {
    while (cursor < hunk.startLine - 1) {
      result.push(lines[cursor++] ?? "");
    }
    cursor += hunk.deleteCount;
    for (const newLine of hunk.insertLines) {
      result.push(newLine);
    }
  }

  while (cursor < lines.length) {
    result.push(lines[cursor++] ?? "");
  }

  return result.join("\n");
}

async function readFileSafely(fsScope: string, path: string): Promise<string> {
  if (isAbsolute(path)) {
    throw new Error("Absolute paths are not allowed in patches");
  }
  const abs = resolve(fsScope, path);
  const rel = relative(fsScope, abs);
  if (rel.startsWith("..") || rel === "") throw new Error(`Path escapes fsScope: ${path}`);
  try {
    return await readFile(abs, "utf-8");
  } catch {
    throw new Error(`File not found or not readable: ${rel}`);
  }
}

/**
 * Compute next file content from a patch (does not write).
 */
export async function computePatchedContent(
  fsScope: string,
  input: z.infer<typeof ApplyPatchSchema>,
): Promise<{ path: string; next: string; hunksApplied?: number; replacedWhole?: boolean }> {
  const { filePath, patch } = input;

  const existing = await readFileSafely(fsScope, filePath);
  const hunks = parseUnifiedDiff(patch);
  let next: string;

  if (hunks && hunks.length > 0) {
    logger.debug({ fsScope, filePath, hunks: hunks.length }, "apply_patch: computing hunks");
    next = applyHunks(existing, hunks);
  } else {
    logger.debug({ fsScope, filePath }, "apply_patch: falling back to whole-file replacement");
    next = patch;
  }

  const rel = relative(fsScope, resolve(fsScope, filePath));
  return {
    path: rel,
    next,
    hunksApplied: hunks?.length,
    replacedWhole: !hunks || hunks.length === 0,
  };
}

registerTool({
  name: "apply_patch",
  description:
    "SECONDARY tool: propose a small unified-diff fix on an existing file. " +
    "Do NOT use this as the main path for features — prefer write_files with full file contents. " +
    "Use only for tiny follow-ups after a volume batch (typo, import, one function tweak).",
  inputSchema: ApplyPatchSchema,
  available: (_resources, task) => task.fsScope !== null,
  execute: async (input, ctx) => {
    const parsed = ApplyPatchSchema.parse(input as Record<string, unknown>);
    const computed = await computePatchedContent(ctx.fsScope!, parsed);
    const record = await proposeOrApplyFileChange({
      taskId: ctx.taskId,
      fsScope: ctx.fsScope!,
      path: computed.path,
      tool: "apply_patch",
      proposedContent: computed.next,
    });
    if (!record.applied) {
      ctx.emit({
        type: "file_propose",
        changeId: record.id,
        path: record.path,
        tool: "apply_patch",
        created: record.created,
        diff: record.diff,
        ts: Date.now(),
      });
    } else {
      ctx.emit({
        type: "file_applied",
        changeId: record.id,
        path: record.path,
        ts: Date.now(),
      });
    }
    return {
      path: record.path,
      ok: true,
      pending: !record.applied,
      changeId: record.id,
      hunksApplied: computed.hunksApplied,
      replacedWhole: computed.replacedWhole,
      message: record.applied
        ? "Patch applied to disk (auto-apply)."
        : "Patch proposed — waiting for user Apply. read_file sees the pending overlay.",
    };
  },
});
