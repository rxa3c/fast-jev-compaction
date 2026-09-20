import { describe, expect, it } from 'vitest';

import {
  buildCodexPlan,
  parseCodexRollout,
  projectActiveCodexWindow,
  renderCodexRecoveryNote,
  selectActiveCodexWindow,
  type CodexRolloutLine,
} from '../src/codex.js';
import type { JevAsker, JevQuestions } from '../src/types.js';

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

function responseItem(payload: Record<string, unknown>): CodexRolloutLine {
  return { type: 'response_item', payload };
}

function compacted(replacementHistory: unknown[], windowNumber = 2): CodexRolloutLine {
  return {
    type: 'compacted',
    ordinal: 8,
    payload: {
      message: '',
      replacement_history: replacementHistory,
      window_number: windowNumber,
    },
  };
}

function replacementHistory(): Record<string, unknown>[] {
  return [
    {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text: 'Keep the context review narrow.' }],
    },
    {
      type: 'function_call',
      id: 'fc-1',
      call_id: 'call-1',
      name: 'exec_command',
      arguments: '{"cmd":"pwd"}',
    },
    {
      type: 'function_call_output',
      call_id: 'call-1',
      output: 'workspace output',
    },
  ];
}

describe('Codex adapter', () => {
  it('selects the latest replacement history and ignores older response items', () => {
    const lines: CodexRolloutLine[] = [
      responseItem({
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: 'old inactive prompt' }],
      }),
      compacted(replacementHistory()),
      responseItem({
        type: 'message',
        role: 'assistant',
        content: [{ type: 'output_text', text: 'tail item' }],
      }),
    ];

    const window = selectActiveCodexWindow(lines);
    const projection = projectActiveCodexWindow(window);
    expect(window.latestCompactionLineIndex).toBe(1);
    expect(window.windowNumber).toBe(2);
    expect(projection.messages.map((message) => message.text)).not.toContain(
      'old inactive prompt',
    );
    expect(projection.messages.map((message) => message.text)).toContain('tail item');
    expect(projection.messages[1]?.toolUses[0]?.tool).toBe('exec_command');
  });

  it('plans text-safe paired calls but excludes opaque output from candidates', async () => {
    const lines: CodexRolloutLine[] = [
      compacted([
        ...replacementHistory(),
        {
          type: 'custom_tool_call',
          call_id: 'call-image',
          name: 'make_image',
          input: '{"prompt":"diagram"}',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'call-image',
          output: [{ type: 'input_image', image_url: 'https://example.test/image.png' }],
        },
        {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: 'done' }],
        },
      ]),
    ];

    const plan = await buildCodexPlan(
      lines,
      fakeJev(() => 0.1),
      { preserveRecentMessages: 1, now: '2026-09-19T00:00:00.000Z' },
    );

    expect(plan.nativeContext.mode).toBe('native-notes-advisor');
    expect(plan.nativeContext.applyToRollout).toBe(false);
    expect(plan.nativeContext.writeTool).toBe('notes.write_file');
    expect(plan.actions).toHaveLength(1);
    expect(plan.actions[0]).toMatchObject({
      callId: 'call-1',
      tool: 'exec_command',
      action: 'drop_call',
    });
    expect(plan.stats.calls).toBe(1);
  });

  it('renders a notes-ready recovery draft for kept results', async () => {
    const plan = await buildCodexPlan(
      [compacted(replacementHistory())],
      fakeJev((name) => (name.startsWith('result_') ? 0.9 : 0.1)),
      { preserveRecentMessages: 0, noteResultChars: 12 },
    );
    const note = renderCodexRecoveryNote(plan);

    expect(plan.actions[0]?.action).toBe('keep');
    expect(plan.actions[0]?.call?.source).toBe('replacement_history');
    expect(note).toContain('notes.write_file');
    expect(note).toContain('work');
    expect(note).toContain('result preview');
    expect(note).toContain('4 result chars omitted');
  });

  it('reports malformed JSONL with its physical line number', () => {
    expect(() => parseCodexRollout('{"type":"session_meta"}\nnot-json')).toThrow(
      /line 2/,
    );
  });
});
