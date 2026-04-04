import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import type { ApiEnv } from './types.js';

const CONFIG_DIR = join(homedir(), '.config', 'neuralingual');
const AUTH_FILE = join(CONFIG_DIR, 'auth.json');

export interface AuthData {
  env: ApiEnv;
  accessToken: string;
  refreshToken: string;
  userId: string;
  email: string | null;
}

/** Load saved auth tokens. Returns null if not logged in. */
export function loadAuth(): AuthData | null {
  try {
    const raw = readFileSync(AUTH_FILE, 'utf8');
    const data = JSON.parse(raw) as AuthData;
    if (!data.accessToken || !data.refreshToken || !data.env) return null;
    return data;
  } catch {
    return null;
  }
}

/** Save auth tokens to disk. */
export function saveAuth(data: AuthData): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(AUTH_FILE, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/** Clear saved auth tokens (logout). */
export function clearAuth(): void {
  try {
    unlinkSync(AUTH_FILE);
  } catch {
    // File may not exist — that's fine
  }
}
