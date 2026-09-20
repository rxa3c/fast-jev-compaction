import { appendFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
let sequence = 0;
function expandPath(path, environment) {
    if (path === '~' || path.startsWith('~/')) {
        return join(environment.HOME || homedir(), path.slice(2));
    }
    return isAbsolute(path) ? path : resolve(path);
}
/** Stable local event stream consumed by the optional live macOS viewer. */
export function codexTracePath(environment = process.env) {
    const configured = environment.FAST_JEV_TRACE_FILE?.trim();
    if (configured)
        return expandPath(configured, environment);
    return join(environment.HOME || homedir(), '.config', 'fast-jev-compaction', 'events.jsonl');
}
function eventId() {
    sequence += 1;
    return `${Date.now().toString(36)}-${process.pid}-${sequence.toString(36)}`;
}
/**
 * Writes one bounded JSONL event. Trace failures are intentionally handled by
 * the caller so observability can never change native Codex fallback behavior.
 */
export async function appendCodexTrace(event, environment = process.env) {
    const path = codexTracePath(environment);
    await mkdir(dirname(path), { recursive: true });
    const record = {
        schemaVersion: 1,
        id: eventId(),
        ...event,
    };
    await appendFile(path, `${JSON.stringify(record)}\n`, 'utf8');
}
//# sourceMappingURL=codex-trace.js.map