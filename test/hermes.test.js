import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function parseFixture(t, { values, cacheWrite = true, profile = '' }) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-hermes-test-'));
  const dbDir = profile ? join(root, 'profiles', profile) : root;
  mkdirSync(dbDir, { recursive: true });
  const dbPath = join(dbDir, 'state.db');
  const previous = process.env.HERMES_HOME;
  t.after(() => {
    if (previous === undefined) delete process.env.HERMES_HOME;
    else process.env.HERMES_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  });
  const sql = `
    CREATE TABLE sessions (
      id TEXT, model TEXT, started_at REAL, input_tokens INTEGER,
      output_tokens INTEGER, cache_read_tokens INTEGER, reasoning_tokens INTEGER
      ${cacheWrite ? ', cache_write_tokens INTEGER' : ''}
    );
    CREATE TABLE messages (session_id TEXT, role TEXT, timestamp REAL, content TEXT);
    INSERT INTO sessions VALUES ('test-session', 'test-model', 1788764700, ${values.join(',')});
    INSERT INTO messages VALUES ('test-session', 'user', 1788764700, 'unused prompt');
    INSERT INTO messages VALUES ('test-session', 'assistant', 1788764720, 'unused reply');
  `;
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); } catch { /* Node 20 uses sqlite3. */ }
  if (DatabaseSync) {
    const db = new DatabaseSync(dbPath);
    try { db.exec(sql); } finally { db.close(); }
  } else {
    execFileSync('sqlite3', [dbPath, sql]);
  }
  process.env.HERMES_HOME = root;
  const { parse } = await import(`../src/parsers/hermes.js?fixture=${encodeURIComponent(root)}`);
  return parse();
}

test('Hermes preserves provider totals while separating inclusive reasoning and cache writes', async (t) => {
  const result = await parseFixture(t, { values: [48783, 1232, 100, 422, 50] });
  assert.equal(result.buckets.length, 1);
  const bucket = result.buckets[0];
  assert.equal(bucket.inputTokens, 48833);
  assert.equal(bucket.outputTokens, 810);
  assert.equal(bucket.reasoningOutputTokens, 422);
  assert.equal(bucket.cachedInputTokens, 100);
  assert.equal(bucket.totalTokens, 50065);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].messageCount, 2);
});

test('Hermes reads legacy schemas without a cache-write column', async (t) => {
  const result = await parseFixture(t, { cacheWrite: false, values: [100, 20, 40, 5] });
  assert.equal(result.buckets[0].inputTokens, 100);
  assert.equal(result.buckets[0].outputTokens, 15);
  assert.equal(result.buckets[0].reasoningOutputTokens, 5);
  assert.equal(result.buckets[0].totalTokens, 120);
});

test('Hermes includes cache-only usage in named profiles', async (t) => {
  const result = await parseFixture(t, { profile: 'work', values: [0, 0, 100, 0, 20] });
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].project, 'work');
  assert.equal(result.buckets[0].cachedInputTokens, 100);
  assert.equal(result.buckets[0].inputTokens, 20);
  assert.equal(result.buckets[0].totalTokens, 20);
});

test('Hermes bounds inconsistent reasoning counters by total output', async (t) => {
  const result = await parseFixture(t, { values: [100, 20, 0, 99, 0] });
  assert.equal(result.buckets[0].outputTokens, 0);
  assert.equal(result.buckets[0].reasoningOutputTokens, 20);
  assert.equal(result.buckets[0].totalTokens, 120);
});
