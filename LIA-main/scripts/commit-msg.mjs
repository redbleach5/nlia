#!/usr/bin/env node
// ============================================================================
// commit-msg.mjs — LLM-powered Conventional Commits message generator.
// ============================================================================
//
// Generates commit messages from staged changes using a local Ollama model.
// Falls back to a deterministic heuristic if Ollama is unavailable or if the
// LLM output doesn't conform to Conventional Commits format.
//
// Why local Ollama (not cloud):
//   - Source code may contain secrets/PII that should not leave the machine
//   - Zero cost per invocation
//   - Works offline (e.g. on a plane)
//
// Usage:
//   node scripts/commit-msg.mjs                # print message, don't commit
//   node scripts/commit-msg.mjs --commit       # stage all + commit with msg
//   node scripts/commit-msg.mjs --amend        # regenerate msg for last commit
//   node scripts/commit-msg.mjs --lang=en      # English message (default: ru)
//   OLLAMA_MODEL=qwen3:8b node scripts/commit-msg.mjs
//
// Output format (Conventional Commits 1.0.0):
//   type(scope): subject
//
//   optional body paragraph
//
// Supported types: feat, fix, refactor, docs, test, chore, perf, style, build, ci, security
// Scope auto-detected from package.json name + affected top-level dirs.
//
// Exit codes:
//   0 — message generated (and committed if --commit)
//   1 — no staged changes
//   2 — Ollama error AND fallback failed
//   3 — invalid CLI args

import { execSync, spawnSync } from 'child_process';
import { readFileSync, existsSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { getEffectiveOllamaSettings } from './lib/effective-ollama.mjs';

// ── Args ──
const args = process.argv.slice(2);
const doCommit = args.includes('--commit');
const doAmend = args.includes('--amend');
const langArg = args.find(a => a.startsWith('--lang='));
const lang = langArg ? langArg.slice(7) : 'ru';

if (doCommit && doAmend) {
  console.error('✗ Cannot use --commit and --amend together');
  process.exit(3);
}

const PROJECT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const effective = getEffectiveOllamaSettings(PROJECT_DIR);
// Explicit shell env wins for one-shot overrides (OLLAMA_BASE_URL=… node …).
const BASE_URL = process.env.OLLAMA_BASE_URL || effective.baseUrl;
const MODEL = process.env.OLLAMA_COMMIT_MODEL || process.env.OLLAMA_MODEL || effective.model;

// ── Git helpers ──
function git(args) {
  return execSync(`git ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function getStagedDiff() {
  try {
    return git('diff --cached --no-color');
  } catch {
    return '';
  }
}

function getStagedFiles() {
  try {
    return git('diff --cached --name-only').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function getRepoName() {
  try {
    const url = git('config --get remote.origin.url');
    // git@github.com:user/repo.git → repo
    // https://github.com/user/repo.git → repo
    const m = url.match(/[/:]([^/]+?)(\.git)?$/);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

function detectScope(files) {
  if (files.length === 0) return null;
  // Map top-level dirs/files to conventional scopes
  const topDirs = new Set();
  for (const f of files) {
    const parts = f.split('/');
    if (parts.length === 1) {
      // root file — use filename without extension
      topDirs.add(parts[0].replace(/\.[^.]+$/, ''));
    } else {
      topDirs.add(parts[0]);
    }
  }
  // Common Lia-v2 scopes
  const knownScopes = {
    'src': null,  // too generic, fall through
    'lib': null,
    'components': 'ui',
    'app': 'api',
    'tests': 'test',
    'docs': 'docs',
    'scripts': 'scripts',
    'prisma': 'db',
    'public': 'assets',
  };
  // If all files under one top-level dir → use its scope
  if (topDirs.size === 1) {
    const dir = [...topDirs][0];
    if (knownScopes[dir] !== undefined) return knownScopes[dir];
    return dir;
  }
  // Multiple dirs — pick the most common
  const counts = {};
  for (const f of files) {
    const d = f.split('/')[0];
    counts[d] = (counts[d] || 0) + 1;
  }
  const top = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  if (top && knownScopes[top[0]] !== undefined) return knownScopes[top[0]];
  return top ? top[0] : null;
}

function detectType(diff, files) {
  const combined = (diff + ' ' + files.join(' ')).toLowerCase();
  if (/fix|bug|broken|crash|error\b|regression/.test(combined)) return 'fix';
  if (/test|spec|vitest|jest/.test(combined)) return 'test';
  if (/\.md$|docs?\/|readme|changelog/.test(combined)) return 'docs';
  if (/refactor|cleanup|simplify|remove dead/.test(combined)) return 'refactor';
  if (/package\.json|tsconfig|eslint|prettier|\.mjs$|webpack|vite/.test(combined)) return 'build';
  if (/\.ya?ml$|github\/workflows|ci\b/.test(combined)) return 'ci';
  if (/security|vulnerab|cve-|injection|xss|csrf/.test(combined)) return 'security';
  if (/perf|optimi[sz]e|speed|faster|cache/.test(combined)) return 'perf';
  if (/style|format|prettier|eslint.*fix|whitespace/.test(combined)) return 'style';
  if (/feat|add|new|implement|support/.test(combined)) return 'feat';
  if (/chore|bump|update.*deps|upgrade/.test(combined)) return 'chore';
  return 'feat';  // default
}

// ── Ollama call ──
async function callOllama(prompt) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const res = await fetch(`${BASE_URL}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        stream: false,
        messages: [
          {
            role: 'system',
            content: `You are a commit message generator following Conventional Commits 1.0.0.
Output EXACTLY one commit message, no preamble, no quotes, no markdown.

Format:
<type>(<scope>): <subject>

<optional body, 1-2 paragraphs, wrapped at 72 chars>

Rules:
- Subject line ≤ 72 chars, lowercase, no period at end, imperative mood ("add" not "added")
- type ∈ {feat, fix, refactor, docs, test, chore, perf, style, build, ci, security}
- scope is optional but preferred — single word from: api, agent, kb, db, vrm, ui, memory, chat, test, docs, scripts
- Body explains WHY (not WHAT — diff shows what). Wrap at 72 chars.
- Language: ${lang === 'ru' ? 'Russian for subject and body. Latin terms (feat, fix, scope) stay in English.' : 'English.'}
- Do NOT mention "Generated by AI" or similar meta-commentary`,
          },
          { role: 'user', content: prompt },
        ],
        options: {
          temperature: 0.3,
          top_p: 0.9,
          num_predict: 400,
        },
      }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }
    const data = await res.json();
    return data.message?.content?.trim() ?? '';
  } finally {
    clearTimeout(t);
  }
}

