import { test } from 'node:test';
import assert from 'node:assert';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import {
  listDbCascades,
  parseGenMetadataBlob,
  parseStepMetadata,
  parseStepTimestamp,
  readDbSessionEvents,
  readDbStepTimestamps,
  readDbUsageRecords,
  readDbWorkspaceUri,
  resolveUsageTimestamp,
} from '../src/parsers/antigravity-db.js';
import { parse, parseWinProcessList } from '../src/parsers/antigravity.js';
import { antigravityConversationDirs, validateExtraRoot } from '../src/extra-roots.js';
import { findAntigravityDataDirs } from '../src/tools.js';

// ── Minimal protobuf encoder (mirrors the wire format the decoder reads) ──
function varint(n) {
  const bytes = [];
  let v = BigInt(n);
  do {
    let b = Number(v & 0x7fn);
    v >>= 7n;
    if (v > 0n) b |= 0x80;
    bytes.push(b);
  } while (v > 0n);
  return Buffer.from(bytes);
}
const tag = (num, wire) => varint((num << 3) | wire);
const vfield = (num, val) => Buffer.concat([tag(num, 0), varint(val)]);
const lfield = (num, buf) => Buffer.concat([tag(num, 2), varint(buf.length), buf]);
const sfield = (num, str) => lfield(num, Buffer.from(str, 'utf-8'));

// Build a GeneratorMetadata blob: chatModel(1) { usage(4), chatStartMetadata(9),
// responseModel(19), modelDisplayName(21) }. Tag numbers cross-verified against
// the language server's GetCascadeTrajectory JSON.
function buildBlob({ input, output, cache, thinking, responseId, seconds, responseModel, displayName }) {
  const usageParts = [];
  if (input != null) usageParts.push(vfield(2, input));
  if (output != null) usageParts.push(vfield(3, output));
  if (cache != null) usageParts.push(vfield(5, cache));
  if (thinking != null) usageParts.push(vfield(9, thinking));
  if (responseId != null) usageParts.push(sfield(11, responseId));

  const chatModelParts = [];
  if (usageParts.length) chatModelParts.push(lfield(4, Buffer.concat(usageParts)));
  if (seconds != null) chatModelParts.push(lfield(9, lfield(4, vfield(1, seconds))));
  if (responseModel != null) chatModelParts.push(sfield(19, responseModel));
  if (displayName != null) chatModelParts.push(sfield(21, displayName));

  return lfield(1, Buffer.concat(chatModelParts));
}

test('parseGenMetadataBlob extracts token usage and the real display name', () => {
  const blob = buildBlob({
    input: 5528, output: 192, cache: 24481, thinking: 142,
    responseId: 'RESP_1', seconds: 1783484082,
    responseModel: 'gemini-3-flash-a', displayName: 'Gemini 3.5 Flash (High)',
  });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.inputTokens, 5528);
  assert.equal(r.outputTokens, 192);
  assert.equal(r.cacheReadTokens, 24481);
  assert.equal(r.thinkingOutputTokens, 142);
  assert.equal(r.responseId, 'RESP_1');
  assert.equal(r.responseModel, 'gemini-3-flash-a');
  assert.equal(r.displayName, 'Gemini 3.5 Flash (High)');
  assert.equal(r.timestamp.getTime(), 1783484082 * 1000);
});

test('parseGenMetadataBlob keeps the CLI display name even when responseModel is generic', () => {
  // CLI writes responseModel="gemini-default" (useless) but a real displayName.
  const blob = buildBlob({
    input: 1000, output: 50, seconds: 1783484000,
    responseModel: 'gemini-default', displayName: 'Gemini 3.5 Flash (Medium)',
  });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.displayName, 'Gemini 3.5 Flash (Medium)');
  assert.equal(r.responseModel, 'gemini-default');
});

test('parseGenMetadataBlob returns null for rows without token usage', () => {
  // Error / planning placeholders carry no usage sub-message.
  const blob = buildBlob({
    seconds: 1783484000, responseModel: 'gemini-default', displayName: 'Gemini 3.5 Flash (Medium)',
  });
  assert.equal(parseGenMetadataBlob(blob), null);
});

