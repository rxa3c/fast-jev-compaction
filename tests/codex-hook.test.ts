import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
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
  it('ships a discoverable legacy manifest and commands using host-provided variables', async () => {
    const root = fileURLToPath(new URL('../', import.meta.url));
    // AgentPlugin-format root manifests shadow the legacy manifest and disable hooks.
    expect(existsSync(join(root, 'plugin.json'))).toBe(false);
    const manifest = JSON.parse(await readFile(join(root, '.codex-plugin/plugin.json'), 'utf8'));
    expect(manifest.hooks).toBe('./hooks/codex-hooks.json');
    const definitions = JSON.parse(await readFile(join(root, manifest.hooks), 'utf8'));
    for (const path of ['hooks/hooks.json', '.codex-plugin/hooks.json']) {
      const fallback = JSON.parse(await readFile(join(root, path), 'utf8'));
      expect(fallback.hooks).toEqual(definitions.hooks);
    }
    const directory = await mkdtemp(join(tmpdir(), 'fast-jev-command-'));
    try {
      const result = spawnSync('/bin/sh', ['-c', definitions.hooks.SessionStart[0].hooks[0].command], {
        cwd: directory,
        env: {
          PATH: process.env.PATH,
          HOME: directory,
          PLUGIN_ROOT: root,
          PLUGIN_DATA: directory,
          FAST_JEV_TRACE_FILE: join(directory, 'events.jsonl'),
        },
        input: JSON.stringify({ hook_event_name: 'SessionStart', session_id: 'command-test', source: 'startup', cwd: directory }),
        encoding: 'utf8',
        timeout: 10000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(JSON.parse(result.stdout)).toEqual({});
      const trace = await readFile(join(directory, 'events.jsonl'), 'utf8');
      expect(trace).toContain('session_start_received');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

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

  it('does not let a blank plugin API key erase the user config', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'fast-jev-config-'));
    const userConfig = join(directory, '.config', 'fast-jev-compaction');
    const pluginRoot = join(directory, 'plugin');
    try {
      await mkdir(userConfig, { recursive: true });
      await mkdir(pluginRoot);
      await writeFile(join(userConfig, '.env'), 'TYPESAFE_API_KEY=user-key\n');
      for (const blank of ['', '""', "''", '"   "']) {
        await writeFile(join(pluginRoot, '.env'), `TYPESAFE_API_KEY=${blank}\n`);
        const environment = await loadConfigEnvironment({ HOME: directory, PLUGIN_ROOT: pluginRoot });
        expect(environment.TYPESAFE_API_KEY).toBe('user-key');
      }
      await writeFile(join(pluginRoot, '.env'), 'TYPESAFE_API_KEY=plugin-key\n');
      const environment = await loadConfigEnvironment({ HOME: directory, PLUGIN_ROOT: pluginRoot });
      expect(environment.TYPESAFE_API_KEY).toBe('plugin-key');
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
      const traceEvents: Array<Record<string, unknown>> = [];
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
        trace: async (event) => {
          traceEvents.push(event);
        },
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
      expect(traceEvents.map((event) => event.event)).toEqual(
        expect.arrayContaining([
          'precompact_started',
          'rollout_parsed',
          'jev_request_started',
          'jev_response_received',
          'plan_ready',
          'recovery_note_ready',
          'session_start_received',
          'recovery_note_loaded',
        ]),
      );
      const planEvent = traceEvents.find((event) => event.event === 'plan_ready');
      expect(planEvent?.actions).toHaveLength(1);
    } finally {
      await rm(dataRoot, { recursive: true, force: true });
    }
  });

  it('records why a low-reduction plan has no recovery note', async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), 'fast-jev-low-reduction-'));
    const traceEvents: Array<Record<string, unknown>> = [];
    const dependencies = {
      dataRoot,
      readRollout: async () => rolloutFixture(),
      asker: fakeJev(() => 0.9),
      trace: async (event: Record<string, unknown>) => { traceEvents.push(event); },
    };
    try {
      const before = await runCodexHook({ session_id: 'low', hook_event_name: 'PreCompact', transcript_path: '/fixture' },
        { FAST_JEV_PRESERVE_RECENT_MESSAGES: '0' }, dependencies);
      expect(before.systemMessage).toContain('below the configured');
      expect(traceEvents.find(event => event.event === 'fallback')?.reason).toContain('below the configured');
      await runCodexHook({ session_id: 'low', hook_event_name: 'SessionStart', source: 'compact' }, {}, dependencies);
      expect(traceEvents.find(event => event.event === 'recovery_note_missing')?.error).toContain('below the configured');
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
