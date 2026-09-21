# fast-jev-compaction

Claude Code and Codex context plugins that use Jev decisions instead of a
generic history summary:
every tool call and result is scored in one fast request, stale ones are
dropped or truncated, everything kept stays verbatim. Also usable as an npm
library.

## What and why

Most context compaction asks an LLM to summarize old turns. A summary is
lossy: a file path, exact error, constraint, or command can disappear even when
it matters later. This library never rewrites anything. It only deletes tool
calls and tool results Jev says are no longer needed, and it asks Jev while
showing it the whole conversation. User and assistant text stays verbatim and
in order.

The repository is both an npm package (`src/`) and host plugins. The Claude
Code plugin lives in (`hooks/`, `.claude-plugin/`); the Codex package lives in
(`.codex-plugin/`, `hooks/`, `skills/`, and the Codex adapter in `src/`). Both
hosts use the same Jev compaction core.

## Host adapter architecture

The Jev policy is host-neutral. `src/compact.ts` owns state fitting, batching,
thresholds, decisions, and fallback behavior. `src/adapters.ts` defines the
small boundary that every host integration implements:

1. `project` maps a host transcript to the shared `Message[]` shape.
2. The shared core asks Jev the call/result questions.
3. `apply` materializes the result using host-specific handles, notes, or
   lifecycle output. The adapter declares whether that output replaces the
   host context or augments it with recovery information.

Claude Code materializes a replacement `SessionMessage[]`. Codex materializes
a plan and recovery note while leaving Codex's native history and compaction
state untouched. A future IDE adapter only needs to implement this boundary;
it should not copy the Jev request or compaction policy.

## How it works

1. Every `tool_use` is paired with its `tool_result` by `tool_use_id`. Calls in
   the first message or in the newest `preserveRecentMessages` messages are
   pinned and never touched.
2. The **state** sent to Jev is the whole conversation so far, oldest first,
   with every tool result replaced by a short note (`ok, 4213 chars (omitted)`).
   Tool inputs are included, texts are included, nothing is summarized.
3. The state is fitted into `maxStateTokens` (25k by default) in stages, each
   applied only if the previous one was not enough: tool inputs truncated to
   1000, then 200, then 60 characters; long texts abridged to head + tail,
   oldest non-pinned messages first; old non-pinned messages collapsed to a
   `[… N chars omitted …]` note; old tool calls reduced to one line each
   (`t12 Read file_path=src/a.ts → ok 480ch`); old call-less messages left
   out; runs of old call-only messages folded into one entry. If it still
   does not fit, compaction throws. Tokens are estimated without a tokenizer (a
   word per six letters, half a token per digit, ~one per other symbol),
   calibrated to land a little above the counts Jev reports.
4. For every non-pinned call Jev gets two `noul` questions: should the **call**
   stay (knowing it was made, with its input, still matters), and should the
   **result** stay verbatim (its contents are still needed and re-running the
   tool would not do).
5. Questions are split into as many requests as needed so state plus questions
   stays under `maxRequestTokens` (30k by default, under Jev's 32k request
   limit). The same full state is resent with every request; requests run
   concurrently and their answers are merged.
6. Decisions per call, against `keepThreshold`:
   - `keepResult ≥ threshold` → keep call and result;
   - else `keepCall ≥ threshold` → keep the call, truncate the result to its
     first `truncateHeadChars` characters plus a one-line note;
   - else → remove the call together with its result.
7. The message list is rebuilt: a message that loses all its content is
   removed, untouched messages are returned as the same objects, and no result
   is ever left without its call.

Jev failures, malformed answers, a missing key, or a history that cannot be
fitted throw; the caller (or the Claude Code hook) decides what to fall back to.

## Install and usage

```sh
npm install fast-jev-compaction
export TYPESAFE_API_KEY=...
```

```ts
import { compactMessages, reductionRatio, type Message } from 'fast-jev-compaction';

const transcript: Message[] = [
  { role: 'user', text: 'Fix the failing test. Never edit src/generated.', toolUses: [] },
  {
    role: 'assistant',
    text: '',
    toolUses: [{ tool_use_id: 'toolu_1', tool: 'Read', input: { file_path: 'src/a.ts' } }],
  },
  { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: 'toolu_1', text: '…file…' }] },
  // …
];

const result = await compactMessages(transcript, { preserveRecentMessages: 4 });
console.log(result.messages, result.decisions, result.stats);
if (reductionRatio(result) < 0.25) {
  // not worth it: keep the original transcript, or summarize instead
}
```

