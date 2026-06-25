// STOA-718 — tests for the free-tier-claim CI grep-gate.
//
// # Free-tier-claim-lint: spec
// (^ this declaration exempts THIS file from its own gate; without it, the
// inline forbidden-phrase fixtures below would self-trip when the gate
// scans the scripts/ tree.)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Writable } from 'node:stream';

import {
  FORBIDDEN_PHRASES,
  findForbiddenHits,
  hasApprovedByLine,
  hasCadenceLine,
  isSpecFile,
  auditFileContent,
  resolveDefaultPaths,
  runCli,
} from './check-free-tier-claims.mjs';

function bufferStream() {
  const chunks = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(Buffer.from(chunk));
      cb();
    },
  });
  stream.getString = () => Buffer.concat(chunks).toString('utf8');
  return stream;
}

test('FORBIDDEN_PHRASES matches the STOA-718 spec list verbatim', () => {
  assert.deepEqual(FORBIDDEN_PHRASES, [
    'free-tier',
    'free model',
    'free tier',
    'local free',
    'costs nothing',
    'no marginal cost',
    'costs zero',
    'at no cost',
  ]);
});

test('each forbidden phrase is detected case-insensitively, word-bounded', () => {
  // Carrier text per phrase, chosen so the phrase under test is the ONLY
  // forbidden substring present (e.g. "local free" must not also contain
  // "free model" or "free tier").
  const carriers = {
    'free-tier': 'Runs on the FREE-TIER plan.',
    'free model': 'Runs on the FREE MODEL today.',
    'free tier': 'Runs on the FREE TIER plan.',
    'local free': 'Stays LOCAL FREE of remote calls.',
    'costs nothing': 'It COSTS NOTHING.',
    'no marginal cost': 'There is NO MARGINAL COST.',
    'costs zero': 'It COSTS ZERO.',
    'at no cost': 'Runs AT NO COST.',
  };
  for (const phrase of FORBIDDEN_PHRASES) {
    const body = `${carriers[phrase]}\n`;
    const hits = findForbiddenHits(body);
    assert.equal(hits.length, 1, `expected one hit for "${phrase}", got ${JSON.stringify(hits)}`);
    assert.equal(hits[0].phrase, phrase);
  }
});

test('phrases embedded in a longer word do NOT trigger a hit', () => {
  // "freetier" with no separator is NOT a hit (word boundary).
  const body = 'unfreetiered nonsense costsnothingmuch.\n';
  assert.deepEqual(findForbiddenHits(body), []);
});

test('hasApprovedByLine / hasCadenceLine recognise the pair', () => {
  const body = `# Approved-by: req_abc123\n# Cost-audit-cadence: monthly\n`;
  assert.equal(hasApprovedByLine(body), true);
  assert.equal(hasCadenceLine(body), true);
});

test('cadence accepts monthly or quarterly only', () => {
  assert.equal(hasCadenceLine('# Cost-audit-cadence: monthly\n'), true);
  assert.equal(hasCadenceLine('# Cost-audit-cadence: quarterly\n'), true);
  assert.equal(hasCadenceLine('# Cost-audit-cadence: yearly\n'), false);
  assert.equal(hasCadenceLine('# Cost-audit-cadence: never\n'), false);
});

test('auditFileContent — clean file', () => {
  const r = auditFileContent('clean.md', '# Hello\nNothing to see.\n');
  assert.equal(r.status, 'clean');
  assert.equal(r.hits.length, 0);
});

test('auditFileContent — paired file (forbidden phrase + both pair lines) passes', () => {
  const body = [
    '# Title',
    'The agent uses the local free-tier model.',
    '',
    '# Approved-by: req_2026_06_15_xyz',
    '# Cost-audit-cadence: monthly',
    '',
  ].join('\n');
  const r = auditFileContent('paired.md', body);
  assert.equal(r.status, 'paired');
  assert.equal(r.missing.length, 0);
  assert.equal(r.hits.length, 1);
  assert.equal(r.hits[0].phrase, 'free-tier');
});

test('auditFileContent — violation: forbidden phrase without either pair line', () => {
  const body = 'Runs at no cost on the local free tier.\n';
  const r = auditFileContent('bad.md', body);
  assert.equal(r.status, 'violation');
  assert.deepEqual(r.missing, ['Approved-by', 'Cost-audit-cadence']);
  assert.ok(r.hits.length >= 1);
});

test('auditFileContent — violation: forbidden phrase with ONLY Approved-by', () => {
  const body = 'Costs nothing.\n# Approved-by: req_x\n';
  const r = auditFileContent('half1.md', body);
  assert.equal(r.status, 'violation');
  assert.deepEqual(r.missing, ['Cost-audit-cadence']);
});

test('auditFileContent — violation: forbidden phrase with ONLY Cost-audit-cadence', () => {
  const body = 'Costs zero.\n# Cost-audit-cadence: quarterly\n';
  const r = auditFileContent('half2.md', body);
  assert.equal(r.status, 'violation');
  assert.deepEqual(r.missing, ['Approved-by']);
});