// ── Validation ──
const VALID_TYPES = new Set(['feat', 'fix', 'refactor', 'docs', 'test', 'chore', 'perf', 'style', 'build', 'ci', 'security']);
const COMMIT_RE = /^(feat|fix|refactor|docs|test|chore|perf|style|build|ci|security)(\([^)]+\))?: .{1,72}$/;

function isValidCommitMessage(msg) {
  const firstLine = msg.split('\n')[0];
  return COMMIT_RE.test(firstLine);
}

// ── Fallback (deterministic, no LLM) ──
function fallbackMessage(diff, files, scope) {
  const type = detectType(diff, files);
  // Build a subject from the most common file action
  const added = files.filter(f => !existsSync(resolve(process.cwd(), f)) || diff.includes(`+++ b/${f}`)).length;
  const modified = files.length - added;
  let verb;
  if (added > modified * 2) verb = 'add';
  else if (modified > added * 2) verb = 'update';
  else verb = 'change';

  const fileDesc = files.length === 1
    ? files[0].split('/').pop()
    : `${files.length} files`;

  const subject = `${verb} ${fileDesc}`;
  const scopeStr = scope ? `(${scope})` : '';
  return `${type}${scopeStr}: ${subject}\n\nFiles changed:\n${files.slice(0, 10).map(f => `- ${f}`).join('\n')}${files.length > 10 ? `\n- ... and ${files.length - 10} more` : ''}`;
}

// ── Main ──
async function main() {
  // For --amend, use the previous commit's diff
  let diff, files;
  if (doAmend) {
    try {
      diff = git('diff HEAD~1 --no-color');
      files = git('diff HEAD~1 --name-only').split('\n').filter(Boolean);
    } catch {
      console.error('✗ Cannot get previous commit (HEAD~1 missing?)');
      process.exit(1);
    }
  } else {
    diff = getStagedDiff();
    files = getStagedFiles();
  }

  if (files.length === 0) {
    console.error('✗ No staged changes. Use `git add` first, or --amend to regenerate last commit message.');
    process.exit(1);
  }

  if (diff.length === 0) {
    console.error('✗ Staged files but empty diff (binary files only?)');
    process.exit(1);
  }

  // Truncate diff to avoid Ollama context overflow (~8K tokens for 7B model)
  const MAX_DIFF_CHARS = 24_000;  // ~6K tokens
  const truncatedDiff = diff.length > MAX_DIFF_CHARS
    ? diff.slice(0, MAX_DIFF_CHARS) + `\n\n... [diff truncated, ${diff.length - MAX_DIFF_CHARS} more chars]`
    : diff;

  const scope = detectScope(files);
  const repoName = getRepoName();
  const fallback = fallbackMessage(diff, files, scope);

  console.error(`Generating commit message for ${files.length} file(s)${scope ? `, scope=${scope}` : ''}...`);
  console.error(`Repo: ${repoName ?? 'unknown'}\n`);

  let message = null;
  try {
    const prompt = `Repository: ${repoName ?? 'unknown'}
Detected scope: ${scope ?? 'none'}
Staged files (${files.length}):
${files.map(f => `- ${f}`).join('\n')}

Staged diff:
\`\`\`diff
${truncatedDiff}
\`\`\`

Generate a Conventional Commits message for these changes.`;

    const llmOutput = await callOllama(prompt);
    if (isValidCommitMessage(llmOutput)) {
      message = llmOutput;
      console.error('✓ LLM-generated message');
    } else {
      console.error(`⚠ LLM output invalid format, using fallback.`);
      console.error(`  First line: ${llmOutput.split('\n')[0].slice(0, 80)}`);
    }
  } catch (e) {
    console.error(`⚠ Ollama unavailable (${e.message}), using deterministic fallback.`);
    console.error(`  Make sure 'ollama serve' is running and model '${MODEL}' is pulled.`);
  }

  if (!message) {
    message = fallback;
    console.error('✓ Fallback message');
  }

  // Print to stdout (so users can pipe: `bun run commit:msg | git commit -F -`)
  console.log(message);

  // If --commit, also stage everything (per user request) and commit
  if (doCommit && !doAmend) {
    console.error('\n--- Committing ---');
    const result = spawnSync('git', ['commit', '-m', message], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('✗ git commit failed');
      process.exit(2);
    }
    console.error('✓ Committed');
  } else if (doAmend) {
    console.error('\n--- Amending last commit ---');
    const result = spawnSync('git', ['commit', '--amend', '-m', message], { stdio: 'inherit' });
    if (result.status !== 0) {
      console.error('✗ git commit --amend failed');
      process.exit(2);
    }
    console.error('✓ Amended');
  }
}

main().catch((e) => {
  console.error('Unexpected error:', e);
  process.exit(2);
});
