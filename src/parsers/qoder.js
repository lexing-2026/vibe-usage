import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { join, basename, extname } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';
import { isSqliteUnavailableError, queryDbJsonSnapshotOnLock, sqliteUnavailableError } from './sqlite.js';
import { QODER_EDITIONS, getQoderProjectsDir, getQoderDbPath } from '../qoder-roots.js';

/**
 * Qoder (Alibaba's agentic coding platform). Two editions with fully separate
 * accounts, billing, model pools and data directories — see ../qoder-roots.js:
 *
 *   'qoder'     international qoder.com     ~/.qoder      Application Support/Qoder
 *   'qoder-cn'  China qoder.com.cn          ~/.qoder-cn   Application Support/QoderCN
 *
 * Each edition has two local data shapes, verified on 2026-09-04 against
 * Qoder CLI 1.1.42, Qoder desktop app 0.1.6 and both IDEs 1.28.0:
 *
 * 1. The IDE's SQLite store <ideDataDir>/SharedClientCache/cache/db/local.db:
 *    table chat_message with `token_info` JSON { prompt_tokens, cached_tokens,
 *    completion_tokens, max_input_tokens } and `model_info` JSON { model_key }.
 *    Real tokens (prompt_tokens INCLUDES cached_tokens), no credits. `model_key`
 *    is usually a routing tier ('auto', 'ultimate', 'performance', 'efficient',
 *    'lite') rather than a concrete model; tiers are reported as `qoder-<tier>`
 *    so they stay unmatched server-side (see normalizeQoderModel).
 *    → token buckets + sessions.
 *
 * 2. JSONL transcripts (CLI + desktop app share them — the app embeds the CLI):
 *    <configDir>/projects/<cwd-slug>/<sessionId>.jsonl plus sub-agent files at
 *    <configDir>/projects/<cwd-slug>/<sessionId>/subagents/agent-*.jsonl.
 *    Claude Code-shaped records { type, timestamp, uuid, sessionId, cwd,
 *    message:{ id, role, model, content, usage } }. Qoder bills these in
 *    CREDITS: `message.usage` is { input_tokens:0, output_tokens:0, …,
 *    credits, original_credits, billable } — every token field is 0. One
 *    assistant message is written as several lines (one per content block);
 *    only the last line of a message carries `usage`.
 *    → sessions only. The credit amount is an account funding path and is not
 *    collected (cost-accounting invariant in AGENTS.md); token fields are read
 *    so that a future Qoder build that reports tokens is counted without a
 *    parser change.
 */

const DEFAULT_MODEL = 'qoder-agent';
const MAX_WARNINGS = 10;

// Qoder's routing tiers are not models. Left bare, `auto` collides with the
// Cursor `auto` entry in the server pricing map and gets billed at Cursor's
// rate, so tiers are namespaced (`qoder-auto`, …) — those never match a price
// and render as unmatched, which is the truthful state. Concrete model keys
// (`qmodel_38max`, …) are passed through unchanged.
const ROUTING_TIERS = new Set(['auto', 'ultimate', 'performance', 'efficient', 'lite']);

function normalizeQoderModel(key) {
  const k = typeof key === 'string' ? key.trim() : '';
  if (!k) return DEFAULT_MODEL;
  return ROUTING_TIERS.has(k.toLowerCase()) ? `qoder-${k.toLowerCase()}` : k;
}

function toDate(value) {
  if (value == null || value === '') return null;
  if (typeof value === 'number') {
    const ms = value < 1e12 ? value * 1000 : value;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d;
  }
  const s = String(value).trim();
  if (/^\d+(\.\d+)?$/.test(s)) return toDate(Number(s));
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d;
}

function warn(ctx, message) {
  if (ctx.warnings.length < MAX_WARNINGS) ctx.warnings.push(`${ctx.source}: ${message}`);
}

// ── JSONL layer (CLI + desktop app) ────────────────────────────────────────