test('parseGenMetadataBlob tolerates missing timestamp', () => {
  const blob = buildBlob({ input: 10, output: 5, displayName: 'X' });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.inputTokens, 10);
  assert.equal(r.timestamp, null);
});

test('parseGenMetadataBlob keeps Gemini 3.7 CLI blobs that omit displayName and createdAt', () => {
  // 3.7 CLI writes responseModel (19) and usage (4), but dropped field 21
  // (modelDisplayName) and field 9.4 (chatStartMetadata.createdAt).
  const blob = buildBlob({
    input: 2386023, output: 151615, cache: 48601436, thinking: 88650,
    responseId: 'RESP_37',
    responseModel: 'gemini-3.7-flash-safety-le',
  });
  const r = parseGenMetadataBlob(blob);
  assert.equal(r.inputTokens, 2386023);
  assert.equal(r.outputTokens, 151615);
  assert.equal(r.cacheReadTokens, 48601436);
  assert.equal(r.thinkingOutputTokens, 88650);
  assert.equal(r.responseModel, 'gemini-3.7-flash-safety-le');
  assert.equal(r.displayName, '');
  assert.equal(r.timestamp, null);
});

test('resolveUsageTimestamp prefers blob createdAt then steps.idx join', () => {
  const blobTs = new Date(1787350732000);
  const stepTs = new Date(1787350800000);
  const byIdx = new Map([[7, stepTs]]);
  assert.equal(resolveUsageTimestamp({ timestamp: blobTs, idx: 7 }, byIdx).getTime(), blobTs.getTime());
  assert.equal(resolveUsageTimestamp({ timestamp: null, idx: 7 }, byIdx).getTime(), stepTs.getTime());
  assert.equal(resolveUsageTimestamp({ timestamp: null, idx: 8 }, byIdx), null);
  assert.equal(resolveUsageTimestamp({ timestamp: null }, byIdx), null);
});

// ── Step metadata (session timing) ──
// steps.metadata: createdAt Timestamp at field 1 (seconds=1.1), source enum
// at field 3 (4=user, 2=model). Behavior-verified against payload contents.
function buildStep({ source, seconds }) {
  const parts = [];
  if (seconds != null) parts.push(lfield(1, vfield(1, seconds)));
  if (source != null) parts.push(vfield(3, source));
  return Buffer.concat(parts);
}

test('parseStepMetadata maps source=4 to a user turn', () => {
  const ev = parseStepMetadata(buildStep({ source: 4, seconds: 1783508701 }));
  assert.equal(ev.role, 'user');
  assert.equal(ev.timestamp.getTime(), 1783508701 * 1000);
});

test('parseStepMetadata maps source=2 to an assistant turn', () => {
  const ev = parseStepMetadata(buildStep({ source: 2, seconds: 1783508703 }));
  assert.equal(ev.role, 'assistant');
});

test('parseStepMetadata skips non-user/model sources (system/tool)', () => {
  assert.equal(parseStepMetadata(buildStep({ source: 5, seconds: 1783508701 })), null);
  assert.equal(parseStepMetadata(buildStep({ seconds: 1783508701 })), null); // no source
});

