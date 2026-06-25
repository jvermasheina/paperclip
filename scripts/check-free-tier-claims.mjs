#!/usr/bin/env node
// STOA-718 — Free-tier claim CI grep-gate.
//
// Scans agent-config files (AGENTS.md / HEARTBEAT.md / SOUL.md / TOOLS.md
// under `instances/*/companies/*/agents/*/instructions/` and
// `agents/*/AGENTS.md` in any repo) for unverified "free-tier model" /
// "costs nothing" / etc. claims that have historically propagated unchecked
// (see Reitti €141 incident, STOA-689 Q7).
//
// A file containing any forbidden substring MUST also contain BOTH:
//   - `# Approved-by: <approval-id>` line citing a request_board_approval id
//   - `# Cost-audit-cadence: <monthly|quarterly>` line declaring re-audit cadence
//
// Missing pair => exit 1 with file:line + remediation steps.
//
// Usage:
//   node scripts/check-free-tier-claims.mjs            # default scan paths
//   node scripts/check-free-tier-claims.mjs --paths a.md b.md ...
//
// Exit codes: 0 ok, 1 violation, 2 usage error.

import { readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const FORBIDDEN_PHRASES = [
  'free-tier',
  'free model',
  'free tier',
  'local free',
  'costs nothing',
  'no marginal cost',
  'costs zero',
  'at no cost',
];

// Word-boundary aware regex per phrase. Phrases containing `-` use a
// custom boundary because `\b` does not match the inside of `free-tier`
// the way we want — we treat the whole phrase as a unit and require the
// chars immediately before/after to be non-word OR string boundary.
function buildPhraseRegex(phrase) {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(^|[^A-Za-z0-9])(${escaped})($|[^A-Za-z0-9])`, 'i');
}

const PHRASE_REGEXES = FORBIDDEN_PHRASES.map((phrase) => ({
  phrase,
  regex: buildPhraseRegex(phrase),
}));

const APPROVED_BY_RE = /^#\s*Approved-by:\s*\S+/im;
const CADENCE_RE = /^#\s*Cost-audit-cadence:\s*(monthly|quarterly)\b/im;

// Lines that are themselves the lint specification (forbidden phrases list,
// docstring, comments documenting the rule) are not real claims. We exempt
// any file that declares `# Free-tier-claim-lint: spec` at the top — this
// is how the lint script itself, its tests, and the issue spec exclude
// themselves without weakening the gate.
const SPEC_DECLARATION_RE = /^#\s*Free-tier-claim-lint:\s*spec\b/im;

export function findForbiddenHits(content) {
  const lines = content.split(/\r?\n/);
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    for (const { phrase, regex } of PHRASE_REGEXES) {
      if (regex.test(line)) {
        hits.push({ lineNumber: i + 1, line, phrase });
        break;
      }
    }
  }
  return hits;
}

export function hasApprovedByLine(content) {
  return APPROVED_BY_RE.test(content);
}

export function hasCadenceLine(content) {
  return CADENCE_RE.test(content);
}

export function isSpecFile(content) {
  return SPEC_DECLARATION_RE.test(content);
}

export function auditFileContent(filePath, content) {
  if (isSpecFile(content)) {
    return { filePath, status: 'spec-exempt', hits: [], missing: [] };
  }
  const hits = findForbiddenHits(content);
  if (hits.length === 0) {
    return { filePath, status: 'clean', hits: [], missing: [] };
  }
  const missing = [];
  if (!hasApprovedByLine(content)) missing.push('Approved-by');
  if (!hasCadenceLine(content)) missing.push('Cost-audit-cadence');
  return {
    filePath,
    status: missing.length === 0 ? 'paired' : 'violation',
    hits,
    missing,
  };
}

// The instructions-file surface is one of two shapes:
//   1. Live agent runtime — `instances/<env>/companies/<co>/agents/<id>/instructions/<NAME>.md`
//   2. Repo-side agent templates — any AGENTS.md / HEARTBEAT.md / SOUL.md /
//      TOOLS.md anywhere in the repo (vibe-skill keeps them under
//      `agents/<role>/`, Paperclip keeps them under e.g.
//      `server/src/onboarding-assets/` and `packages/plugins/.../agents/`).
//
// Rather than enumerate every repo's flavour, we recursively scan for the
// four canonical filenames and rely on EXCLUDE_DIRS to skip vendored noise.
const INSTRUCTION_FILE_NAMES = new Set([
  'AGENTS.md',
  'HEARTBEAT.md',
  'SOUL.md',
  'TOOLS.md',
]);
const EXCLUDE_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  'dist',
  'build',
  '.turbo',
  '.cache',
  '.pnpm-store',
]);

