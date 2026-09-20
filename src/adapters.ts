import { compact } from './compact.js';
import type { CompactOptions, CompactResult, JevAsker, Message } from './types.js';

/** The host-neutral transcript projection consumed by the Jev compaction core. */
export interface HostProjection<TReferences = undefined> {
  messages: readonly Message[];
  /** Host-specific handles used when materialising the result. */
  references?: TReferences;
}

export type HostMaterializationMode = 'replace' | 'augment';

/**
 * Boundary between a host transcript and the host-neutral Jev pipeline.
 * Adapters own parsing, source references, and result materialisation; the
 * compaction policy stays shared across hosts.
 */
export interface HostCompactionAdapter<TInput, TOutput, TReferences = undefined> {
  readonly name: string;
  /** Whether the host replaces its context or adds a recovery artifact. */
  readonly materialization: HostMaterializationMode;
  project(input: TInput): HostProjection<TReferences>;
  apply(
    input: TInput,
    projection: HostProjection<TReferences>,
    result: CompactResult,
  ): TOutput;
}

export interface HostCompaction<TOutput> {
  result: CompactResult;
  output: TOutput;
}

/** Runs the shared Jev policy through one host adapter. */
export async function compactWithAdapter<TInput, TOutput, TReferences>(
  adapter: HostCompactionAdapter<TInput, TOutput, TReferences>,
  input: TInput,
  asker: JevAsker,
  options: CompactOptions = {},
): Promise<HostCompaction<TOutput>> {
  const projection = adapter.project(input);
  const result = await compact(projection.messages, asker, options);
  return {
    result,
    output: adapter.apply(input, projection, result),
  };
}