test('offline DB reader loads usage, workspace, and session events', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.skip('node:sqlite is unavailable on this Node version');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-test-'));
  const conversationsDir = join(root, 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  const cascadeId = 'cascade-1';
  const db = new DatabaseSync(join(conversationsDir, `${cascadeId}.db`));
  try {
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER, data BLOB);
      CREATE TABLE trajectory_metadata_blob (data BLOB);
      CREATE TABLE steps (idx INTEGER, metadata BLOB);
    `);
    const usageBlob = buildBlob({
      input: 1000, output: 50, cache: 400, thinking: 25,
      responseId: 'RESP_DB', seconds: 1783484000,
      responseModel: 'gemini-default', displayName: 'Gemini 3.5 Flash (Medium)',
    });
    const workspaceBlob = lfield(1, sfield(1, 'file:///Users/example/project-one'));
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, usageBlob);
    db.prepare('INSERT INTO trajectory_metadata_blob (data) VALUES (?)').run(workspaceBlob);
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(1, buildStep({ source: 4, seconds: 1783484001 }));
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(2, buildStep({ source: 2, seconds: 1783484003 }));
  } finally {
    db.close();
  }

  try {
    assert.deepEqual(listDbCascades(conversationsDir), [cascadeId]);
    const records = readDbUsageRecords(conversationsDir, cascadeId);
    assert.equal(records.length, 1);
    assert.equal(records[0].displayName, 'Gemini 3.5 Flash (Medium)');
    assert.equal(records[0].thinkingOutputTokens, 25);
    assert.equal(readDbWorkspaceUri(conversationsDir, cascadeId), 'file:///Users/example/project-one');
    assert.deepEqual(readDbSessionEvents(conversationsDir, cascadeId).map((event) => event.role), ['user', 'assistant']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Gemini 3.7 CLI usage without blob createdAt is timestamped from steps.idx', async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.skip('node:sqlite is unavailable on this Node version');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-3.7-'));
  const conversationsDir = join(root, 'conversations');
  mkdirSync(conversationsDir, { recursive: true });
  const cascadeId = 'cascade-37';
  const db = new DatabaseSync(join(conversationsDir, `${cascadeId}.db`));
  try {
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER, data BLOB);
      CREATE TABLE steps (idx INTEGER, metadata BLOB);
    `);
    const usageBlob = buildBlob({
      input: 5000, output: 80, cache: 40000, thinking: 12,
      responseId: 'RESP_37_JOIN',
      responseModel: 'gemini-3.7-flash-safety-le',
    });
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(12, usageBlob);
    // source=5 is skipped for session timing but still carries createdAt.
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(12, buildStep({ source: 5, seconds: 1787350732 }));
  } finally {
    db.close();
  }

  try {
    const records = readDbUsageRecords(conversationsDir, cascadeId);
    assert.equal(records.length, 1);
    assert.equal(records[0].idx, 12);
    assert.equal(records[0].timestamp, null);
    assert.equal(records[0].responseModel, 'gemini-3.7-flash-safety-le');

    const stepTs = readDbStepTimestamps(conversationsDir, cascadeId);
    assert.equal(stepTs.get(12).getTime(), 1787350732 * 1000);
    assert.equal(parseStepTimestamp(buildStep({ source: 5, seconds: 1787350732 })).getTime(), 1787350732 * 1000);

    const ts = resolveUsageTimestamp(records[0], stepTs);
    assert.equal(ts.getTime(), 1787350732 * 1000);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

for (const store of ['antigravity-cli', 'antigravity-ide']) {
test(`parse merges an explicit ${store} home`, async (t) => {
  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    t.skip('node:sqlite is unavailable on this Node version');
    return;
  }

  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-extra-root-'));
  const emptyDefault = join(root, 'default-conversations');
  const extraHome = join(root, 'isolated-home');
  const conversationsDir = join(extraHome, '.gemini', store, 'conversations');
  mkdirSync(emptyDefault, { recursive: true });
  mkdirSync(conversationsDir, { recursive: true });
  const db = new DatabaseSync(join(conversationsDir, 'isolated-cascade.db'));
  try {
    db.exec(`
      CREATE TABLE gen_metadata (idx INTEGER, data BLOB);
      CREATE TABLE steps (idx INTEGER, metadata BLOB);
    `);
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(1, buildBlob({
      input: 123, output: 45, cache: 10, thinking: 5,
      responseId: 'ISOLATED_RESPONSE', seconds: 1783484000,
      responseModel: 'gemini-default', displayName: 'Gemini Isolated',
    }));
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(1, buildStep({ source: 4, seconds: 1783484000 }));
    db.prepare('INSERT INTO steps (idx, metadata) VALUES (?, ?)').run(2, buildStep({ source: 2, seconds: 1783484002 }));
  } finally {
    db.close();
  }

  const previous = process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
  process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = emptyDefault;
  try {
    const result = await parse({ extraRoots: [extraHome] });
    assert.equal(result.sessions.length, 1);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.inputTokens, 0), 123);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.outputTokens, 0), 45);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.cachedInputTokens, 0), 10);
    assert.equal(result.buckets.reduce((sum, bucket) => sum + bucket.reasoningOutputTokens, 0), 5);
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
    else process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
}

