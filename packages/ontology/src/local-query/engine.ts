import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';

import { verifyReleaseQueryEngineDirectory } from '../release-query/engine.js';

import { localQueryWorker } from './worker.js';

/** The result serializations a local query asks Oxigraph for: W3C SPARQL 1.1 results, or N-Triples for graphs. */
export type LocalQueryEngineFormat = 'json' | 'csv' | 'tsv' | 'ntriples';

export interface LocalQueryEngineInput {
    /**
     * One N-Quads document holding every graph. It is loaded in one piece, so a blank-node label names the same node
     * in every graph it appears in.
     */
    readonly nquads: string;
    /** The graphs whose union is the query's default graph (`FROM` clauses in the query take precedence). */
    readonly defaultGraph: ReadonlyArray<string>;
    /** The graphs `GRAPH` patterns may name (`FROM NAMED` clauses in the query take precedence). */
    readonly namedGraphs: ReadonlyArray<string>;
    readonly query: string;
    readonly format: LocalQueryEngineFormat;
    /** The wall-time budget for loading and evaluation together. */
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

/**
 * Runs one SPARQL query over one dataset in a fresh worker thread with the pinned Oxigraph, and terminates the worker
 * when the budget runs out. Evaluation is synchronous WebAssembly, so a thread is the only way to stop it.
 */
export async function runLocalQuery(
    input: LocalQueryEngineInput,
    signal?: AbortSignal,
): Promise<LocalQueryEngineResult> {
    const directory = verifyReleaseQueryEngineDirectory();
    if (directory === null) {
        return Object.freeze({ outcome: 'unavailable', message: 'the pinned Oxigraph engine is missing or altered' });
    }
    if (signal?.aborted === true) {
        return Object.freeze({ outcome: 'time-limit' });
    }
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
                // Deterministic engine entropy: blank-node identifiers depend only on the dataset and the query.
                seed: createHash('sha256').update(input.nquads).update('\u0000').update(input.query).digest('hex'),
                nquads: input.nquads,
                defaultGraph: [...input.defaultGraph],
                namedGraphs: [...input.namedGraphs],
                query: input.query,
                format: input.format,
            },
        });
    } catch (cause) {
        return Object.freeze({
            outcome: 'unavailable',
            message: cause instanceof Error ? cause.message : String(cause),
        });
    }
    return await new Promise<LocalQueryEngineResult>((resolve) => {
        let settled = false;
        function finish(result: LocalQueryEngineResult): void {
            if (settled) {
                return;
            }
            settled = true;
            clearTimeout(timer);
            signal?.removeEventListener('abort', abort);
            void worker.terminate().finally(() => {
                resolve(result);
            });
        }
        function abort(): void {
            finish(Object.freeze({ outcome: 'time-limit' }));
        }
        const timer = setTimeout(abort, Math.max(1, input.milliseconds));
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
            finish(Object.freeze({ outcome: 'unavailable', message: 'the query engine stopped without an answer' }));
        });
        worker.once('message', (message: unknown) => {
            finish(decodeWorkerMessage(message));
        });
    });
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
