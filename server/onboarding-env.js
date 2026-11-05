import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
// Managed runners may have another cwd. Resolve only this checkout's ignored file.
// Explicit process environment wins in production. Nothing is exposed to Vite.
export function loadOnboardingEnv(file = new URL('../.env.local', import.meta.url)) {
  try {
    const env = parseEnv(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(env)) if (process.env[key] === undefined) process.env[key] = value;
  } catch (error) { if (error.code !== 'ENOENT') throw new Error('Unable to load server configuration'); }
}