function listJsonlFiles(root, ctx) {
  const out = [];
  const walk = dir => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      ctx.skipped = true;
      warn(ctx, `cannot read ${dir}: ${err.message}`);
      return;
    }
    for (const entry of entries) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) walk(p);
      else if (entry.isFile() && extname(entry.name) === '.jsonl') out.push(p);
    }
  };
  walk(root);
  return out;
}

// A `user` record is a human prompt unless it is a tool result being fed back.
function isHumanPrompt(record) {
  if (record.humanInput) return true;
  if (record.origin && record.origin.kind === 'human') return true;
  if (record.toolUseResult) return false;
  const content = record.message?.content;
  if (Array.isArray(content)) {
    return !content.some(c => c && typeof c === 'object' && c.type === 'tool_result');
  }
  return true;
}

async function parseTranscriptFile(filePath, ctx) {
  const { source, entries, events } = ctx;
  const fallbackSession = basename(filePath, '.jsonl');
  // One assistant message spans several lines; keep the last usage-bearing
  // record per message id so a call is counted exactly once.
  const usageByMessage = new Map();

  const rl = createInterface({ input: createReadStream(filePath, { encoding: 'utf-8' }), crlfDelay: Infinity });
  for await (const line of rl) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== 'object') continue;
    const type = record.type;
    if (type !== 'user' && type !== 'assistant') continue;

    const timestamp = toDate(record.timestamp);
    if (!timestamp) continue;
    const sessionId = record.sessionId || record.session_id || fallbackSession;
    const project = projectFromCwd(record.cwd);
    const message = record.message && typeof record.message === 'object' ? record.message : {};

    if (type === 'user') {
      if (isHumanPrompt(record)) {
        events.push({ sessionId, source, project, timestamp, role: 'user' });
      }
      continue;
    }

    events.push({ sessionId, source, project, timestamp, role: 'assistant' });

    const usage = message.usage;
    if (!usage || typeof usage !== 'object') continue;
    const key = `${sessionId}|${message.id || record.uuid || `${filePath}:${usageByMessage.size}`}`;
    usageByMessage.set(key, {
      usage,
      model: normalizeQoderModel(message.model),
      project,
      timestamp,
    });
  }

  for (const { usage, model, project, timestamp } of usageByMessage.values()) {
    // Cache writes join input (same convention as the Claude Code parser).
    const input = toCount(usage.input_tokens) + toCount(usage.cache_creation_input_tokens);
    const cached = toCount(usage.cache_read_input_tokens ?? usage.cached_tokens);
    const output = toCount(usage.output_tokens);
    if (input + cached + output === 0) continue; // credit-billed call: tokens not reported
    entries.push({
      source,
      model,
      project,
      timestamp,
      inputTokens: input,
      outputTokens: output,
      cachedInputTokens: cached,
      reasoningOutputTokens: 0,
    });
  }
}

async function parseTranscripts(edition, ctx) {
  const root = getQoderProjectsDir(edition);
  if (!existsSync(root)) return;
  for (const file of listJsonlFiles(root, ctx)) {
    try {
      await parseTranscriptFile(file, ctx);
    } catch (err) {
      // A half-written or unreadable transcript: keep prior upload state, retry next run.
      ctx.skipped = true;
      warn(ctx, `cannot read ${file}: ${err.message}`);
    }
  }
}

// ── SQLite layer (IDE) ─────────────────────────────────────────────────────

const IDE_COLUMNS = `
  cm.id AS id,
  cm.session_id AS sessionId,
  cm.request_id AS requestId,
  cm.role AS role,
  cm.token_info AS tokenInfo,
  cm.model_info AS modelInfo,
  cm.gmt_create AS created`;

// Only token/model/timing columns are selected; message content, tool results
// and summaries are never read.
const IDE_QUERY_WITH_SESSION = `SELECT ${IDE_COLUMNS},
  cs.project_uri AS projectUri,
  cs.project_name AS projectName,
  cs.preferred_model_info AS preferredModelInfo
  FROM chat_message cm
  LEFT JOIN chat_session cs ON cs.session_id = cm.session_id
  WHERE cm.role IN ('user', 'assistant')`;

