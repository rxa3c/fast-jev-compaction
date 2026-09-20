import { compact } from './compact.js';
/** Runs the shared Jev policy through one host adapter. */
export async function compactWithAdapter(adapter, input, asker, options = {}) {
    const projection = adapter.project(input);
    const result = await compact(projection.messages, asker, options);
    return {
        result,
        output: adapter.apply(input, projection, result),
    };
}
//# sourceMappingURL=adapters.js.map