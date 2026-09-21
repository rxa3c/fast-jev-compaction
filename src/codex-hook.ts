import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { JevClient } from './client.js';
import { loadConfigEnvironment, type Environment } from './config.js';
import {
  appendCodexTrace,
  type CodexTraceEventInput,
} from './codex-trace.js';
import {
  buildCodexPlan,
  parseCodexRollout,
  renderCodexRecoveryNote,
  type CodexPlanOptions,
} from './codex.js';
import { reductionRatio } from './compact.js';
import { DEFAULT_MODEL } from './request.js';
import type { JevAsker } from './types.js';

const RECOVERY_NOTE_LIMIT = 5_500;

export interface CodexHookInput {
  session_id?: string;
  transcript_path?: string;
  cwd?: string;
  hook_event_name?: string;
  trigger?: string;
  source?: string;
  [key: string]: unknown;
}

export interface CodexHookConfig {
  model: string;
  goal?: string;
  minReductionRatio: number;
  noteResultChars: number;
  keepThreshold: number;
  preserveRecentMessages: number;
  maxStateTokens: number;
  maxRequestTokens: number;
  truncateHeadChars: number;
}

export interface CodexHookOutput {
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    additionalContext?: string;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface CodexHookDependencies {
  /** Injectable Jev transport for tests; production uses JevClient. */
  asker?: JevAsker;
  /** Injectable live trace sink; trace failures never affect the hook result. */
  trace?: (
    event: CodexTraceEventInput,
    environment: Environment,
  ) => Promise<void>;
  /** Injectable plugin data directory for tests. */
  dataRoot?: string;
  /** Injectable clock for deterministic pending state and plans. */
  now?: () => Date;
  /** Injectable rollout reader for tests or a host-specific filesystem. */
  readRollout?: (path: string) => Promise<string>;
}

interface PendingState {
  schemaVersion: 1;
  status: 'ready' | 'fallback';
  createdAt: string;
  consumedAt?: string;
  rolloutPath?: string;
  reductionRatio?: number;
  summary?: string;
  note?: string;
  error?: string;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function finiteEnvironmentNumber(
  environment: Environment,
  key: string,
  fallback: number,
): number {
  const value = environment[key];
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boundedRatio(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function nonNegativeInteger(value: number): number {
  return Math.max(0, Math.floor(value));
}

/** Resolves hook configuration without ever persisting the API key. */
export function resolveCodexHookConfig(
  environment: Environment = process.env,
): CodexHookConfig {
  const goal = environment.FAST_JEV_GOAL?.trim();
  return {
    model: environment.FAST_JEV_MODEL?.trim() || DEFAULT_MODEL,
    goal: goal || undefined,
    minReductionRatio: boundedRatio(
      finiteEnvironmentNumber(environment, 'FAST_JEV_MIN_REDUCTION_RATIO', 0.25),
    ),
    noteResultChars: nonNegativeInteger(
      finiteEnvironmentNumber(environment, 'FAST_JEV_NOTE_RESULT_CHARS', 800),
    ),
    keepThreshold: boundedRatio(
      finiteEnvironmentNumber(environment, 'FAST_JEV_KEEP_THRESHOLD', 0.5),
    ),
    preserveRecentMessages: nonNegativeInteger(
      finiteEnvironmentNumber(environment, 'FAST_JEV_PRESERVE_RECENT_MESSAGES', 6),
    ),
    maxStateTokens: Math.max(
      1,
      finiteEnvironmentNumber(environment, 'FAST_JEV_MAX_STATE_TOKENS', 25_000),
    ),
    maxRequestTokens: Math.max(
      1,
      finiteEnvironmentNumber(environment, 'FAST_JEV_MAX_REQUEST_TOKENS', 30_000),
    ),
    truncateHeadChars: nonNegativeInteger(
      finiteEnvironmentNumber(environment, 'FAST_JEV_TRUNCATE_HEAD_CHARS', 300),
    ),
  };
}

export function parseCodexHookInput(text: string): CodexHookInput {
  if (text.trim().length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`invalid Codex hook JSON: ${detail}`);
  }
  const input = object(parsed);
  if (!input) throw new Error('Codex hook input must be a JSON object');
  return input as CodexHookInput;
}

function currentTime(dependencies: CodexHookDependencies): string {
  return (dependencies.now?.() ?? new Date()).toISOString();
}

function safeSessionId(sessionId: string | undefined): string {
  const value = sessionId?.trim() || 'unknown-session';
  return value.replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 160) || 'unknown-session';
}

function pendingPath(
  input: CodexHookInput,
  environment: Environment,
  dependencies: CodexHookDependencies,
): string {
  const root =
    dependencies.dataRoot ||
    environment.PLUGIN_DATA ||
    join(tmpdir(), 'fast-jev-codex');
  return join(root, 'sessions', safeSessionId(input.session_id), 'pending.json');
}

async function writePending(path: string, state: PendingState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}.${Date.now()}.${Math.random()
    .toString(16)
    .slice(2)}.tmp`;
  try {
    await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    await rename(temporaryPath, path);
  } finally {
    try {
      await unlink(temporaryPath);
    } catch {
      // The temporary file is already gone after a successful rename.
    }
  }
}

function isPendingState(value: unknown): value is PendingState {
  const state = object(value);
  return (
    state?.schemaVersion === 1 &&
    (state.status === 'ready' || state.status === 'fallback') &&
    typeof state.createdAt === 'string'
  );
}

async function readPending(path: string): Promise<PendingState | undefined> {
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    return isPendingState(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

async function savePendingBestEffort(path: string, state: PendingState): Promise<void> {
  try {
    await writePending(path, state);
  } catch {
    // Native Codex compaction remains the fallback if plugin state cannot persist.
  }
}

function errorText(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error);
  return detail.replace(/\s+/g, ' ').slice(0, 240) || 'unknown error';
}

function fallbackMessage(reason: string): CodexHookOutput {
  return {
    systemMessage: `fast-jev-codex: fallback to native Codex compaction (${reason}).`,
  };
}

function planOptions(
  config: CodexHookConfig,
  input: CodexHookInput,
  createdAt: string,
): CodexPlanOptions {
  return {
    goal: config.goal,
    keepThreshold: config.keepThreshold,
    preserveRecentMessages: config.preserveRecentMessages,
    maxStateTokens: config.maxStateTokens,
    maxRequestTokens: config.maxRequestTokens,
    truncateHeadChars: config.truncateHeadChars,
    rolloutPath: input.transcript_path,
    now: createdAt,
    noteResultChars: config.noteResultChars,
  };
}

function planSummary(plan: Awaited<ReturnType<typeof buildCodexPlan>>): string {
  const ratio = Math.round(reductionRatio(plan) * 100);
  return `${ratio}% reduction; ${plan.stats.calls} paired call(s), ${plan.stats.requests} request(s)`;
}

async function emitTrace(
  input: CodexHookInput,
  environment: Environment,
  dependencies: CodexHookDependencies,
  event: string,
  fields: Record<string, unknown> = {},
): Promise<void> {
  if (!dependencies.trace) return;
  try {
    await dependencies.trace(
      {
        event,
        timestamp: currentTime(dependencies),
        sessionId: input.session_id,
        ...fields,
      },
      environment,
    );
  } catch {
    // The live viewer is optional and must never affect native compaction.
  }
}

function tracedAsker(
  asker: JevAsker,
  input: CodexHookInput,
  environment: Environment,
  dependencies: CodexHookDependencies,
  model: string,
): JevAsker {
  if (!dependencies.trace) return asker;
  return {
    async ask(state, questions) {
      const questionCount = Object.keys(questions).length;
      const startedAt = Date.now();
      await emitTrace(input, environment, dependencies, 'jev_request_started', {
        model,
        questionCount,
        callCount: Math.ceil(questionCount / 2),
        stateChars: JSON.stringify(state).length,
      });
      try {
        const response = await asker.ask(state, questions);
        await emitTrace(input, environment, dependencies, 'jev_response_received', {
          durationMs: Date.now() - startedAt,
          answerCount: Object.keys(response.answers).length,
        });
        return response;
      } catch (error) {
        await emitTrace(input, environment, dependencies, 'jev_request_failed', {
          durationMs: Date.now() - startedAt,
          error: errorText(error),
        });
        throw error;
      }
    },
  };
}

async function runPreCompact(
  input: CodexHookInput,
  environment: Environment,
  dependencies: CodexHookDependencies,
): Promise<CodexHookOutput> {
  const config = resolveCodexHookConfig(environment);
  const createdAt = currentTime(dependencies);
  const statePath = pendingPath(input, environment, dependencies);

  await emitTrace(input, environment, dependencies, 'precompact_started', {
    trigger: input.trigger,
    transcriptPath: input.transcript_path,
  });

  if (!input.transcript_path) {
    await savePendingBestEffort(statePath, {
      schemaVersion: 1,
      status: 'fallback',
      createdAt,
      error: 'Codex did not provide transcript_path',
    });
    await emitTrace(input, environment, dependencies, 'fallback', {
      reason: 'Codex did not provide transcript_path',
    });
    return fallbackMessage('transcript_path was not provided');
  }

  try {
    const readRollout = dependencies.readRollout ?? ((path: string) => readFile(path, 'utf8'));
    const lines = parseCodexRollout(await readRollout(input.transcript_path));
    await emitTrace(input, environment, dependencies, 'rollout_parsed', {
      lineCount: lines.length,
    });
    let asker = dependencies.asker;
    if (!asker) {
      const apiKey = environment.TYPESAFE_API_KEY;
      if (!apiKey) throw new Error('TYPESAFE_API_KEY is not configured');
      asker = new JevClient({ apiKey, model: config.model });
    }
    const plan = await buildCodexPlan(
      lines,
      tracedAsker(asker, input, environment, dependencies, config.model),
      planOptions(config, input, createdAt),
    );
    const ratio = reductionRatio(plan);
    const summary = planSummary(plan);

    await emitTrace(input, environment, dependencies, 'plan_ready', {
      summary,
      reductionRatio: ratio,
      activeItemCount: plan.activeWindow.itemCount,
      latestCompactionLineIndex: plan.activeWindow.latestCompactionLineIndex,
      calls: plan.stats.calls,
      requests: plan.stats.requests,
      actions: plan.actions.map((action) => ({
        id: action.id,
        callId: action.callId,
        tool: action.tool,
        action: action.action,
        reason: action.reason,
        keepCall: action.keepCall,
        keepResult: action.keepResult,
        inputPreview: action.inputPreview,
        resultPreview: action.resultPreview,
        resultOmittedChars: action.resultOmittedChars,
      })),
    });

    if (ratio < config.minReductionRatio) {
      const reason = `Jev reduction ${Math.round(ratio * 100)}% is below the configured ${Math.round(
        config.minReductionRatio * 100,
      )}% minimum`;
      await savePendingBestEffort(statePath, {
        schemaVersion: 1,
        status: 'fallback',
        createdAt,
        rolloutPath: input.transcript_path,
        reductionRatio: ratio,
        summary,
        error: reason,
      });
      await emitTrace(input, environment, dependencies, 'fallback', {
        reason,
        summary,
      });
      return fallbackMessage(reason);
    }

    const note = renderCodexRecoveryNote(plan);
    try {
      await writePending(statePath, {
        schemaVersion: 1,
        status: 'ready',
        createdAt,
        rolloutPath: input.transcript_path,
        reductionRatio: ratio,
        summary,
        note,
      });
    } catch (error) {
      await emitTrace(input, environment, dependencies, 'fallback', {
        reason: `could not persist recovery note: ${errorText(error)}`,
        summary,
      });
      return fallbackMessage(`could not persist recovery note: ${errorText(error)}`);
    }

    await emitTrace(input, environment, dependencies, 'recovery_note_ready', {
      summary,
      noteChars: note.length,
    });

    return {
      systemMessage: `fast-jev-codex: recovery note prepared before native Codex compaction (${summary}).`,
    };
  } catch (error) {
    await savePendingBestEffort(statePath, {
      schemaVersion: 1,
      status: 'fallback',
      createdAt,
      rolloutPath: input.transcript_path,
      error: errorText(error),
    });
    await emitTrace(input, environment, dependencies, 'fallback', {
      reason: errorText(error),
    });
    return fallbackMessage(errorText(error));
  }
}

function boundedNote(note: string): string {
  if (note.length <= RECOVERY_NOTE_LIMIT) return note;
  const suffix = '\n\n[fast-jev-codex recovery note truncated; use native history.read_item for exact details]';
  return `${note.slice(0, Math.max(0, RECOVERY_NOTE_LIMIT - suffix.length))}${suffix}`;
}

async function runCompactSessionStart(
  input: CodexHookInput,
  environment: Environment,
  dependencies: CodexHookDependencies,
): Promise<CodexHookOutput> {
  const path = pendingPath(input, environment, dependencies);
  await emitTrace(input, environment, dependencies, 'session_start_received', {
    source: input.source,
  });
  const pending = await readPending(path);
  if (!pending || pending.consumedAt) {
    await emitTrace(input, environment, dependencies, 'session_start_no_pending');
    return {};
  }

  const consumed = { ...pending, consumedAt: currentTime(dependencies) };
  await savePendingBestEffort(path, consumed);

  if (pending.status !== 'ready' || !pending.note) {
    await emitTrace(input, environment, dependencies, 'recovery_note_missing', {
      status: pending.status,
      error: pending.error,
    });
    return {
      systemMessage:
        'fast-jev-codex: native Codex compaction completed without a Jev recovery note.',
    };
  }

  const additionalContext = [
    'Fast Jev recovery note loaded after native Codex compaction.',
    'Codex native history, notes, and compaction state are the source of truth. Use history.read_item for exact details; never edit the rollout JSONL.',
    '',
    boundedNote(pending.note),
  ].join('\n');
  await emitTrace(input, environment, dependencies, 'recovery_note_loaded', {
    summary: pending.summary,
    noteChars: pending.note.length,
  });
  return {
    systemMessage: 'fast-jev-codex: recovery note loaded after native compaction.',
    hookSpecificOutput: {
      hookEventName: 'SessionStart',
      additionalContext,
    },
  };
}

async function runSessionStart(
  input: CodexHookInput,
  environment: Environment,
  dependencies: CodexHookDependencies,
): Promise<CodexHookOutput> {
  if (input.source === 'compact') {
    return runCompactSessionStart(input, environment, dependencies);
  }
  await emitTrace(input, environment, dependencies, 'session_start_received', {
    source: input.source,
  });
  return {};
}

export async function runCodexHook(
  input: CodexHookInput,
  environment: Environment = process.env,
  dependencies: CodexHookDependencies = {},
): Promise<CodexHookOutput> {
  const effectiveEnvironment =
    environment === process.env
      ? await loadConfigEnvironment(environment)
      : environment;
  const tracedDependencies =
    dependencies.trace || environment !== process.env
      ? dependencies
      : { ...dependencies, trace: appendCodexTrace };
  if (input.hook_event_name === 'PreCompact') {
    return runPreCompact(input, effectiveEnvironment, tracedDependencies);
  }
  if (input.hook_event_name === 'SessionStart') {
    return runSessionStart(input, effectiveEnvironment, tracedDependencies);
  }
  return {};
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export async function main(): Promise<void> {
  let output: CodexHookOutput;
  try {
    output = await runCodexHook(parseCodexHookInput(await readStdin()));
  } catch (error) {
    output = fallbackMessage(errorText(error));
  }
  process.stdout.write(`${JSON.stringify(output)}\n`);
}

const entrypoint = process.argv[1];
if (
  entrypoint &&
  realpathSync.native(entrypoint) === realpathSync.native(fileURLToPath(import.meta.url))
)
  void main();