`Message` is a subset of Claude Code's `SessionMessage`, so a session transcript
can be passed in as is.

To bring your own transport, implement `JevAsker` (one `ask(state, questions)`
method) and call `compact(messages, asker, options)`; `buildJevRequest` and
`parseJevResponse` give you the HTTP request body and response validation.
The building blocks (`collectToolCalls`, `fitState`, `batchCalls`,
`decideCall`, `applyDecisions`) are exported too.

`apiKey` defaults to `process.env.TYPESAFE_API_KEY`. Never commit the key or
put it in a source file.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `apiKey` | `TYPESAFE_API_KEY` | TypeSafe API key (`compactMessages`/`JevClient`) |
| `model` | `jev-latest` | Jev model name |
| `baseUrl` | `https://api.typesafe.ai/v1/systemone` | System One endpoint |
| `fetch` | native `fetch` | Injectable fetch implementation for tests |
| `goal` | last 3 user prompts | Ongoing task description included in the state |
| `keepThreshold` | `0.5` | Minimum keep probability for a call or result to stay |
| `preserveRecentMessages` | `6` | Newest messages never touched (the first is always kept) |
| `maxStateTokens` | `25000` | Estimated token ceiling for the state |
| `maxRequestTokens` | `30000` | Estimated ceiling for state plus one batch of questions |
| `truncateHeadChars` | `300` | Characters of a dropped tool result retained before its note |

`result.stats` reports message and character counts before and after, the
per-reason decision counts, the state size in estimated tokens, which fitting
stage was needed, and the number of requests.

## Limitations

- Only tool calls and results are candidates; text messages are never removed
  or shortened in the output (they are only abridged in the state Jev sees).
- Token sizes are estimates from character counts, not a tokenizer.
- Calibration is at the request level; a probability is not a proof that a
  result is safe to delete. The assistant can always re-run the tool.
- The full state is repeated with every request, so a history near the state
  ceiling costs one request per handful of questions.

## Claude Code plugin

The repository root is a Claude Code function-hook plugin: `hooks/fast-jev.ts`
is a thin adapter that feeds `session.compact` transcripts through `src/` and
falls back to Claude Code's built-in summary on errors or insufficient
reduction. See [`hooks/README.md`](hooks/README.md) for configuration and the
Claude Code 2.1.274 type reference.

### Install in Claude Code

Function hooks are an early-access Claude Code feature (2.1.274+), so the
opt-in flag must be set wherever Claude Code runs, e.g. in `~/.claude/settings.json`:

```json
{ "env": { "CLAUDE_CODE_ENABLE_FUNCTION_HOOKS": "1", "TYPESAFE_API_KEY": "<your key>" } }
```

Then add this repository as a plugin marketplace and install the plugin,
either from the shell or as slash commands inside a session:

```sh
claude plugin marketplace add tamaratran/fast-jev-compaction
claude plugin install fast-jev-compaction@fast-jev-compaction
```

The install prompts for the plugin options (API key, thresholds, `truncateHeadChars`,
…); leave them at their defaults to use `TYPESAFE_API_KEY` from the environment.
Restart Claude Code or run `/reload-plugins`. From then on `/compact` (and
auto-compaction) goes through Jev: the toast reads
`fast-jev-compaction: kept N/M messages, no summary (…)` when the pruned history
replaced the built-in summary, or `fallback to built-in summary (…)` when Jev
could not remove enough (short sessions, or when it fails).

To run from a checkout without installing: `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1 claude --plugin-dir .`
from the repository root. No publishing step is required; the marketplace is
just the repo's `.claude-plugin/marketplace.json`.

## Codex support

The Claude Code hook is not reused directly in Codex: the two hosts expose
different lifecycle events and context representations. The Codex plugin uses
the same host-neutral Jev core through a Codex adapter and lifecycle hooks.

Before native Codex compaction, `PreCompact` reads only the active context
window from the current rollout: the latest `compacted` checkpoint's
`replacement_history` plus the active `response_item` tail. It sends a fitted
decision state to Jev, not the raw rollout. Jev results are stored as a pending
recovery note under `PLUGIN_DATA`; native compaction is never blocked or
rewritten. After `SessionStart(source=compact)`, the note is injected as
additional context, while Codex's native history, notes, and opaque compaction
state remain the source of truth.

The automatic path reads the TypeSafe key from the generated `.env` file or
from the hook process environment. For an installed plugin, use the user-level
config file `~/.config/fast-jev-compaction/.env` so the key is not tied to the
plugin cache directory:

