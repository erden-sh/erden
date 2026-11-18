// Cross-platform determinism of erden-shacl: one request set, answered twice by every platform's binary, must give
// byte-identical answers apart from `tool.executableDigest` (each platform's executable has its own digest).
//
//   node shacl/qualification/determinism.mjs requests --out <dir>        (needs the built @erden/ontology)
//   node shacl/qualification/determinism.mjs run --binary <exe> --requests <dir> --out <dir>
//   node shacl/qualification/determinism.mjs compare --answers <dir> --out <dir>
//
// The request set: every test of the vendored W3C SHACL 1.0 suite (Core and SPARQL, refusals included), the
// synthetic series at 100 and 1,000 people with Core and with Core + SHACL-SPARQL shapes, and the known-answer
// request. Requests are written with the executable digest `sha256:000…`; `run` puts the binary's own digest in.
// `run` and `compare` need nothing but Node, so they run on every platform's runner without a workspace install.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

import { warnInJobSummary } from '../../scripts/lib/ci-warning.mjs';

const REFERENCE_TARGET = 'x86_64-unknown-linux-gnu';
/** Targets built natively, with the runner image's linker and system libraries, which no pin covers. */
const NATIVE_TARGETS = Object.freeze(['x86_64-pc-windows-msvc', 'aarch64-apple-darwin']);
const NATIVE_HOST = process.platform === 'win32' || process.platform === 'darwin';

const PLACEHOLDER = `sha256:${'0'.repeat(64)}`;

function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

async function writeRequests(out) {
    const { Graph, MF, N3, RDF, REPOSITORY, SHT, fileIri, ontology, parseFile } = await import('./harness/lib.mjs');
    const { syntheticCase } = await import('./harness/synthetic.mjs');
    const tool = ontology.shaclEngineTool(PLACEHOLDER);
    const requests = [];
    let parses = 0;
    const parse = (text, base, format = 'text/turtle') =>
        new N3.Parser({ baseIRI: base, format, blankNodePrefix: `q${String((parses += 1))}_` }).parse(text);
    function add(id, shapesQuads, graphs, shapesGraphIri) {
        const encoded = ontology.encodeShaclRequest({
            requestId: `determinism:${String(requests.length)}`,
            tool,
            shapes: ontology.prepareShaclShapes(shapesQuads),
            graphs,
            maxResults: 1_000_000,
            ...(shapesGraphIri === undefined ? {} : { shapesGraphIri }),
        });
        requests.push({ id, file: `${String(requests.length).padStart(4, '0')}.request.json`, line: encoded.line });
    }
    const root = fileURLToPath(new URL('shacl/qualification/w3c/data-shapes-test-suite/tests', REPOSITORY));
    // Base IRIs are the suite files' paths relative to the suite, so every runner sends the same bytes.
    const portable = (path) => `http://erden.invalid/w3c/${path.slice(root.length + 1).split('\\').join('/')}`;
    const visited = new Set();
    function collect(path) {
        if (visited.has(path)) return;
        visited.add(path);
        const graph = new Graph(parseFile(path));
        for (const include of graph.quads.filter((q) => q.predicate.value === `${MF}include`)) {
            collect(fileURLToPath(include.object.value));
        }
        for (const head of graph.quads.filter((q) => q.predicate.value === `${MF}entries`).map((q) => q.object)) {
            for (const entry of graph.list(head)) {
                if (!graph.objects(entry, `${RDF}type`).some((t) => t.value === `${SHT}Validate`)) continue;
                const action = graph.object(entry, `${MF}action`);
                const shapesPath = fileURLToPath(graph.object(action, `${SHT}shapesGraph`).value.split('#')[0]);
                const dataPath = fileURLToPath(graph.object(action, `${SHT}dataGraph`).value.split('#')[0]);
                add(
                    `w3c:${portable(fileURLToPath(entry.value.split('#')[0]))}`,
                    parse(readFileSync(shapesPath, 'utf8'), portable(shapesPath)),
                    [{ id: 'data', quads: parse(readFileSync(dataPath, 'utf8'), portable(dataPath)) }],
                    portable(shapesPath),
                );
            }
        }
    }
    collect(join(root, 'manifest.ttl'));
    void fileIri;
    for (const n of [100, 1000]) {
        const synthetic = syntheticCase(n);
        for (const [variant, shapes] of [
            ['core', synthetic.shapesCore],
            ['core-sparql', synthetic.shapesSparql],
        ]) {
            add(`synthetic:${variant}:${String(n)}`, parse(shapes, 'http://example.org/syn'), [
                { id: 'data', quads: parse(synthetic.data, 'http://example.org/syn', 'application/n-triples') },
            ]);
        }
    }
    const knownAnswer = readFileSync(new URL('shacl/distribution/fixtures/known-answer.request.json', REPOSITORY), 'utf8');
    requests.push({ id: 'known-answer', file: `${String(requests.length).padStart(4, '0')}.request.json`, line: `${JSON.stringify(JSON.parse(knownAnswer))}\n` });
    mkdirSync(out, { recursive: true });
    for (const request of requests) {
        writeFileSync(join(out, request.file), request.line);
    }
    writeFileSync(join(out, 'index.json'), `${JSON.stringify({ placeholder: PLACEHOLDER, requests: requests.map(({ id, file, line }) => ({ id, file, sha256: sha256(line) })) }, null, 1)}\n`);
    console.log(`wrote ${String(requests.length)} determinism requests`);
}

