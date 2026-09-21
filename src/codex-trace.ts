import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';

import type { Environment } from './config.js';

export interface CodexTraceEvent {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  event: string;
  sessionId?: string;
  [key: string]: unknown;
}

export interface CodexTraceEventInput {
  timestamp: string;
  event: string;
  sessionId?: string;
  [key: string]: unknown;
}

let sequence = 0;

function expandPath(path: string, environment: Environment): string {
  if (path === '~' || path.startsWith('~/')) {
    return join(environment.HOME || homedir(), path.slice(2));
  }
  return isAbsolute(path) ? path : resolve(path);
}

/** Stable local event stream consumed by the optional live web viewer. */
export function codexTracePath(environment: Environment = process.env): string {
  const configured = environment.FAST_JEV_TRACE_FILE?.trim();
  if (configured) return expandPath(configured, environment);
  return join(
    environment.HOME || homedir(),
    '.config',
    'fast-jev-compaction',
    'events.jsonl',
  );
}

function eventId(): string {
  sequence += 1;
  return `${Date.now().toString(36)}-${process.pid}-${sequence.toString(36)}`;
}

/**
 * Writes one bounded JSONL event. Trace failures are intentionally handled by
 * the caller so observability can never change native Codex fallback behavior.
 */
export async function appendCodexTrace(
  event: CodexTraceEventInput,
  environment: Environment = process.env,
): Promise<void> {
  const path = codexTracePath(environment);
  await mkdir(dirname(path), { recursive: true });
  const record: CodexTraceEvent = {
    schemaVersion: 1,
    id: eventId(),
    ...event,
  };
  await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}
