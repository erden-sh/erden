import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { verifyReleaseQueryEngineDirectory } from '../release-query/engine.js';

import { localQueryWorker } from './worker.js';

/** The result serializations a local query asks Oxigraph for: W3C SPARQL 1.1 results, or N-Triples for graphs. */
export type LocalQueryEngineFormat = 'json' | 'csv' | 'tsv' | 'ntriples';

/** One query of a batch: its text, the graphs it sees, and the serialization of its answer. */
export interface LocalQueryEngineQuery {
    readonly query: string;
    /** The graphs whose union is the query's default graph (`FROM` clauses in the query take precedence). */
    readonly defaultGraph: ReadonlyArray<string>;
    /** The graphs `GRAPH` patterns may name (`FROM NAMED` clauses in the query take precedence). */
    readonly namedGraphs: ReadonlyArray<string>;
    readonly format: LocalQueryEngineFormat;
}

export interface LocalQueryEngineInput extends LocalQueryEngineQuery {
    /**
     * One N-Quads document holding every graph. It is loaded in one piece, so a blank-node label names the same node
     * in every graph it appears in.
     */
    readonly nquads: string;
    /** The wall-time budget for loading and evaluation together. */
    readonly milliseconds: number;
}

export interface LocalQueryEngineBatch {
    readonly nquads: string;
    readonly queries: ReadonlyArray<LocalQueryEngineQuery>;
    /** The wall-time budget of each query, loading included for the first. */
    readonly milliseconds: number;
}

export type LocalQueryEngineResult =
    | Readonly<{ outcome: 'complete'; text: string; loadMilliseconds: number; queryMilliseconds: number }>
    /** Oxigraph refused the query: a syntax error, or an evaluation error such as an unsupported feature. */
    | Readonly<{ outcome: 'query-error'; message: string }>
    | Readonly<{ outcome: 'time-limit' }>
    /** The pinned engine is missing, altered, or failed (a WebAssembly trap or a failed load of the dataset). */
    | Readonly<{ outcome: 'unavailable'; message: string }>;

const WORKER_SOURCE = `(${localQueryWorker.toString()})(specifier => import(specifier)).catch(() => process.exit(1));`;

/** Runs one SPARQL query over one dataset; see `runLocalQueries`. */
export async function runLocalQuery(
    input: LocalQueryEngineInput,
    signal?: AbortSignal,
): Promise<LocalQueryEngineResult> {
    const [result] = await runLocalQueries(
        {
            nquads: input.nquads,
            queries: [
                {
                    query: input.query,
                    defaultGraph: input.defaultGraph,
                    namedGraphs: input.namedGraphs,
                    format: input.format,
                },
            ],
            milliseconds: input.milliseconds,
        },
        signal,
    );
    return result ?? Object.freeze({ outcome: 'unavailable', message: 'the query engine gave no answer' });
}

/**
 * Runs SPARQL queries in order over one dataset, loaded once, in a worker thread with the pinned Oxigraph. A query
 * that runs past its budget is stopped by terminating the worker; the rest run in a fresh one. Evaluation is
 * synchronous WebAssembly, so a thread is the only way to stop it.
 */
export async function runLocalQueries(
    batch: LocalQueryEngineBatch,
    signal?: AbortSignal,
): Promise<ReadonlyArray<LocalQueryEngineResult>> {
    const directory = verifyReleaseQueryEngineDirectory();
    if (directory === null) {
        return batch.queries.map(() =>
            Object.freeze({
                outcome: 'unavailable' as const,
                message: 'the pinned Oxigraph engine is missing or altered',
            }),
        );
    }
    // Deterministic engine entropy: blank-node identifiers depend only on the dataset.
    const seed = createHash('sha256').update(batch.nquads).digest('hex');
    const results: LocalQueryEngineResult[] = [];
    while (results.length < batch.queries.length) {
        if (signal?.aborted === true) {
            results.push(Object.freeze({ outcome: 'time-limit' }));
            continue;
        }
        const remaining = batch.queries.slice(results.length);
        const answered = await runWorker(directory, seed, batch.nquads, remaining, batch.milliseconds, signal);
        results.push(...answered);
    }
    return Object.freeze(results);
}

