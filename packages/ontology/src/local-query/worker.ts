interface WorkerInput {
    readonly directory: string;
    readonly seed: string;
    readonly nquads: string;
    readonly defaultGraph: ReadonlyArray<string>;
    readonly namedGraphs: ReadonlyArray<string>;
    readonly query: string;
    readonly format: 'json' | 'csv' | 'tsv' | 'ntriples';
}

/**
 * The local query worker. Self-contained: it is serialized with `toString()` and evaluated in a worker thread, with
 * native `import` supplied, so it may use nothing from its module.
 */
export async function localQueryWorker(load: (specifier: string) => Promise<unknown>): Promise<void> {
    const { parentPort, workerData } = (await load('node:worker_threads')) as {
        readonly parentPort: import('node:worker_threads').MessagePort | null;
        readonly workerData: unknown;
    };
    const { createRequire } = (await load('node:module')) as typeof import('node:module');
    const data = workerData as WorkerInput;
    function post(message: Readonly<Record<string, unknown>>): void {
        parentPort?.postMessage(message);
    }

    // Deterministic engine entropy, as the registry's release query worker has: Oxigraph draws blank-node identifiers
    // from crypto.getRandomValues, so a fixed seed gives the same labels for the same dataset and query.
    const state = new Uint32Array(4);
    for (let index = 0; index < 4; index += 1) {
        state[index] = Number.parseInt(data.seed.slice(index * 8, index * 8 + 8), 16) >>> 0 || 0x9e3779b9;
    }
    function nextRandom(): number {
        let t = state[3] ?? 0;
        const s = state[0] ?? 0;
        state[3] = state[2] ?? 0;
        state[2] = state[1] ?? 0;
        state[1] = s;
        t ^= t << 11;
        t ^= t >>> 8;
        state[0] = (t ^ s ^ (s >>> 19)) >>> 0;
        return state[0];
    }
    Object.defineProperty(globalThis, 'crypto', {
        configurable: false,
        value: Object.freeze({
            getRandomValues(array: Uint8Array): Uint8Array {
                for (let index = 0; index < array.length; index += 1) {
                    array[index] = nextRandom() & 0xff;
                }
                return array;
            },
        }),
    });

    interface Store {
        readonly load: (input: string, options: Readonly<Record<string, unknown>>) => void;
        readonly query: (query: string, options: Readonly<Record<string, unknown>>) => unknown;
    }
    interface Oxigraph {
        readonly Store: new () => Store;
        readonly namedNode: (value: string) => unknown;
    }
    let oxigraph: Oxigraph;
    let store: Store;
    const loadStarted = performance.now();
    try {
        oxigraph = createRequire(`${data.directory}/node.js`)(`${data.directory}/node.js`) as Oxigraph;
        store = new oxigraph.Store();
        store.load(data.nquads, { format: 'application/n-quads', no_transaction: true });
    } catch (cause) {
        post({ outcome: 'unavailable', message: cause instanceof Error ? cause.message : String(cause) });
        return;
    }
    const loadMilliseconds = performance.now() - loadStarted;
    const format =
        data.format === 'json'
            ? 'application/sparql-results+json'
            : data.format === 'csv'
              ? 'text/csv'
              : data.format === 'tsv'
                ? 'text/tab-separated-values'
                : 'application/n-triples';
    const queryStarted = performance.now();
    let text: unknown;
    try {
        text = store.query(data.query, {
            results_format: format,
            default_graph: data.defaultGraph.map((name) => oxigraph.namedNode(name)),
            named_graphs: data.namedGraphs.map((name) => oxigraph.namedNode(name)),
        });
    } catch (cause) {
        if (cause instanceof WebAssembly.RuntimeError) {
            post({ outcome: 'unavailable', message: cause.message });
            return;
        }
        post({ outcome: 'query-error', message: cause instanceof Error ? cause.message : String(cause) });
        return;
    }
    if (typeof text !== 'string') {
        post({ outcome: 'unavailable', message: 'the query engine returned no serialized result' });
        return;
    }
    post({ outcome: 'complete', text, loadMilliseconds, queryMilliseconds: performance.now() - queryStarted });
}
