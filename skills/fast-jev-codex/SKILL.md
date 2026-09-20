---
name: fast-jev-codex
description: Review high-value Codex tool history with Jev and recover it through Codex native context rollover and notes.
---

# Fast Jev for Codex

The normal path is automatic. The plugin lifecycle hook runs `PreCompact`,
reviews the active Codex window with Jev, and stores a bounded recovery note.
After native compaction, `SessionStart(source=compact)` injects that note into
the next context window. Use this skill for explicit review, diagnosis, or
when lifecycle hooks are unavailable.

## Boundary

Codex owns the active context window, compaction records, history, and notes.
Jev is a decision aid: it selects candidate calls and results, but it does not
replace Codex's native context manager. Never edit or delete a Codex rollout
JSONL file to apply a Jev plan.

The automatic hook reads the latest active window only: the latest
`compacted.replacement_history` checkpoint plus the response-item tail after
it. If there is no checkpoint, it uses the current rollout items. Tool output
is replaced by a short note before it is sent to Jev; opaque reasoning,
encrypted compaction state, images, and audio are not Jev deletion candidates.

## Automatic setup

Build the plugin and configure the TypeSafe key in the generated `.env` file,
in `~/.config/fast-jev-compaction/.env` for an installed plugin, or in the hook
process environment. Do not put the key in a skill, note, rollout, or source
file:

```sh
npm install
npm run build
# .env has been generated; if it is missing, run: cp .env.example .env
# Edit .env and set TYPESAFE_API_KEY=<your key>
# Installed plugin alternative: edit ~/.config/fast-jev-compaction/.env
```

Install or reload the plugin, then review and trust its hooks from `/hooks`.
Start a new Codex task after a plugin update so the new hook bundle is loaded.
The native Codex compaction always continues even when Jev fails, the key is
missing, or the reduction is below `FAST_JEV_MIN_REDUCTION_RATIO`.

## Manual review

1. Build once with `npm run build` if `dist/codex-cli.js` is unavailable.
2. Identify the current rollout JSONL path from the Codex session metadata; do
   not guess a different session or read the entire lifetime when a newer
   native compaction checkpoint exists.
3. Run:

   `TYPESAFE_API_KEY=... node dist/codex-cli.js plan --rollout <rollout.jsonl> --output /tmp/fast-jev-plan.json --note /tmp/fast-jev-note.md`

4. Read the plan and use Codex `history.read_item` for any selected call or
   result whose exact content matters. A Jev probability is not proof that a
   result is safe to discard.
5. Save the final recovery note with native `notes.write_file`, using a path
   such as `fast-jev/window-<number>.md`. Include the task goal, selected file
   paths and commands, exact error snippets that matter, source references,
   and the next unresolved step.
6. Use the native `new_context` tool. In the next window, call
   `notes.read_file` and use `history.search_contents` or `history.read_item`
   to recover exact details on demand.

## Configuration

The hook reads these environment variables:

- `TYPESAFE_API_KEY`: required when Jev has unpinned tool calls to score.
- `FAST_JEV_MODEL`: Jev model, default `jev-latest`.
- `FAST_JEV_GOAL`: optional task goal; otherwise the core infers recent user prompts.
- `FAST_JEV_MIN_REDUCTION_RATIO`: minimum accepted reduction, default `0.25`.
- `FAST_JEV_NOTE_RESULT_CHARS`: exact result characters in a note, default `800`.
- `FAST_JEV_KEEP_THRESHOLD`: keep probability threshold, default `0.5`.
- `FAST_JEV_PRESERVE_RECENT_MESSAGES`: pinned recent messages, default `6`.
- `FAST_JEV_MAX_STATE_TOKENS`: fitted Jev state ceiling, default `25000`.
- `FAST_JEV_MAX_REQUEST_TOKENS`: fitted request ceiling, default `30000`.
- `FAST_JEV_TRUNCATE_HEAD_CHARS`: result head retained for dropped results, default `300`.
- `FAST_JEV_CONFIG`: optional path to another env-style config file.
- `PLUGIN_DATA`: optional directory for per-session pending recovery notes.

The note is intentionally bounded and tells the next window to use native
history tools for exact details. The rollout remains untouched.
