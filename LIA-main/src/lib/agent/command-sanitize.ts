/**
 * Shell argv sanitization — block metachar / redirects even inside allowlisted bins.
 * Pure (shared). run_command already uses execFile (no shell); this adds defense in depth.
 */

const META_RE = /[|;&`$<>]|\$\(|&&|\|\|/;

export type SanitizeArgsResult =
  | { ok: true; args: string[] }
  | { ok: false; error: string };

export function sanitizeCommandArgs(args: string[]): SanitizeArgsResult {
  if (args.length > 64) {
    return { ok: false, error: 'too many arguments (max 64)' };
  }
  for (const a of args) {
    if (typeof a !== 'string') {
      return { ok: false, error: 'arguments must be strings' };
    }
    if (a.length > 2_000) {
      return { ok: false, error: 'argument too long' };
    }
    if (META_RE.test(a)) {
      return {
        ok: false,
        error: `argument contains shell metacharacters (blocked): ${a.slice(0, 40)}`,
      };
    }
  }
  return { ok: true, args };
}

/** Package-manager subcommand policy (npm/bun/pnpm/yarn). */
const PKG_SAFE_SUB = new Set([
  'test', 'run', 'exec', 'x', 'install', 'ci', 'pack', 'pm', 'link',
]);

export function sanitizePackageManagerArgs(
  bin: string,
  args: string[],
): SanitizeArgsResult {
  const base = sanitizeCommandArgs(args);
  if (!base.ok) return base;
  if (!['npm', 'npx', 'bun', 'yarn', 'pnpm'].includes(bin)) return base;

  if (args.length === 0) {
    return { ok: false, error: `${bin} requires a subcommand` };
  }

  // bun test / vitest-style
  if (bin === 'bun' && args[0] === 'test') return base;
  if (bin === 'npx') return base;

  const sub = args[0];
  if (!PKG_SAFE_SUB.has(sub)) {
    return {
      ok: false,
      error: `${bin} subcommand "${sub}" not allowed (allowed: ${[...PKG_SAFE_SUB].join(', ')}, test)`,
    };
  }

  // After `--`, still reject metachar (already in sanitizeCommandArgs).
  // Deny nested script names that look like shell.
  if (args.includes('--')) {
    return {
      ok: false,
      error: `${bin}: forwarding args after "--" is blocked`,
    };
  }
  return base;
}

const PKG_BINS = new Set(['npm', 'npx', 'bun', 'yarn', 'pnpm']);

/** Subcommands that pull/network-install packages (postinstall risk). */
const DANGEROUS_PKG_SUB = new Set(['install', 'ci', 'i']);

/**
 * True for package-manager install/ci (and short `i` / yarn|pnpm `add`).
 * `bun run test` / `npm test` / `git …` / generic `npx …` are NOT dangerous.
 */
export function isDangerousPackageCommand(bin: string, args: string[]): boolean {
  const b = bin.trim().toLowerCase();
  if (!PKG_BINS.has(b)) return false;

  const sub = args.find(a => a.length > 0 && !a.startsWith('-'));
  if (!sub) return false;
  const s = sub.toLowerCase();
  if (DANGEROUS_PKG_SUB.has(s)) return true;
  // yarn/pnpm: `add` is install-equivalent
  if ((b === 'yarn' || b === 'pnpm') && s === 'add') return true;
  return false;
}
