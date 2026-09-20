import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  parseCodexHookInput,
  resolveCodexHookConfig,
  runCodexHook,
} from '../src/codex-hook.js';
import { loadConfigEnvironment } from '../src/config.js';
import type { JevAsker, JevQuestions } from '../src/types.js';

const fixedNow = () => new Date('2026-09-20T00:00:00.000Z');

function rolloutFixture(): string {
  return [
    {
      type: 'response_item',
      payload: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'Fix the failing test.' }],
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call',
        call_id: 'call-1',
        name: 'exec_command',
        arguments: '{"cmd":"npm test"}',
      },
    },
    {
      type: 'response_item',
      payload: {
        type: 'function_call_output',
        call_id: 'call-1',
        output: 'one failing test with a detailed stack trace',
      },
    },
  ]
    .map((line) => JSON.stringify(line))
    .join('\n');
}

function fakeJev(answer: (name: string) => number): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [
            name,
            { type: 'noul' as const, noul: answer(name) },
          ]),
        ),
      };
    },
  };
}

describe('Codex lifecycle hook', () => {
  it('loads an env-style config file without overriding explicit variables', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fast-jev-config-'));
    const configPath = join(directory, 'fast-jev.env');
    try {
      await writeFile(
        configPath,
        'TYPESAFE_API_KEY=file-key\nFAST_JEV_MODEL=jev-from-file\n',
        'utf8',
      );
      const environment = await loadConfigEnvironment({
        FAST_JEV_CONFIG: configPath,
        TYPESAFE_API_KEY: 'explicit-key',
      });
      expect(environment.TYPESAFE_API_KEY).toBe('explicit-key');
      expect(environment.FAST_JEV_MODEL).toBe('jev-from-file');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('parses hook input and resolves environment configuration', () => {
    expect(parseCodexHookInput('{"hook_event_name":"SessionStart"}')).toEqual({
      hook_event_name: 'SessionStart',
    });
    expect(
      resolveCodexHookConfig({
        TYPESAFE_API_KEY: 'secret',
        FAST_JEV_MODEL: 'jev-test',
        FAST_JEV_MIN_REDUCTION_RATIO: '0.1',
        FAST_JEV_NOTE_RESULT_CHARS: '42',
      }),
    ).toMatchObject({
      model: 'jev-test',
      minReductionRatio: 0.1,
      noteResultChars: 42,
    });
  });

  it('persists a Jev note before compaction and injects it after native rollover', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'fast-jev-codex-hook-'));
    try {
      const input = {
        session_id: 'session/one',
        transcript_path: '/tmp/fixture.jsonl',
        hook_event_name: 'PreCompact',
        trigger: 'auto',
      };
      const dependencies = {
        dataRoot,
        now: fixedNow,
        readRollout: async () => rolloutFixture(),
        asker: fakeJev(() => 0.1),
      };

      const before = await runCodexHook(
        input,
        {
          TYPESAFE_API_KEY: 'secret',
          FAST_JEV_MIN_REDUCTION_RATIO: '0.1',
          FAST_JEV_PRESERVE_RECENT_MESSAGES: '0',
        },
        dependencies,
      );
      expect(before.systemMessage).toContain('recovery note prepared');

      const after = await runCodexHook(
        {
          session_id: input.session_id,
          hook_event_name: 'SessionStart',
          source: 'compact',
        },
        { FAST_JEV_PRESERVE_RECENT_MESSAGES: '0' },
        dependencies,
      );
      expect(after.hookSpecificOutput?.additionalContext).toContain(
        'Fast Jev recovery note',
      );
      expect(after.hookSpecificOutput?.additionalContext).toContain('history');
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('falls back to native compaction when the TypeSafe key is missing', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'fast-jev-codex-hook-'));
    try {
      const output = await runCodexHook(
        {
          session_id: 'missing-key',
          transcript_path: '/tmp/fixture.jsonl',
          hook_event_name: 'PreCompact',
        },
        { FAST_JEV_PRESERVE_RECENT_MESSAGES: '0' },
        {
          dataRoot,
          now: fixedNow,
          readRollout: async () => rolloutFixture(),
        },
      );
      expect(output.systemMessage).toContain('fallback to native Codex compaction');
      expect(output.systemMessage).toContain('TYPESAFE_API_KEY');
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('ignores lifecycle events that do not belong to the compaction boundary', async () => {
    await expect(
      runCodexHook({ hook_event_name: 'SessionStart', source: 'startup' }),
    ).resolves.toEqual({});
  });
});