```sh
npm install
npm run build
# .env has been generated; if it is missing, run: cp .env.example .env
# Edit .env and set TYPESAFE_API_KEY=<your key>
# Installed plugin alternative: edit ~/.config/fast-jev-compaction/.env
```

Install the repository as a Codex plugin, then review and trust the lifecycle
hooks from `/hooks`. The current Codex loader reads the compatibility manifest
under `.codex-plugin/`: `.codex-plugin/plugin.json` and
`.codex-plugin/hooks.json`. The portable root `plugin.json` and
`hooks/codex-hooks.json` are also included for newer marketplace loaders, while
`hooks/hooks.json` keeps the existing Claude module and an older Codex fallback.
After changing or reinstalling the plugin, fully restart Codex so its app-server
reloads the plugin bundle; starting a new task alone does not reload an already
running app-server. The Git-installed plugin runs the committed `dist/*.js`
runtime, so run `npm run build` before publishing changes.

The CLI remains available for manual diagnostics and offline plan inspection:

```sh
TYPESAFE_API_KEY="<your key>" node dist/codex-cli.js plan \
  --rollout ~/.codex/sessions/<session>.jsonl \
  --output /tmp/fast-jev-plan.json \
  --note /tmp/fast-jev-note.md
```

The library entry point is available as `fast-jev-compaction/codex`, and the
explicit `fast-jev-codex` skill is useful for manual review when a lifecycle
hook is unavailable. The automatic hook and the skill both use
`history.read_item` for exact details and never edit the rollout JSONL.

Hook configuration can be stored in the ignored `.env` file generated from
`.env.example`, or supplied as environment variables. Secrets stay out of
tracked plugin files:

| Variable | Default | Purpose |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | unset | TypeSafe authentication; required when Jev has candidates to score |
| `FAST_JEV_MODEL` | `jev-latest` | Jev model |
| `FAST_JEV_GOAL` | inferred from recent user prompts | Task goal sent with the fitted state |
| `FAST_JEV_MIN_REDUCTION_RATIO` | `0.25` | Minimum reduction before the note is accepted |
| `FAST_JEV_NOTE_RESULT_CHARS` | `800` | Exact result characters copied into the recovery note |
| `FAST_JEV_KEEP_THRESHOLD` | `0.5` | Jev probability threshold |
| `FAST_JEV_PRESERVE_RECENT_MESSAGES` | `6` | Recent messages pinned from deletion decisions |
| `FAST_JEV_MAX_STATE_TOKENS` | `25000` | Fitted Jev state ceiling |
| `FAST_JEV_MAX_REQUEST_TOKENS` | `30000` | Fitted request ceiling |
| `FAST_JEV_TRUNCATE_HEAD_CHARS` | `300` | Result head retained for a dropped result |
| `FAST_JEV_TRACE_FILE` | `~/.config/fast-jev-compaction/events.jsonl` | Optional local JSONL trace consumed by the live web viewer |
| `FAST_JEV_CONFIG` | unset | Optional path to another env-style config file |
| `PLUGIN_DATA` | host-defined | Directory for the pending per-session recovery note |

This integration deliberately advises Codex's native context manager instead
of replacing it. Jev makes structured keep/drop decisions; Codex owns context
windows, opaque compaction state, and note-based recovery.

## Development

```sh
npm install
npm run typecheck        # library + hook
npm test
npm run build
npm run validate:plugin  # claude plugin validate
TYPESAFE_API_KEY="$(cat ~/.typesafe_key)" npm run demo
```

The unit tests use a fake Jev and never contact TypeSafe. The demo is the live
network check.

## Live demo (web)

`demo/JevDemo` is a local browser viewer for the real Codex hook trace. It
waits for `PreCompact`, shows rollout parsing and the TypeSafe request, renders
the returned Jev decisions for each tool call, and then shows the recovery note
being loaded at `SessionStart(source=compact)`. The viewer itself never sees
the API key and never makes the TypeSafe request; the Codex hook does that.

```sh
demo/JevDemo/build.sh             # starts the local server and opens the viewer
# Open http://127.0.0.1:4317 if the browser does not open automatically.
# Start a Codex session and trigger native manual or automatic compaction.
```

The browser viewer reads `~/.config/fast-jev-compaction/events.jsonl` through a
localhost-only Node server. Use the `Clear` button before a test to remove old
events. There is no scripted fallback: an empty event stream means that no real
Codex lifecycle event has arrived yet.
