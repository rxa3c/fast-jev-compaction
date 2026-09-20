import { describe, expect, it } from 'vitest';

import { compactWithAdapter, type HostCompactionAdapter } from '../src/adapters.js';
import type { JevAsker, JevQuestions, Message } from '../src/types.js';

function fakeJev(): JevAsker {
  return {
    async ask(_state, questions: JevQuestions) {
      return {
        answers: Object.fromEntries(
          Object.keys(questions).map((name) => [
            name,
            { type: 'noul' as const, noul: name.startsWith('result_') ? 0.1 : 0.9 },
          ]),
        ),
      };
    },
  };
}

describe('host adapter boundary', () => {
  it('keeps host projection and materialisation outside the shared Jev core', async () => {
    const input: Message[] = [
      { role: 'user', text: 'goal', toolUses: [] },
      {
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: 'call-1', tool: 'Read', input: { file_path: 'a.ts' } }],
      },
      { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'call-1', text: 'file contents' }] },
    ];
    const adapter: HostCompactionAdapter<Message[], string, string> = {
      name: 'test-host',
      materialization: 'replace',
      project(messages) {
        return { messages, references: 'source-handle' };
      },
      apply(_messages, projection, result) {
        return `${projection.references}:${result.decisions[0]?.action}`;
      },
    };

    const output = await compactWithAdapter(adapter, input, fakeJev(), {
      preserveRecentMessages: 0,
    });

    expect(adapter.name).toBe('test-host');
    expect(output.output).toBe('source-handle:drop_result');
    expect(output.result.stats.calls).toBe(1);
  });
});