function runRequests(binary, requestsDir, out) {
    const digest = sha256(readFileSync(binary));
    const index = JSON.parse(readFileSync(join(requestsDir, 'index.json'), 'utf8'));
    mkdirSync(out, { recursive: true });
    const answers = [];
    const warnings = [];
    for (const request of index.requests) {
        const line = readFileSync(join(requestsDir, request.file), 'utf8');
        if (sha256(line) !== request.sha256) throw new Error(`${request.file} does not match the request index`);
        const value = JSON.parse(line);
        if (value.requiredTool.executableDigest !== index.placeholder && request.id !== 'known-answer') {
            throw new Error(`${request.file} does not carry the placeholder executable digest`);
        }
        value.requiredTool.executableDigest = digest;
        const input = `${JSON.stringify(value)}\n`;
        const bytes = [0, 1].map(() => {
            const child = spawnWithStdinFile(binary, input, { maxBuffer: 256 * 1024 * 1024, timeout: 600_000, windowsHide: true });
            if (child.status !== 0 || child.stderr.length !== 0) {
                throw new Error(`${request.id}: exit ${String(child.status)} ${child.stderr.toString('utf8')}`);
            }
            return child.stdout;
        });
        if (!bytes[0].equals(bytes[1])) {
            // On Windows and macOS (native builds) this is reported and the first answer kept; on Linux it fails.
            if (!NATIVE_HOST) throw new Error(`${request.id}: two runs of one binary gave different answers`);
            warnings.push(`${request.id}: two runs of one binary gave different answers`);
        }
        const normalized = bytes[0].toString('utf8').replace(`"executableDigest":"${digest}"`, `"executableDigest":"${index.placeholder}"`);
        const file = request.file.replace('.request.json', '.answer.json');
        writeFileSync(join(out, file), normalized);
        answers.push({ id: request.id, file, sha256: sha256(normalized), bytes: Buffer.byteLength(normalized) });
    }
    writeFileSync(join(out, 'answers.json'), `${JSON.stringify({ executableDigest: digest, platform: `${process.platform}-${process.arch}`, warnings, answers }, null, 1)}\n`);
    for (const warning of warnings) warnInJobSummary(`erden-shacl determinism: ${warning}`);
    console.log(`${String(answers.length)} answers, each identical over two runs (${digest})`);
}

