import { getColaSessionsDir } from '../cola-roots.js';
import { parsePiSessionJsonl } from './pi-session-jsonl.js';

/** Cola 1.4.4 writes Pi-compatible transcripts under sessions/<scope>/. */
export async function parse() {
  const result = await parsePiSessionJsonl({
    source: 'cola',
    sessionsDirs: [getColaSessionsDir()],
    // Scope slugs may identify channels or people, not projects. The session
    // header's cwd supplies a project when present; otherwise keep unknown.
    projectFromPath: () => 'unknown',
    deduplicateCopiedSessions: true,
  });
  // A missing part of the store must not overwrite a complete uploaded bucket
  // with a partial sum, even when several projects are hidden behind unknown.
  return result.skipped ? { ...result, buckets: [], sessions: [] } : result;
}