async function walkInstructionFiles(rootDir) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  async function visit(dir) {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue;
        await visit(path.join(dir, entry.name));
      } else if (entry.isFile() && INSTRUCTION_FILE_NAMES.has(entry.name)) {
        out.push(path.join(dir, entry.name));
      }
    }
  }
  await visit(rootDir);
  return out.sort();
}

export async function resolveDefaultPaths(rootDir) {
  return walkInstructionFiles(rootDir);
}

function parseArgs(argv) {
  const args = { paths: null, rootDir: process.cwd(), json: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--paths') {
      args.paths = [];
      while (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
        i += 1;
        args.paths.push(argv[i]);
      }
    } else if (arg === '--root') {
      i += 1;
      args.rootDir = argv[i];
    } else if (arg === '--json') {
      args.json = true;
    } else if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else {
      args.unknown = arg;
    }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: check-free-tier-claims [--root <dir>] [--paths file ...] [--json]

Scans agent-config files for unverified "free-tier" / "costs nothing" claims.
A file with any forbidden phrase MUST also contain BOTH:
  # Approved-by: <approval-id>
  # Cost-audit-cadence: <monthly|quarterly>

Without --paths, recursively scans --root (cwd by default) for any of
AGENTS.md / HEARTBEAT.md / SOUL.md / TOOLS.md, skipping common vendored
dirs (node_modules, .git, dist, build, .next, .turbo, .cache).

Exit codes: 0 ok, 1 violation, 2 usage error.`);
}

export async function runCli(argv = process.argv.slice(2), { stdout = process.stdout, stderr = process.stderr } = {}) {
  const args = parseArgs(argv);
  if (args.help) {
    printHelp();
    return 0;
  }
  if (args.unknown) {
    stderr.write(`unknown argument: ${args.unknown}\n`);
    return 2;
  }
  let targets = args.paths;
  if (!targets) {
    targets = await resolveDefaultPaths(args.rootDir);
  }
  const results = [];
  for (const filePath of targets) {
    if (!existsSync(filePath)) {
      stderr.write(`skip (not found): ${filePath}\n`);
      continue;
    }
    const s = await stat(filePath);
    if (!s.isFile()) continue;
    const content = await readFile(filePath, 'utf8');
    results.push(auditFileContent(filePath, content));
  }
  const violations = results.filter((r) => r.status === 'violation');
  if (args.json) {
    stdout.write(`${JSON.stringify({ scanned: results.length, violations }, null, 2)}\n`);
  } else {
    stdout.write(`Scanned ${results.length} file(s).\n`);
    if (violations.length === 0) {
      stdout.write('OK — no free-tier-claim violations.\n');
    }
  }
  if (violations.length > 0) {
    if (!args.json) {
      stderr.write('\n');
      stderr.write('ERROR: Free-tier-claim gate violated (STOA-718).\n');
      stderr.write('\n');
      for (const v of violations) {
        for (const hit of v.hits) {
          stderr.write(`${v.filePath}:${hit.lineNumber}: forbidden phrase "${hit.phrase}"\n`);
          stderr.write(`  > ${hit.line.trim()}\n`);
        }
        stderr.write(`  missing: ${v.missing.join(' + ')}\n`);
        stderr.write('\n');
      }
      stderr.write('Remediation:\n');
      stderr.write('  1. Rephrase to neutral language that does NOT assert tier/cost claims, OR\n');
      stderr.write('  2. Add BOTH lines anywhere in the file:\n');
      stderr.write('       # Approved-by: <request_board_approval id>\n');
      stderr.write('       # Cost-audit-cadence: <monthly|quarterly>\n');
      stderr.write('\n');
      stderr.write('Background: https://app.paperclip.ing/STOA/issues/STOA-718\n');
    }
    return 1;
  }
  return 0;
}

const invokedDirectly = (() => {
  const arg1 = process.argv[1];
  if (!arg1) return false;
  try {
    return import.meta.url === pathToFileURL(arg1).href;
  } catch {
    return false;
  }
})();

if (invokedDirectly) {
  // eslint-disable-next-line unicorn/prefer-top-level-await
  runCli().then((code) => process.exit(code)).catch((err) => {
    process.stderr.write(`unexpected error: ${err?.stack ?? err}\n`);
    process.exit(3);
  });
}

// Re-export the resolved CLI path for test harnesses.
export const SCRIPT_PATH = fileURLToPath(import.meta.url);
