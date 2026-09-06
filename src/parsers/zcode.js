import { existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

/**
 * Resolve all ZCode DB paths: default + extras.
 */
function resolveDbPaths(extraRoots = []) {
  const paths = [join(homedir(), '.zcode', 'cli', 'db', 'db.sqlite')];
  for (const root of extraRoots) {
    if (root) {
      const candidate = join(root, 'cli', 'db', 'db.sqlite');
      if (!paths.includes(candidate)) paths.push(candidate);
    }
  }
  return paths.filter(existsSync);
}

// ZCode (z.ai / Zhipu's coding agent) stores everything in a SQLite database
// at ~/.zcode/cli/db/db.sqlite. The `message` table is the canonical source:
// each row is one user or assistant message, with an assistant message carrying
// per-request token usage and the working directory. We read it directly rather
// than the parallel `model_usage` ledger because `message` gives us BOTH session
// timing (user + assistant rows) and token usage in one pass, with the project
// path attached to each message.

/**
 * Project name from a ZCode message's path. ZCode records both `cwd` and `root`;
 * prefer `root` (the workspace root) and fall back to `cwd`, then to the
 * session's `directory` column (joined in via the query) — taking the last path
 * component, matching how every other parser names projects.
 */
function projectName(root, cwd, sessionDir) {
  const p = root || cwd || sessionDir;
  if (!p) return 'unknown';
  return basename(String(p).replace(/[/\\]+$/, '')) || 'unknown';
}

export async function parse({ extraRoots = [] } = {}) {
  const dbPaths = resolveDbPaths(extraRoots);
  if (dbPaths.length === 0) return { buckets: [], sessions: [] };

  const allEntries = [];
  const allSessions = [];

  for (const dbPath of dbPaths) {
    try {
      const result = parseFromDb(dbPath);
      allEntries.push(...(result.buckets || []));
      allSessions.push(...(result.sessions || []));
    } catch (err) {
      if (isSqliteUnavailableError(err)) throw err;
      process.stderr.write(`warn: zcode parse failed (${dbPath}): ${err.message}\n`);
    }
  }

  return { buckets: aggregateToBuckets(allEntries), sessions: allSessions };
}

function parseFromDb(dbPath) {
  // Join each message to its session so we can fall back to the session's
  // directory when an individual message has no path (older rows, lite agents).
  const query = `SELECT
    m.session_id AS sessionId,
    m.time_created AS created,
    json_extract(m.data, '$.role') AS role,
    json_extract(m.data, '$.modelID') AS modelID,
    json_extract(m.data, '$.tokens') AS tokens,
    json_extract(m.data, '$.path.root') AS pathRoot,
    json_extract(m.data, '$.path.cwd') AS pathCwd,
    s.directory AS sessionDir
    FROM message m
    LEFT JOIN session s ON s.id = m.session_id`;

  let rows;
  try {
    rows = queryDbJson(dbPath, query);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('ZCode');
    throw err;
  }
  if (!rows.length) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];

  for (const row of rows) {
    const timestamp = new Date(row.created);
    if (isNaN(timestamp.getTime())) continue;

    const project = projectName(row.pathRoot, row.pathCwd, row.sessionDir);
    const sessionId = row.sessionId || 'unknown';

    sessionEvents.push({
      sessionId,
      source: 'zcode',
      project,
      timestamp,
      role: row.role === 'user' ? 'user' : 'assistant',
    });

    if (row.role !== 'assistant') continue;

    let tokens;
    try {
      tokens = typeof row.tokens === 'string' ? JSON.parse(row.tokens) : row.tokens;
    } catch {
      continue;
    }
    if (!tokens || (!tokens.input && !tokens.output)) continue;

    // ZCode follows Anthropic-style usage where `input` INCLUDES the cache-read
    // tokens and `output` INCLUDES reasoning (verified: input + output == total).
    // Normalize to this codebase's non-overlapping fields so cached/reasoning
    // tokens aren't double-counted inside input/output.
    const cachedInput = tokens.cache?.read || 0;
    const reasoning = tokens.reasoning || 0;

    entries.push({
      source: 'zcode',
      model: row.modelID || 'unknown',
      project,
      timestamp,
      inputTokens: (tokens.input || 0) - cachedInput,
      outputTokens: (tokens.output || 0) - reasoning,
      cachedInputTokens: cachedInput,
      reasoningOutputTokens: reasoning,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
