import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { toCount } from './fs-utils.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

const HERMES_HOME = process.env.HERMES_HOME || join(homedir(), '.hermes');

/**
 * Parse Hermes Agent usage data from its SQLite databases.
 *
 * Hermes supports multiple profiles — the default profile lives at
 * ~/.hermes/state.db, while named profiles live at ~/.hermes/profiles/<name>/state.db.
 * Each profile is an independent HERMES_HOME with its own state.db, so we scan all of them.
 *
 * Token buckets come from the sessions table (cumulative per-session totals).
 * Session timing comes from the messages table (per-message role + timestamp).
 */
export async function parse() {
  const dbs = discoverDbPaths(HERMES_HOME);
  if (dbs.length === 0) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const { path: dbPath, profile } of dbs) {
    let sessionRows;
    try {
      const columns = new Set(queryDb(dbPath, 'PRAGMA table_info(sessions)').map(row => row.name));
      const cacheWriteColumn = columns.has('cache_write_tokens') ? 'cache_write_tokens' : '0';
      sessionRows = queryDb(dbPath, `SELECT
        id,
        model,
        started_at as startedAt,
        input_tokens as inputTokens,
        output_tokens as outputTokens,
        cache_read_tokens as cacheReadTokens,
        ${cacheWriteColumn} as cacheWriteTokens,
        reasoning_tokens as reasoningTokens
        FROM sessions
        WHERE input_tokens > 0 OR output_tokens > 0
          OR cache_read_tokens > 0 OR ${cacheWriteColumn} > 0 OR reasoning_tokens > 0`);
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('Hermes');
      throw err;
    }

    for (const row of sessionRows) {
      // started_at is a Unix timestamp (float)
      const timestamp = new Date(row.startedAt * 1000);
      if (isNaN(timestamp.getTime())) continue;

      // Hermes stores input_tokens exclusive of cache (Anthropic-style semantics)
      // and output_tokens inclusive of reasoning (CanonicalUsage.total_tokens
      // adds prompt + output only). Split reasoning instead of counting it twice.
      const output = toCount(row.outputTokens);
      const reasoning = Math.min(output, toCount(row.reasoningTokens));
      entries.push({
        source: 'hermes',
        model: row.model || 'unknown',
        project: profile,
        timestamp,
        inputTokens: toCount(row.inputTokens) + toCount(row.cacheWriteTokens),
        outputTokens: output - reasoning,
        cachedInputTokens: toCount(row.cacheReadTokens),
        reasoningOutputTokens: reasoning,
      });
    }

    let messageRows;
    try {
      messageRows = queryDb(dbPath, `SELECT
        session_id as sessionId,
        role,
        timestamp
        FROM messages
        WHERE role IN ('user', 'assistant')
        ORDER BY timestamp`);
    } catch {
      // Messages query failed for this profile — skip its session events
      continue;
    }

    for (const row of messageRows) {
      const timestamp = new Date(row.timestamp * 1000);
      if (isNaN(timestamp.getTime())) continue;

      sessionEvents.push({
        sessionId: row.sessionId,
        source: 'hermes',
        project: profile,
        timestamp,
        role: row.role === 'user' ? 'user' : 'assistant',
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}

function discoverDbPaths(home) {
  const dbs = [];

  const defaultDb = join(home, 'state.db');
  if (existsSync(defaultDb)) dbs.push({ path: defaultDb, profile: 'default' });

  const profilesDir = join(home, 'profiles');
  if (existsSync(profilesDir)) {
    let entries;
    try {
      entries = readdirSync(profilesDir, { withFileTypes: true });
    } catch {
      return dbs;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const profileDb = join(profilesDir, entry.name, 'state.db');
      try {
        if (statSync(profileDb).isFile()) dbs.push({ path: profileDb, profile: entry.name });
      } catch {
        // missing or unreadable — skip
      }
    }
  }

  return dbs;
}

function queryDb(dbPath, sql) {
  return queryDbJson(dbPath, sql);
}
