#!/usr/bin/env node

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { JevClient } from './client.js';
import { loadConfigEnvironment } from './config.js';
import {
  buildCodexPlan,
  parseCodexRollout,
  renderCodexRecoveryNote,
} from './codex.js';

const USAGE = `Usage:
  fast-jev-codex plan --rollout <path> [options]

Options:
  --output <path>                 JSON plan path; omit or use - for stdout
  --note <path>                   Markdown note draft path
  --goal <text>                   current task goal
  --keep-threshold <number>       Jev keep threshold
  --preserve-recent-messages <n>  newest projected messages to pin
  --max-state-tokens <n>          Jev state ceiling
  --max-request-tokens <n>        Jev request ceiling
  --truncate-head-chars <n>       head kept for dropped results
  --note-result-chars <n>         kept result chars copied to the note draft

Environment:
  TYPESAFE_API_KEY   API key used by JevClient
  FAST_JEV_CONFIG    optional path to an env-style config file

The command reads a Codex rollout, writes an auditable Jev plan and note draft,
and never rewrites the rollout itself.`;

function option(args: readonly string[], name: string): string | undefined {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

function numberOption(args: readonly string[], name: string): number | undefined {
  const value = option(args, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) throw new Error(`${name} must be a finite number`);
  return parsed;
}

async function writeOutput(path: string | undefined, content: string): Promise<void> {
  if (!path || path === '-') {
    process.stdout.write(content);
    return;
  }
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content, 'utf8');
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (args[0] !== 'plan') throw new Error(`unknown command: ${args[0]}\n\n${USAGE}`);

  const rolloutPath = option(args, '--rollout');
  if (!rolloutPath) throw new Error(`--rollout is required\n\n${USAGE}`);
  const outputPath = option(args, '--output');
  const notePath = option(args, '--note');
  const environment = await loadConfigEnvironment();
  const absoluteRolloutPath = resolve(rolloutPath);
  const rollout = parseCodexRollout(await readFile(absoluteRolloutPath, 'utf8'));
  const plan = await buildCodexPlan(
    rollout,
    new JevClient({
      apiKey: environment.TYPESAFE_API_KEY,
      model: environment.FAST_JEV_MODEL,
    }),
    {
      rolloutPath: absoluteRolloutPath,
      goal: option(args, '--goal'),
      keepThreshold: numberOption(args, '--keep-threshold'),
      preserveRecentMessages: numberOption(args, '--preserve-recent-messages'),
      maxStateTokens: numberOption(args, '--max-state-tokens'),
      maxRequestTokens: numberOption(args, '--max-request-tokens'),
      truncateHeadChars: numberOption(args, '--truncate-head-chars'),
      noteResultChars: numberOption(args, '--note-result-chars'),
    },
  );

  await writeOutput(outputPath, `${JSON.stringify(plan, null, 2)}\n`);
  if (notePath) await writeOutput(notePath, renderCodexRecoveryNote(plan));
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`fast-jev-codex: ${message}\n`);
  process.exitCode = 1;
});
