/**
 * Smart context compression for @file mentions — signatures + line windows.
 * Pure helpers (no I/O).
 */

const SIGNATURE_RE =
  /^\s*(?:export\s+)?(?:async\s+)?(?:function|class|type|interface|const|let|enum|def|fn|pub\s+fn|struct|impl)\b.*$/gm;

export type CompressOptions = {
  /** Max chars for full file inject. */
  fullCap?: number;
  /** Max chars for signature outline. */
  signatureCap?: number;
  /** Window radius when lineStart is set. */
  windowRadius?: number;
};

const DEFAULTS = {
  fullCap: 8_000,
  signatureCap: 3_000,
  windowRadius: 40,
};

/**
 * Compress file content for prompt injection.
 * - Small files: full text
 * - Large: signature outline (+ optional line window)
 */
export function compressFileForContext(
  path: string,
  content: string,
  opts?: CompressOptions & { lineStart?: number; lineEnd?: number },
): { text: string; truncated: boolean; mode: 'full' | 'window' | 'signatures' } {
  const fullCap = opts?.fullCap ?? DEFAULTS.fullCap;
  const signatureCap = opts?.signatureCap ?? DEFAULTS.signatureCap;
  const radius = opts?.windowRadius ?? DEFAULTS.windowRadius;
  const lines = content.split(/\r?\n/);

  if (opts?.lineStart != null) {
    const start = Math.max(0, opts.lineStart - 1 - radius);
    const end = Math.min(lines.length, (opts.lineEnd ?? opts.lineStart) + radius);
    const slice = lines.slice(start, end).map((l, i) => `${start + i + 1}|${l}`).join('\n');
    const text = `FILE ${path} lines ${start + 1}-${end}:\n${slice}`;
    return {
      text: text.length > fullCap ? text.slice(0, fullCap) + '\n…[truncated]' : text,
      truncated: text.length > fullCap || start > 0 || end < lines.length,
      mode: 'window',
    };
  }

  if (content.length <= fullCap) {
    return { text: `FILE ${path}:\n${content}`, truncated: false, mode: 'full' };
  }

  const sigs: string[] = [];
  let m: RegExpExecArray | null;
  const re = new RegExp(SIGNATURE_RE.source, 'gm');
  while ((m = re.exec(content)) !== null) {
    const lineNo = content.slice(0, m.index).split(/\r?\n/).length;
    sigs.push(`${lineNo}|${m[0].trim().slice(0, 120)}`);
    if (sigs.join('\n').length > signatureCap) break;
  }

  const outline = sigs.length > 0
    ? sigs.join('\n')
    : lines.slice(0, 40).map((l, i) => `${i + 1}|${l}`).join('\n');

  const text =
    `FILE ${path} (truncated — signatures / head; use read_file/grep for body):\n${outline.slice(0, signatureCap)}`;
  return { text, truncated: true, mode: 'signatures' };
}

export function estimateCharsBudget(parts: string[], cap: number): string {
  let used = 0;
  const out: string[] = [];
  for (const p of parts) {
    if (used >= cap) {
      out.push('…[context budget exhausted; use tools for more]');
      break;
    }
    const room = cap - used;
    if (p.length <= room) {
      out.push(p);
      used += p.length;
    } else {
      out.push(p.slice(0, room) + '\n…[truncated]');
      used = cap;
    }
  }
  return out.join('\n\n');
}
