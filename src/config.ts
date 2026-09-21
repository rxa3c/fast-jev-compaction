import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export type Environment = Readonly<Record<string, string | undefined>>;

const CONFIG_KEYS = new Set(['TYPESAFE_API_KEY', 'PLUGIN_DATA', 'FAST_JEV_CONFIG']);

function isConfigKey(key: string): boolean {
  return CONFIG_KEYS.has(key) || key.startsWith('FAST_JEV_');
}

function parseValue(value: string): string {
  const trimmed = value.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  const comment = trimmed.search(/\s+#/);
  return comment >= 0 ? trimmed.slice(0, comment).trimEnd() : trimmed;
}

function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const assignment = trimmed.replace(/^export\s+/, '').match(
      /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/,
    );
    if (!assignment || !isConfigKey(assignment[1])) continue;
    const value = parseValue(assignment[2]);
    // Empty template credentials must not erase a key from the user's config.
    if (assignment[1] === 'TYPESAFE_API_KEY' && !value.trim()) continue;
    values[assignment[1]] = value;
  }
  return values;
}

async function readEnvFile(path: string): Promise<Record<string, string>> {
  try {
    return parseEnvFile(await readFile(path, 'utf8'));
  } catch {
    return {};
  }
}

function configPaths(environment: Environment): string[] {
  const home = environment.HOME || homedir();
  const candidates = [
    // Keep the previous Codex-specific names as a compatibility fallback.
    join(home, '.config', 'fast-jev-codex.env'),
    join(home, '.fast-jev-codex.env'),
    join(home, '.config', 'fast-jev-compaction', '.env'),
    join(home, '.fast-jev-compaction.env'),
    join(process.cwd(), '.env'),
    environment.PLUGIN_ROOT ? join(environment.PLUGIN_ROOT, '.env') : undefined,
    environment.FAST_JEV_CONFIG
      ? resolve(process.cwd(), environment.FAST_JEV_CONFIG)
      : undefined,
  ];
  return [...new Set(candidates.filter((path): path is string => path !== undefined))];
}

/** Loads local config files while keeping explicitly supplied environment values authoritative. */
export async function loadConfigEnvironment(
  environment: Environment = process.env,
): Promise<Environment> {
  const fromFiles: Record<string, string> = {};
  for (const path of configPaths(environment)) {
    Object.assign(fromFiles, await readEnvFile(path));
  }
  return { ...fromFiles, ...environment };
}