const IDE_QUERY_PLAIN = `SELECT ${IDE_COLUMNS}
  FROM chat_message cm
  WHERE cm.role IN ('user', 'assistant')`;

function isMissingTable(err, table) {
  return err && typeof err.message === 'string' && new RegExp(`no such table:\\s*${table}`, 'i').test(err.message);
}

function queryIdeRows(dbPath) {
  const opts = { tempPrefix: 'vibe-usage-qoder-' };
  try {
    return queryDbJsonSnapshotOnLock(dbPath, IDE_QUERY_WITH_SESSION, opts);
  } catch (err) {
    // Older Qoder CN builds have no chat_session table; degrade to unattributed projects.
    if (isMissingTable(err, 'chat_session')) return queryDbJsonSnapshotOnLock(dbPath, IDE_QUERY_PLAIN, opts);
    if (isMissingTable(err, 'chat_message')) return [];
    throw err;
  }
}

function parseJson(value) {
  if (!value) return null;
  if (typeof value === 'object') return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function ideProject(row) {
  const uri = typeof row.projectUri === 'string' ? row.projectUri.trim() : '';
  if (uri) {
    if (uri.startsWith('file://')) {
      try {
        return projectFromCwd(decodeURIComponent(new URL(uri).pathname));
      } catch {
        // fall through to project_name
      }
    } else {
      return projectFromCwd(uri);
    }
  }
  const name = typeof row.projectName === 'string' ? row.projectName.trim() : '';
  // '.' is Qoder's "no project" sentinel.
  return name && name !== '.' ? name : 'unknown';
}

function ideModel(row) {
  const info = parseJson(row.modelInfo);
  const preferred = parseJson(row.preferredModelInfo);
  const key = info?.model_key || info?.modelKey || preferred?.model_key || preferred?.modelKey;
  return normalizeQoderModel(key);
}

function parseIde(edition, ctx) {
  const { source, entries, events } = ctx;
  const dbPath = getQoderDbPath(edition);
  if (!existsSync(dbPath)) return;

  let rows;
  try {
    rows = queryIdeRows(dbPath);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError(`${QODER_EDITIONS[edition].label} IDE`);
    // Schema drift or a transient read failure: fail soft so incremental state
    // for this source is not pruned.
    ctx.skipped = true;
    warn(ctx, `cannot read ${dbPath}: ${err.message}`);
    return;
  }

  for (const row of rows) {
    const timestamp = toDate(row.created);
    if (!timestamp) continue;
    const project = ideProject(row);
    const sessionId = row.sessionId || 'unknown';
    const role = row.role === 'user' ? 'user' : 'assistant';
    events.push({ sessionId, source, project, timestamp, role });
    if (role !== 'assistant') continue;

    const tokens = parseJson(row.tokenInfo);
    if (!tokens) continue;
    const prompt = toCount(tokens.prompt_tokens);
    const cached = Math.min(prompt, toCount(tokens.cached_tokens));
    const completion = toCount(tokens.completion_tokens);
    if (prompt + completion === 0) continue;

    entries.push({
      source,
      model: ideModel(row),
      project,
      timestamp,
      // prompt_tokens already includes cached_tokens.
      inputTokens: prompt - cached,
      outputTokens: completion,
      cachedInputTokens: cached,
      reasoningOutputTokens: 0,
    });
  }
}

// ── Entry points ───────────────────────────────────────────────────────────

async function parseEdition(edition) {
  const ctx = { source: QODER_EDITIONS[edition].source, entries: [], events: [], warnings: [], skipped: false };
  await parseTranscripts(edition, ctx);
  parseIde(edition, ctx);
  return {
    buckets: aggregateToBuckets(ctx.entries),
    sessions: extractSessions(ctx.events),
    skipped: ctx.skipped,
    warnings: ctx.warnings,
  };
}

export async function parseQoder() {
  return parseEdition('qoder');
}

export async function parseQoderCn() {
  return parseEdition('qoder-cn');
}
