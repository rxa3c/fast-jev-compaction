import { compactWithAdapter } from './adapters.js';
import { resolveOptions } from './compact.js';
import { collectToolCalls } from './state.js';
import type {
  CallDecision,
  CompactOptions,
  CompactResult,
  JevAsker,
  Message,
  ToolCall,
} from './types.js';
import type { HostCompactionAdapter, HostProjection } from './adapters.js';

/** A decoded line from a Codex JSONL rollout. Unknown fields are preserved. */
export interface CodexRolloutLine {
  timestamp?: string;
  ordinal?: number;
  type?: string;
  payload?: unknown;
  lineNumber?: number;
  [key: string]: unknown;
}

/** A Responses API item persisted in a rollout or compaction checkpoint. */
export type CodexResponseItem = Record<string, unknown> & { type: string };

export interface CodexActiveItem {
  item: CodexResponseItem;
  activeIndex: number;
  rolloutLineIndex: number;
  ordinal?: number;
  source: 'rollout' | 'replacement_history';
}

export interface CodexActiveWindow {
  items: CodexActiveItem[];
  latestCompactionLineIndex: number | null;
  latestCompactionOrdinal?: number;
  windowNumber?: number;
}

export interface CodexSourceReference {
  activeIndex: number;
  rolloutLineIndex: number;
  ordinal?: number;
  source: CodexActiveItem['source'];
  itemId?: string;
}

export interface CodexPlanAction {
  id: string;
  callId: string;
  tool: string;
  action: CallDecision['action'];
  reason: CallDecision['reason'];
  keepCall: number;
  keepResult: number;
  resultChars: number;
  isError: boolean;
  inputPreview: string;
  resultPreview?: string;
  resultOmittedChars?: number;
  call: CodexSourceReference | null;
  result: CodexSourceReference | null;
}

export interface CodexPlan {
  schemaVersion: 1;
  kind: 'fast-jev-codex-plan';
  createdAt: string;
  rolloutPath?: string;
  nativeContext: {
    mode: 'native-notes-advisor';
    sourceOfTruth: 'codex-history-and-notes';
    applyToRollout: false;
    notePathHint: string;
    writeTool: 'notes.write_file';
    readTools: ['notes.read_file', 'history.read_item'];
    nextStep: string;
  };
  activeWindow: {
    itemCount: number;
    latestCompactionLineIndex: number | null;
    latestCompactionOrdinal?: number;
    windowNumber?: number;
  };
  actions: CodexPlanAction[];
  stats: CompactResult['stats'];
}

export type CodexPlanOptions = CompactOptions & {
  /** Included in the plan for auditability; it is never modified. */
  rolloutPath?: string;
  /** Testable clock override. */
  now?: string;
  /** Maximum exact result characters copied into the notes draft for kept results. */
  noteResultChars?: number;
};

interface ParsedCall {
  id: string;
  tool: string;
  input: Record<string, unknown>;
}

