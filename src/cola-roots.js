import { statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export function getColaSessionsDir() {
  return join(process.env.COLA_DATA_DIR ?? join(homedir(), '.cola'), 'sessions');
}

export function findColaDataDirs() {
  const dir = getColaSessionsDir();
  try {
    return statSync(dir).isDirectory() ? [dir] : [];
  } catch {
    return [];
  }
}