/** One worker over `queries`: the answers it gave, then, if it stopped early, one result for the query it stopped on. */
async function runWorker(
    directory: string,
    seed: string,
    nquads: string,
    queries: ReadonlyArray<LocalQueryEngineQuery>,
    milliseconds: number,
    signal: AbortSignal | undefined,
): Promise<ReadonlyArray<LocalQueryEngineResult>> {
    let worker: Worker;
    try {
        worker = new Worker(WORKER_SOURCE, {
            eval: true,
            execArgv: [],
            env: {},
            stdout: true,
            stderr: true,
            workerData: {
                directory,
                seed,
                nquads,
                queries: queries.map((query) => ({
                    query: query.query,
                    defaultGraph: [...query.defaultGraph],
                    namedGraphs: [...query.namedGraphs],
                    format: query.format,
                })),
            },
        });
    } catch (cause) {
        return [
            Object.freeze({ outcome: 'unavailable', message: cause instanceof Error ? cause.message : String(cause) }),
        ];
    }
    const answers: LocalQueryEngineResult[] = [];
    return await new Promise<ReadonlyArray<LocalQueryEngineResult>>((resolve) => {
        let settled = false;
        let timer = setTimeout(abort, Math.max(1, milliseconds));
        function finish(last: LocalQueryEngineResult | null): void {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            if (last !== null) {
                answers.push(last);
            }
            void worker.terminate().finally(() => {
                resolve(answers);
            });
        }
        function abort(): void {
            finish(Object.freeze({ outcome: 'time-limit' }));
        }
        signal?.addEventListener('abort', abort, { once: true });
        worker.stdout.resume();
        worker.stderr.resume();
        worker.once('error', (cause: unknown) => {
            finish(
                Object.freeze({
                    outcome: 'unavailable',
                    message: cause instanceof Error ? cause.message : String(cause),
                }),
            );
        });
        worker.once('exit', () => {
            finish(
                answers.length < queries.length
                    ? Object.freeze({ outcome: 'unavailable', message: 'the query engine stopped without an answer' })
                    : null,
            );
        });
        worker.on('message', (message: unknown) => {
            if (settled) {
                return;
            }
            const result = decodeWorkerMessage(message);
            if (result.outcome === 'unavailable' && answers.length === 0 && isLoadFailure(message)) {
                // The dataset did not load: no query of this batch can run.
                settled = true;
                clearTimeout(timer);
                signal?.removeEventListener('abort', abort);
                void worker.terminate().finally(() => {
                    resolve(queries.map(() => result));
                });
                return;
            }
            answers.push(result);
            if (answers.length === queries.length) {
                finish(null);
                return;
            }
            clearTimeout(timer);
            timer = setTimeout(abort, Math.max(1, milliseconds));
        });
    });
}

function isLoadFailure(message: unknown): boolean {
    return (message as Readonly<Record<string, unknown>> | null)?.stage === 'load';
}

function decodeWorkerMessage(message: unknown): LocalQueryEngineResult {
    const value = message as Readonly<Record<string, unknown>> | null;
    if (value !== null && typeof value === 'object') {
        if (
            value.outcome === 'complete' &&
            typeof value.text === 'string' &&
            typeof value.loadMilliseconds === 'number' &&
            typeof value.queryMilliseconds === 'number'
        ) {
            return Object.freeze({
                outcome: 'complete',
                text: value.text,
                loadMilliseconds: value.loadMilliseconds,
                queryMilliseconds: value.queryMilliseconds,
            });
        }
        if ((value.outcome === 'query-error' || value.outcome === 'unavailable') && typeof value.message === 'string') {
            return Object.freeze({ outcome: value.outcome, message: value.message });
        }
    }
    return Object.freeze({ outcome: 'unavailable', message: 'the query engine answered in an unknown form' });
}
