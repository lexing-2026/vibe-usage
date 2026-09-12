import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

// Match the Hermes CLI/Desktop layout. Windows installers use LOCALAPPDATA;
// Desktop falls back to an existing ~/.hermes only before that native root exists.
export function getHermesHome({ onError = () => {} } = {}) {
  const explicit = process.env.HERMES_HOME?.trim();
  if (explicit) return explicit;

  const legacy = join(homedir(), '.hermes');
  if (process.platform !== 'win32') return legacy;

  const localAppData = process.env.LOCALAPPDATA?.trim() || join(homedir(), 'AppData', 'Local');
  const native = join(localAppData, 'hermes');
  return !statIfPresent(native, onError)?.isDirectory()
    && statIfPresent(legacy, onError)?.isDirectory() ? legacy : native;
}

function statIfPresent(path, onError) {
  try {
    return statSync(path);
  } catch (err) {
    if (err.code !== 'ENOENT') onError(err);
    return null;
  }
}

// Parsing must fail on unreadable stores: a partial result would allow sync
// to prune that profile's previous state. Detection alone is best-effort.
export function discoverHermesDatabases({ onError = err => { throw err; } } = {}) {
  const home = getHermesHome({ onError });
  const dbs = [];

  const defaultDb = join(home, 'state.db');
  if (statIfPresent(defaultDb, onError)) dbs.push({ path: defaultDb, profile: 'default' });

  const profilesDir = join(home, 'profiles');
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch (err) {
    if (err.code !== 'ENOENT') onError(err);
    return dbs;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDb = join(profilesDir, entry.name, 'state.db');
    if (statIfPresent(profileDb, onError)?.isFile()) {
      dbs.push({ path: profileDb, profile: entry.name });
    }
  }

  return dbs;
}

export function findHermesDataDirs() {
  return discoverHermesDatabases({ onError: () => {} }).map(db => db.path);
}