test('isSpecFile detects the exempt header', () => {
  assert.equal(isSpecFile('# Free-tier-claim-lint: spec\nfree tier blah\n'), true);
  assert.equal(isSpecFile('No header here.\n'), false);
});

test('auditFileContent — spec-exempt files are skipped', () => {
  const body = '# Free-tier-claim-lint: spec\n\nfree-tier free model costs nothing\n';
  const r = auditFileContent('lint-spec.md', body);
  assert.equal(r.status, 'spec-exempt');
});

async function makeFixtureTree() {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'free-tier-fixture-'));
  // agents/<x>/AGENTS.md surface
  await mkdir(path.join(dir, 'agents', 'alpha'), { recursive: true });
  await mkdir(path.join(dir, 'agents', 'beta'), { recursive: true });
  await writeFile(
    path.join(dir, 'agents', 'alpha', 'AGENTS.md'),
    'Plain neutral copy here.\n',
    'utf8',
  );
  await writeFile(
    path.join(dir, 'agents', 'beta', 'AGENTS.md'),
    'Beta runs on free model.\n',
    'utf8',
  );
  // instances/.../instructions/ surface
  const instDir = path.join(
    dir,
    'instances',
    'default',
    'companies',
    'co-1',
    'agents',
    'agent-1',
    'instructions',
  );
  await mkdir(instDir, { recursive: true });
  await writeFile(
    path.join(instDir, 'AGENTS.md'),
    [
      'Verifier runs on the local free-tier model.',
      '# Approved-by: req_2026_06_25_test',
      '# Cost-audit-cadence: monthly',
      '',
    ].join('\n'),
    'utf8',
  );
  await writeFile(path.join(instDir, 'HEARTBEAT.md'), 'neutral copy\n', 'utf8');
  return dir;
}

test('resolveDefaultPaths picks up the expected glob surface', async () => {
  const dir = await makeFixtureTree();
  try {
    const paths = await resolveDefaultPaths(dir);
    const rel = paths.map((p) => path.relative(dir, p)).sort();
    assert.deepEqual(rel, [
      'agents/alpha/AGENTS.md',
      'agents/beta/AGENTS.md',
      'instances/default/companies/co-1/agents/agent-1/instructions/AGENTS.md',
      'instances/default/companies/co-1/agents/agent-1/instructions/HEARTBEAT.md',
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCli exits 1 and prints a violation report for unannotated files', async () => {
  const dir = await makeFixtureTree();
  const stdout = bufferStream();
  const stderr = bufferStream();
  try {
    const code = await runCli(['--root', dir], { stdout, stderr });
    assert.equal(code, 1);
    const errOut = stderr.getString();
    assert.match(errOut, /STOA-718/);
    assert.match(errOut, /agents\/beta\/AGENTS\.md:1/);
    assert.match(errOut, /forbidden phrase "free model"/);
    // The paired file should NOT appear in violations.
    assert.doesNotMatch(errOut, /companies\/co-1\/agents\/agent-1\/instructions\/AGENTS\.md:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCli exits 0 when the only forbidden hits are properly paired', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'free-tier-clean-'));
  const instDir = path.join(
    dir,
    'instances',
    'default',
    'companies',
    'co-1',
    'agents',
    'agent-1',
    'instructions',
  );
  await mkdir(instDir, { recursive: true });
  await writeFile(
    path.join(instDir, 'AGENTS.md'),
    [
      'Verifier runs on a local free-tier model.',
      '# Approved-by: req_2026_06_25_clean',
      '# Cost-audit-cadence: quarterly',
      '',
    ].join('\n'),
    'utf8',
  );
  const stdout = bufferStream();
  const stderr = bufferStream();
  try {
    const code = await runCli(['--root', dir], { stdout, stderr });
    assert.equal(code, 0, `expected pass; stderr was:\n${stderr.getString()}`);
    assert.match(stdout.getString(), /OK — no free-tier-claim violations/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCli with --paths only scans the given files', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'free-tier-paths-'));
  const bad = path.join(dir, 'bad.md');
  const good = path.join(dir, 'good.md');
  await writeFile(bad, 'this has no marginal cost.\n', 'utf8');
  await writeFile(good, 'neutral content.\n', 'utf8');
  const stdout = bufferStream();
  const stderr = bufferStream();
  try {
    const code = await runCli(['--paths', good], { stdout, stderr });
    assert.equal(code, 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('runCli --json emits structured output and still exits 1 on violation', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'free-tier-json-'));
  const bad = path.join(dir, 'bad.md');
  await writeFile(bad, 'costs zero. great deal.\n', 'utf8');
  const stdout = bufferStream();
  const stderr = bufferStream();
  try {
    const code = await runCli(['--paths', bad, '--json'], { stdout, stderr });
    assert.equal(code, 1);
    const parsed = JSON.parse(stdout.getString());
    assert.equal(parsed.scanned, 1);
    assert.equal(parsed.violations.length, 1);
    assert.equal(parsed.violations[0].hits[0].phrase, 'costs zero');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