test('Antigravity detection and extra roots recognize a standalone IDE store', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-ide-roots-'));
  const ideDir = join(root, '.gemini', 'antigravity-ide', 'conversations');
  mkdirSync(ideDir, { recursive: true });
  try {
    assert.ok(antigravityConversationDirs(root).includes(ideDir));
    assert.ok(findAntigravityDataDirs([root]).includes(dirname(ideDir)));
    assert.equal(validateExtraRoot('antigravity', root).ok, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function legacyFixture(t, stores) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-legacy-'));
  const dirs = antigravityConversationDirs(root);
  for (const dir of dirs) mkdirSync(dir, { recursive: true });
  for (const [storeIndex, ids] of stores) {
    for (const id of ids) writeFileSync(join(dirs[storeIndex], `${id}.pb`), 'opaque fixture');
  }
  const previous = process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
  process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = dirs.join(delimiter);
  t.after(() => {
    if (previous === undefined) delete process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
    else process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = previous;
    rmSync(root, { recursive: true, force: true });
  });
}

function mockServers(t, servers) {
  const processMock = t.mock.method(childProcess, 'execSync', command => {
    if (command.includes('ps aux')) {
      return servers.map(({ pid, token }) => `user ${pid} 0 0 /Applications/Antigravity IDE.app/language_server --csrf_token ${token}`).join('\n');
    }
    if (command.includes('Get-CimInstance') || command.includes('wmic process')) {
      return servers.map(({ pid, token }) => `---\nProcessId=${pid}\nCommandLine=Antigravity IDE/language_server --csrf_token ${token}`).join('\n');
    }
    if (command.includes('lsof')) {
      const pid = command.match(/-p (\d+)/)?.[1];
      const server = servers.find(server => String(server.pid) === pid);
      return server ? `language_server ${pid} user TCP 127.0.0.1:${server.port} (LISTEN)` : '';
    }
    if (command.includes('netstat')) {
      return servers.map(({ pid, port }) => `TCP 127.0.0.1:${port} 0.0.0.0:0 LISTENING ${pid}`).join('\n');
    }
    throw new Error(`Unexpected subprocess: ${command}`);
  });
  syncBuiltinESMExports();
  t.after(() => {
    processMock.mock.restore();
    syncBuiltinESMExports();
  });
}

function legacyTrajectory(id, input = 100) {
  return {
    trajectory: {
      generatorMetadata: [{ chatModel: {
        responseModel: 'gemini-3-pro-high',
        chatStartMetadata: { createdAt: '2026-09-07T06:30:02Z' },
        retryInfos: [{ usage: { responseId: `response-${id}`, inputTokens: input, outputTokens: 5 } }],
      } }],
      steps: [
        { metadata: { source: 'CORTEX_STEP_SOURCE_USER_EXPLICIT', createdAt: '2026-09-07T06:30:00Z' } },
        { metadata: { source: 'CORTEX_STEP_SOURCE_MODEL', createdAt: '2026-09-07T06:30:02Z' } },
      ],
    },
  };
}

test('legacy IDE conversations are read from the owning server when the App is also running', async (t) => {
  legacyFixture(t, [[0, ['app-chat', 'copied-chat']], [2, ['ide-chat', 'copied-chat']]]);
  const servers = [
    { pid: 123, port: 40123, token: 'aaa' },
    { pid: 456, port: 40456, token: 'bbb' },
  ];
  mockServers(t, servers);
  const successful = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(url.hostname, '127.0.0.1');
    const server = servers.find(server => String(server.port) === url.port);
    assert.equal(options.headers['X-Codeium-Csrf-Token'], server.token);
    if (url.pathname.endsWith('/GetWorkspaceInfos')) return Response.json({});
    const { cascadeId } = JSON.parse(options.body);
    if (server.pid === 123 && cascadeId === 'ide-chat') return new Response('', { status: 404 });
    successful.push(cascadeId);
    return Response.json(legacyTrajectory(cascadeId));
  });

  const result = await parse();
  assert.deepEqual(successful.sort(), ['app-chat', 'copied-chat', 'ide-chat']);
  assert.equal(result.skipped, undefined);
  assert.equal(result.buckets.reduce((sum, b) => sum + b.inputTokens, 0), 300);
  assert.equal(result.sessions.length, 3);
  assert.equal(result.sessions.reduce((sum, session) => sum + session.messageCount, 0), 6);
});