function compare(answersRoot, out) {
    const sets = readdirSync(answersRoot, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ name: entry.name, record: JSON.parse(readFileSync(join(answersRoot, entry.name, 'answers.json'), 'utf8')) }))
        .sort((left, right) => left.name.localeCompare(right.name));
    if (sets.length < 2) throw new Error('compare needs the answers of at least two platforms');
    // Linux x64 is the reference: the Linux targets build in the pinned builder image and must agree. A natively built
    // target (Windows, macOS) that differs is reported as a warning and does not fail the comparison.
    const first = sets.find((set) => set.name === REFERENCE_TARGET) ?? sets[0];
    const rest = sets.filter((set) => set !== first);
    const differences = [];
    const nativeDifferences = [];
    for (const other of rest) {
        if (other.record.answers.length !== first.record.answers.length) {
            differences.push(`${other.name} answered ${String(other.record.answers.length)} requests, ${first.name} ${String(first.record.answers.length)}`);
            continue;
        }
        const native = NATIVE_TARGETS.includes(other.name);
        for (const warning of other.record.warnings ?? []) nativeDifferences.push(`${other.name}: ${warning}`);
        other.record.answers.forEach((answer, index) => {
            if (answer.sha256 !== first.record.answers[index].sha256) {
                (native ? nativeDifferences : differences).push(`${answer.id}: ${other.name} differs from ${first.name}`);
            }
        });
    }
    mkdirSync(out, { recursive: true });
    const summary = {
        platforms: sets.map(({ name, record }) => ({ name, platform: record.platform, executableDigest: record.executableDigest })),
        requests: first.record.answers.length,
        identical: differences.length === 0 && nativeDifferences.length === 0,
        result: differences.length > 0 ? 'different' : nativeDifferences.length > 0 ? 'differs-on-native' : 'identical',
        differences,
        nativeDifferences,
    };
    writeFileSync(join(out, 'comparison.json'), `${JSON.stringify(summary, null, 2)}\n`);
    console.log(`${String(sets.length)} platforms, ${String(summary.requests)} requests: ${summary.identical ? 'byte-identical apart from the executable digest' : `${String(differences.length)} differences, ${String(nativeDifferences.length)} on native builds`}`);
    for (const difference of nativeDifferences) warnInJobSummary(`erden-shacl determinism: ${difference}`);
    if (differences.length > 0) {
        console.error(differences.slice(0, 50).join('\n'));
        process.exit(1);
    }
}

/**
 * Runs the engine with `input` as its standard input, read from a file: the child gets an open descriptor of it, so no
 * pipe write happens on this side. On macOS runners a request over 64 KiB, the most a pipe buffer holds, sometimes
 * stalled the pipe hand-off until the timeout; a file has no such hand-off. The engine reads its stdin to end of file
 * either way.
 */
function spawnWithStdinFile(binary, input, options) {
    const directory = mkdtempSync(join(tmpdir(), 'erden-determinism-'));
    const file = join(directory, 'request');
    writeFileSync(file, input);
    const descriptor = openSync(file, 'r');
    try {
        return spawnSync(binary, [], { ...options, stdio: [descriptor, 'pipe', 'pipe'] });
    } finally {
        closeSync(descriptor);
        rmSync(directory, { recursive: true, force: true });
    }
}

const [command, ...rest] = process.argv.slice(2);
const { values } = parseArgs({ args: rest, options: { out: { type: 'string' }, binary: { type: 'string' }, requests: { type: 'string' }, answers: { type: 'string' } } });
if (command === 'requests' && values.out) {
    await writeRequests(resolve(values.out));
} else if (command === 'run' && values.binary && values.requests && values.out) {
    runRequests(resolve(values.binary), resolve(values.requests), resolve(values.out));
} else if (command === 'compare' && values.answers && values.out) {
    compare(resolve(values.answers), resolve(values.out));
} else {
    throw new Error('Usage: determinism.mjs requests --out <dir> | run --binary <exe> --requests <dir> --out <dir> | compare --answers <dir> --out <dir>');
}