export interface CodexProjection {
  messages: Message[];
  callSources: Map<string, CodexSourceReference>;
  resultSources: Map<string, CodexSourceReference>;
  callInputs: Map<string, Record<string, unknown>>;
  resultTexts: Map<string, string>;
  activeWindow: CodexActiveWindow;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function itemId(item: CodexResponseItem): string | undefined {
  return stringValue(item.id) ?? stringValue(item.call_id);
}

function parseJsonObject(value: unknown): Record<string, unknown> | undefined {
  const object = record(value);
  if (object) return object;
  if (typeof value !== 'string') return undefined;
  try {
    return record(JSON.parse(value));
  } catch {
    return undefined;
  }
}

function toolName(item: CodexResponseItem): string {
  const name = stringValue(item.name);
  const namespace = stringValue(item.namespace);
  if (name && namespace) return `${namespace}.${name}`;
  if (name) return name;
  return item.type;
}

function parseCall(item: CodexResponseItem): ParsedCall | undefined {
  if (
    item.type !== 'function_call' &&
    item.type !== 'custom_tool_call' &&
    item.type !== 'local_shell_call'
  ) {
    return undefined;
  }
  const id = stringValue(item.call_id) ?? stringValue(item.id);
  if (!id) return undefined;
  const input =
    item.type === 'function_call'
      ? parseJsonObject(item.arguments)
      : item.type === 'custom_tool_call'
        ? parseJsonObject(item.input) ??
          (typeof item.input === 'string' ? { input: item.input } : undefined)
        : parseJsonObject(item.action);
  return input ? { id, tool: toolName(item), input } : undefined;
}

function outputCallId(item: CodexResponseItem): string | undefined {
  if (
    item.type !== 'function_call_output' &&
    item.type !== 'custom_tool_call_output'
  ) {
    return undefined;
  }
  return stringValue(item.call_id) ?? stringValue(item.id);
}

function textFromContent(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) {
    const parts: string[] = [];
    for (const part of value) {
      if (typeof part === 'string') {
        parts.push(part);
        continue;
      }
      const object = record(part);
      const text = object && stringValue(object.text);
      if (text !== undefined) parts.push(text);
    }
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  const object = record(value);
  return object ? stringValue(object.text) : undefined;
}

/** Returns text only when a tool output is losslessly representable as text. */
function textFromToolOutput(value: unknown): string | undefined {
  if (typeof value === 'string') return value;
  if (!Array.isArray(value)) return undefined;
  const parts: string[] = [];
  for (const part of value) {
    const object = record(part);
    if (!object) return undefined;
    const type = stringValue(object.type);
    const text = stringValue(object.text);
    if (
      (type !== 'input_text' && type !== 'output_text') ||
      text === undefined
    ) {
      return undefined;
    }
    parts.push(text);
  }
  return parts.join('\n');
}

function safeJson(value: unknown): string | undefined {
  try {
    return JSON.stringify(value);
  } catch {
    return undefined;
  }
}

function renderOpaqueTool(item: CodexResponseItem): string {
  return `[Codex tool call kept opaque: ${toolName(item)}]`;
}

function renderOpaqueOutput(_item: CodexResponseItem): string {
  return '[Codex tool output kept opaque]';
}

function renderUnsupportedItem(item: CodexResponseItem): string {
  if (item.type === 'message' || item.type === 'agent_message') {
    return textFromContent(item.content) ?? `[Codex ${item.type} kept opaque]`;
  }
  if (item.type === 'reasoning') {
    return textFromContent(item.summary) ?? '[Codex reasoning kept opaque]';
  }
  return `[Codex ${item.type} item kept opaque]`;
}

function roleForItem(item: CodexResponseItem): Message['role'] {
  return item.type === 'message' && item.role === 'user' ? 'user' : 'assistant';
}

function toReference(active: CodexActiveItem): CodexSourceReference {
  return {
    activeIndex: active.activeIndex,
    rolloutLineIndex: active.rolloutLineIndex,
    ordinal: active.ordinal,
    source: active.source,
    itemId: itemId(active.item),
  };
}

export function parseCodexRollout(text: string): CodexRolloutLine[] {
  const lines: CodexRolloutLine[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    if (raw.trim().length === 0) continue;
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid Codex rollout JSON on line ${index + 1}: ${detail}`);
    }
    const object = record(value);
    if (!object) {
      throw new Error(`Codex rollout line ${index + 1} is not a JSON object`);
    }
    lines.push({
      ...object,
      timestamp: stringValue(object.timestamp),
      ordinal: numberValue(object.ordinal),
      type: stringValue(object.type),
      payload: object.payload,
      lineNumber: index,
    });
  }
  return lines;
}

function responseItemFromValue(value: unknown): CodexResponseItem | undefined {
  const object = record(value);
  if (!object) return undefined;
  const item = record(object.item) ?? object;
  return typeof item.type === 'string' ? (item as CodexResponseItem) : undefined;
}

function responseItemFromLine(line: CodexRolloutLine): CodexResponseItem | undefined {
  return line.type === 'response_item' ? responseItemFromValue(line.payload) : undefined;
}

function compactedPayload(line: CodexRolloutLine): Record<string, unknown> | undefined {
  return line.type === 'compacted' ? record(line.payload) : undefined;
}

export function selectActiveCodexWindow(
  lines: readonly CodexRolloutLine[],
): CodexActiveWindow {
  let latestCompactionIndex = -1;
  let latestCompaction: Record<string, unknown> | undefined;
  for (let index = 0; index < lines.length; index += 1) {
    const payload = compactedPayload(lines[index]);
    if (payload) {
      latestCompactionIndex = index;
      latestCompaction = payload;
    }
  }

  const items: CodexActiveItem[] = [];
  const replacement = latestCompaction
    ? Array.isArray(latestCompaction.replacement_history)
      ? latestCompaction.replacement_history
          .map(responseItemFromValue)
          .filter((item): item is CodexResponseItem => item !== undefined)
      : undefined
    : undefined;
  const checkpointLine = lines[latestCompactionIndex];
  const checkpointLineIndex = checkpointLine?.lineNumber ?? latestCompactionIndex;

  if (replacement) {
    for (const item of replacement) {
      items.push({
        item,
        activeIndex: items.length,
        rolloutLineIndex: checkpointLineIndex,
        ordinal: numberValue(checkpointLine?.ordinal),
        source: 'replacement_history',
      });
    }
  } else if (latestCompaction) {
    const message = stringValue(latestCompaction.message);
    if (message && message.trim().length > 0) {
      items.push({
        item: {
          type: 'message',
          role: 'assistant',
          content: [{ type: 'output_text', text: message }],
        },
        activeIndex: items.length,
        rolloutLineIndex: checkpointLineIndex,
        ordinal: numberValue(checkpointLine?.ordinal),
        source: 'rollout',
      });
    }
  }

  const tailStart = latestCompactionIndex >= 0 ? latestCompactionIndex + 1 : 0;
  for (let index = tailStart; index < lines.length; index += 1) {
    const item = responseItemFromLine(lines[index]);
    if (!item) continue;
    items.push({
      item,
      activeIndex: items.length,
      rolloutLineIndex: lines[index]?.lineNumber ?? index,
      ordinal: numberValue(lines[index]?.ordinal),
      source: 'rollout',
    });
  }

  return {
    items,
    latestCompactionLineIndex:
      latestCompactionIndex >= 0 ? checkpointLineIndex : null,
    latestCompactionOrdinal: numberValue(checkpointLine?.ordinal),
    windowNumber: numberValue(latestCompaction?.window_number),
  };
}

export function projectActiveCodexWindow(window: CodexActiveWindow): CodexProjection {
  const projection: CodexProjection = {
    messages: [],
    callSources: new Map(),
    resultSources: new Map(),
    callInputs: new Map(),
    resultTexts: new Map(),
    activeWindow: window,
  };

  for (const active of window.items) {
    const item = active.item;
    const call = parseCall(item);
    if (call) {
      projection.messages.push({
        role: 'assistant',
        text: '',
        toolUses: [{ tool_use_id: call.id, tool: call.tool, input: call.input }],
      });
      projection.callSources.set(call.id, toReference(active));
      projection.callInputs.set(call.id, call.input);
      continue;
    }

    const resultId = outputCallId(item);
    if (resultId) {
      const text = textFromToolOutput(item.output);
      if (text !== undefined) {
        projection.messages.push({
          role: 'user',
          text: '',
          toolUses: [],
          toolResults: [{ tool_use_id: resultId, text }],
        });
        projection.resultSources.set(resultId, toReference(active));
        projection.resultTexts.set(resultId, text);
      } else {
        projection.messages.push({
          role: 'user',
          text: renderOpaqueOutput(item),
          toolUses: [],
        });
      }
      continue;
    }

    const isToolCall =
      item.type === 'function_call' ||
      item.type === 'custom_tool_call' ||
      item.type === 'local_shell_call';
    projection.messages.push({
      role: roleForItem(item),
      text: isToolCall ? renderOpaqueTool(item) : renderUnsupportedItem(item),
      toolUses: [],
    });
  }
  return projection;
}

function bounded(text: string, limit: number): { text: string; omitted: number } {
  if (limit <= 0) return { text: '', omitted: text.length };
  return text.length <= limit
    ? { text, omitted: 0 }
    : { text: text.slice(0, limit), omitted: text.length - limit };
}

function actionForCall(
  decision: CallDecision,
  call: ToolCall,
  projection: CodexProjection,
  options: CodexPlanOptions,
  noteResultChars: number,
): CodexPlanAction {
  const resultText = projection.resultTexts.get(call.tool_use_id);
  const resultLimit =
    decision.action === 'drop_result'
      ? options.truncateHeadChars ?? 300
      : noteResultChars;
  const result = resultText === undefined ? undefined : bounded(resultText, resultLimit);
  return {
    id: decision.id,
    callId: call.tool_use_id,
    tool: decision.tool,
    action: decision.action,
    reason: decision.reason,
    keepCall: decision.keepCall,
    keepResult: decision.keepResult,
    resultChars: call.resultChars,
    isError: call.isError,
    inputPreview: bounded(safeJson(projection.callInputs.get(call.tool_use_id)) ?? '{}', 500).text,
    resultPreview:
      decision.action === 'drop_call' || result === undefined ? undefined : result.text,
    resultOmittedChars:
      decision.action === 'drop_call' || result === undefined ? undefined : result.omitted,
    call: projection.callSources.get(call.tool_use_id) ?? null,
    result: projection.resultSources.get(call.tool_use_id) ?? null,
  };
}

export async function buildCodexPlan(
  lines: readonly CodexRolloutLine[],
  asker: JevAsker,
  options: CodexPlanOptions = {},
): Promise<CodexPlan> {
  const resolved = resolveOptions(options);
  const adapter = createCodexAdapter(options);
  const output = await compactWithAdapter(adapter, lines, asker, resolved);
  return output.output;
}

export function createCodexAdapter(
  options: CodexPlanOptions = {},
): HostCompactionAdapter<readonly CodexRolloutLine[], CodexPlan, CodexProjection> {
  return {
    name: 'codex',
    materialization: 'augment',
    project(lines): HostProjection<CodexProjection> {
      const window = selectActiveCodexWindow(lines);
      const projection = projectActiveCodexWindow(window);
      return { messages: projection.messages, references: projection };
    },
    apply(
      _lines,
      projection: HostProjection<CodexProjection>,
      result,
    ): CodexPlan {
      const codexProjection = projection.references;
      if (!codexProjection) throw new Error('Codex adapter projection is missing references');
      const resolved = resolveOptions(options);
      const calls = collectToolCalls(codexProjection.messages, resolved.preserveRecentMessages);
      const callsById = new Map(calls.map((call) => [call.id, call]));
      const noteResultChars = Math.max(0, Math.floor(options.noteResultChars ?? 800));
      const actions = result.decisions.map((decision) => {
        const call = callsById.get(decision.id);
        if (!call) throw new Error(`Jev decision refers to missing Codex call ${decision.id}`);
        return actionForCall(
          decision,
          call,
          codexProjection,
          options,
          noteResultChars,
        );
      });
      const windowName = codexProjection.activeWindow.windowNumber ?? 'latest';
      return {
        schemaVersion: 1,
        kind: 'fast-jev-codex-plan',
        createdAt: options.now ?? new Date().toISOString(),
        rolloutPath: options.rolloutPath,
        nativeContext: {
          mode: 'native-notes-advisor',
          sourceOfTruth: 'codex-history-and-notes',
          applyToRollout: false,
          notePathHint: `fast-jev/window-${windowName}.md`,
          writeTool: 'notes.write_file',
          readTools: ['notes.read_file', 'history.read_item'],
          nextStep:
            'Review this plan, write the recovery note with Codex notes.write_file, then use the native new_context tool.',
        },
        activeWindow: {
          itemCount: codexProjection.activeWindow.items.length,
          latestCompactionLineIndex: codexProjection.activeWindow.latestCompactionLineIndex,
          latestCompactionOrdinal: codexProjection.activeWindow.latestCompactionOrdinal,
          windowNumber: codexProjection.activeWindow.windowNumber,
        },
        actions,
        stats: result.stats,
      };
    },
  };
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n');
}

export function renderCodexRecoveryNote(plan: CodexPlan): string {
  const lines = [
    '# Fast Jev Codex recovery note',
    '',
    'This is a Jev decision aid for one Codex history window.',
    'Codex native history and notes remain the source of truth.',
    '',
    `Window: ${plan.activeWindow.windowNumber ?? 'latest'}`,
    `Active items: ${plan.activeWindow.itemCount}`,
    `Decisions: ${plan.actions.length}`,
    '',
    '## Tool decisions',
    '',
  ];

  if (plan.actions.length === 0) {
    lines.push('No paired text tool calls were found in this window.');
  } else {
    for (const action of plan.actions) {
      const callLine = action.call ? action.call.rolloutLineIndex : '?';
      const resultLine = action.result ? action.result.rolloutLineIndex : '?';
      lines.push(
        `- ${action.id} ${action.tool}: ${action.action} (call=${action.keepCall.toFixed(2)}, result=${action.keepResult.toFixed(2)}; call line ${callLine}, result line ${resultLine})`,
      );
      lines.push(`  input: ${action.inputPreview}`);
      if (action.resultPreview !== undefined) {
        lines.push('  result preview:');
        lines.push(indent(action.resultPreview));
        if ((action.resultOmittedChars ?? 0) > 0) {
          lines.push(`  [${action.resultOmittedChars} result chars omitted]`);
        }
      }
    }
  }

  lines.push(
    '',
    '## Native Codex follow-up',
    '',
    `Write this note with notes.write_file at ${plan.nativeContext.notePathHint}.`,
    'Use history.read_item when an exact item is needed instead of copying a full rollout.',
    'After the note is saved, use the native new_context tool and read this note in the new window.',
    '',
  );
  return lines.join('\n');
}