test('a closed IDE soft-skips unreadable legacy history with a diagnostic', async (t) => {
  legacyFixture(t, [[2, ['ide-chat']]]);
  mockServers(t, []);
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('No server should be queried'); });
  const result = await parse();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.match(result.warnings[0], /1 个旧格式会话.*Antigravity IDE\/App/);
});

test('partial legacy reads retain available usage and protect the source from pruning', async (t) => {
  legacyFixture(t, [[2, ['available', 'unavailable']]]);
  mockServers(t, [{ pid: 123, port: 40123, token: 'aaa' }]);
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (url.pathname.endsWith('/GetWorkspaceInfos')) return Response.json({});
    const { cascadeId } = JSON.parse(options.body);
    if (cascadeId === 'unavailable') throw new Error('RPC connection failed');
    return Response.json(legacyTrajectory(cascadeId));
  });
  const result = await parse();
  assert.equal(result.skipped, true);
  assert.equal(result.buckets[0].inputTokens, 100);
  assert.equal(result.sessions.length, 1);
  assert.match(result.warnings[0], /1 个旧格式会话/);
});

test('Windows discovery keeps both App and IDE servers in CIM and legacy WMIC output', () => {
  const app = 'Antigravity/language_server.exe --csrf_token aaa';
  const ide = 'Antigravity IDE/language_server.exe --csrf_token bbb';
  for (const output of [
    `---\nProcessId=123\nCommandLine=${app}\n---\nProcessId=456\nCommandLine=${ide}`,
    `CommandLine=${app}\nProcessId=123\nCommandLine=${ide}\nProcessId=456`,
  ]) {
    assert.deepEqual(parseWinProcessList(output), [{ pid: '123', csrfToken: 'aaa' }, { pid: '456', csrfToken: 'bbb' }]);
  }
});

test('missing configured Antigravity home skips the source to protect upload state', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-missing-'));
  const emptyDefault = join(root, 'default-conversations');
  mkdirSync(emptyDefault, { recursive: true });
  const previous = process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
  process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = emptyDefault;
  try {
    const result = await parse({ extraRoots: [join(root, 'missing')] });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.match(result.warnings[0], /额外根目录不可用/);
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
    else process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test('database failure inside a configured Antigravity home skips the source', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-antigravity-invalid-'));
  const emptyDefault = join(root, 'default-conversations');
  const extraHome = join(root, 'isolated-home');
  const conversationsDir = join(extraHome, '.gemini', 'antigravity-cli', 'conversations');
  mkdirSync(emptyDefault, { recursive: true });
  mkdirSync(conversationsDir, { recursive: true });
  writeFileSync(join(conversationsDir, 'broken.db'), 'not a sqlite database');

  const previous = process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
  process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = emptyDefault;
  try {
    const result = await parse({ extraRoots: [extraHome] });
    assert.equal(result.skipped, true);
    assert.deepEqual(result.buckets, []);
    assert.match(result.warnings[0], /额外根目录读取失败/);
  } finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_ANTIGRAVITY_DIRS;
    else process.env.VIBE_USAGE_ANTIGRAVITY_DIRS = previous;
    rmSync(root, { recursive: true, force: true });
  }
});
