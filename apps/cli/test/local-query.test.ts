import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import { CheckProjectOperationalError } from '@erden/contracts';
import {
    parseCompetencyQuestionMetadata,
    type LoadedCompetencyQuestion,
    type PreparedProjectQuery,
    type QueryProjectOptions,
    type QueryProjectServiceShape,
} from '@erden/project';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { CLI_EXIT, runCli, type CliRuntime, type CliServices } from '../src/main.js';
import { telemetryOutcome } from '../src/telemetry.js';

const DECLARED = 'urn:erden:release-query:v1:graph:declared';
const INFERRED = 'urn:erden:release-query:v1:graph:inferred';
const roots: string[] = [];

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

function prepared(overrides: Partial<PreparedProjectQuery> = {}): PreparedProjectQuery {
    const lines = [
        `<https://example.test/root#rex> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://example.test/root#Dog> <${DECLARED}> .`,
        `<https://example.test/root#rex> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://example.test/root#Animal> <${INFERRED}> .`,
    ];
    return {
        projectRoot: '/project',
        canonicalIri: 'https://example.test/root',
        manifestFile: 'erden.config.json',
        regime: 'entailed',
        entailment: {
            reasoner: { name: 'erden-reasoner', version: '0.3.0', calculusDigest: `sha256:${'a'.repeat(64)}` },
            profile: { id: 'erden-required-constructs-v2', digest: `sha256:${'b'.repeat(64)}` },
            inputDigest: `sha256:${'c'.repeat(64)}`,
            certificateDigest: `sha256:${'d'.repeat(64)}`,
            cached: true,
        },
        entailedUnavailable: false,
        reasons: [],
        questions: [],
        unknownQuestions: [],
        dataset: {
            nquads: `${lines.join('\n')}\n`,
            defaultGraph: [DECLARED, INFERRED],
            namedGraphs: [DECLARED, INFERRED],
            quadCounts: { declared: 1, inferred: 1 },
            sourceGraphs: [],
        },
        ...overrides,
    };
}

const PARTIAL: Partial<PreparedProjectQuery> = {
    regime: 'asserted',
    entailment: null,
    reasons: [
        {
            code: 'sources-unparsed',
            sources: [{ file: 'broken.ttl', line: 3, column: 7, code: 'TURTLE_SOURCE_PARSE_ERROR', message: 'oops' }],
        },
        { code: 'entailment-unavailable', cause: 'CHECK_REQUEST_TOO_LARGE' },
    ],
    dataset: {
        nquads: `<https://example.test/root#rex> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://example.test/root#Dog> <${DECLARED}> .\n`,
        defaultGraph: [DECLARED],
        namedGraphs: [DECLARED],
        quadCounts: { declared: 1, inferred: 0 },
        sourceGraphs: [],
    },
};

function harness(
    query: string,
    answer: PreparedProjectQuery | CheckProjectOperationalError = prepared(),
): Readonly<{
    runtime: CliRuntime;
    stdout: string[];
    stderr: string[];
    requests: QueryProjectOptions[];
}> {
    const root = makeTestTempRoot('erden-cli-local-query-');
    roots.push(root);
    writeFileSync(join(root, 'q.rq'), query);
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: QueryProjectOptions[] = [];
    const localQuery: QueryProjectServiceShape = {
        prepare: (options = {}) => {
            requests.push(options);
            return answer instanceof CheckProjectOperationalError ? Effect.fail(answer) : Effect.succeed(answer);
        },
    };
    return {
        stdout,
        stderr,
        requests,
        runtime: {
            cwd: () => root,
            stdout: { write: (text) => stdout.push(text) },
            stderr: { write: (text) => stderr.push(text) },
            services: new Proxy({}, { get: () => () => undefined }) as unknown as CliServices,
            localQuery,
            environment: () => ({}),
        },
    };
}

const ANIMALS = 'SELECT ?x WHERE { ?x a <https://example.test/root#Animal> }';

describe('erden query [project-dir]', () => {
    it('prints a table and its regime label, and exits 0 when the answer is complete', async () => {
        const run = harness(ANIMALS);
        expect(await runCli(['query', '--file', 'q.rq'], run.runtime)).toBe(CLI_EXIT.success);
        const out = run.stdout.join('');
        expect(out).toContain('<https://example.test/root#rex>');
        expect(out).toContain('1 row');
        expect(out).toContain('Regime: entailed (OWL 2 Direct Semantics, profile erden-required-constructs-v2');
        expect(out).toContain('Complete');
        expect(run.requests).toEqual([expect.objectContaining({ from: run.runtime.cwd() })]);
        expect(run.stderr).toEqual([]);
    });

    it('labels a partial answer and exits 4, or 0 with --allow-incomplete', async () => {
        const run = harness(ANIMALS, prepared(PARTIAL));
        expect(await runCli(['query', '--file', 'q.rq'], run.runtime)).toBe(CLI_EXIT.partial);
        const out = run.stdout.join('');
        expect(out).toContain('0 rows');
        expect(out).toContain('Regime: asserted (simple entailment');
        expect(out).toContain('broken.ttl:3:7 [TURTLE_SOURCE_PARSE_ERROR] oops');
        expect(out).toContain('entailment-unavailable: asserted answers only [CHECK_REQUEST_TOO_LARGE]');
        const allowed = harness(ANIMALS, prepared(PARTIAL));
        expect(await runCli(['query', '--file', 'q.rq', '--allow-incomplete'], allowed.runtime)).toBe(0);
        expect(telemetryOutcome(CLI_EXIT.partial)).toBe('success');
    });

    it('passes the project, the manifest, the regime and the reasoner limits to the project', async () => {
        const run = harness(ANIMALS);
        const runtime = { ...run.runtime, environment: () => ({ ERDEN_REASONER_MAX_INPUT_AXIOMS: '5' }) };
        expect(await runCli(['query', 'sub', '--file', 'q.rq', '--regime', 'asserted'], runtime)).toBe(0);
        expect(run.requests[0]).toMatchObject({
            from: join(run.runtime.cwd(), 'sub'),
            regime: 'asserted',
            reasonerLimits: { maxInputAxioms: 5 },
        });
        const config = harness(ANIMALS);
        expect(await runCli(['query', '--config', 'erden.config.json', '--file', 'q.rq'], config.runtime)).toBe(0);
        expect(config.requests[0]).toMatchObject({ manifestPath: join(config.runtime.cwd(), 'erden.config.json') });
    });

    it('keeps standard output a W3C document for --csv, --tsv and --sparql-json, with labels on standard error', async () => {
        for (const [flag, first] of [
            ['--csv', 'x\r\n'],
            ['--tsv', '?x\n'],
            ['--sparql-json', '{"head":{"vars":["x"]}'],
        ] as const) {
            const run = harness(ANIMALS);
            expect(await runCli(['query', '--file', 'q.rq', flag], run.runtime)).toBe(0);
            expect(run.stdout.join('').startsWith(first)).toBe(true);
            expect(run.stdout.join('')).not.toContain('Regime');
            expect(run.stderr.join('')).toContain('Regime: entailed');
        }
    });

    it('prints the Erden envelope with the W3C regime and completeness labels', async () => {
        const run = harness(ANIMALS, prepared(PARTIAL));
        expect(await runCli(['query', '--file', 'q.rq', '--json'], run.runtime)).toBe(CLI_EXIT.partial);
        const envelope = JSON.parse(run.stdout.join('')) as Record<string, unknown>;
        expect(envelope).toMatchObject({
            schema: 'erden.local-query-result/v1',
            project: { canonicalIri: 'https://example.test/root', manifest: 'erden.config.json' },
            query: { form: 'select' },
            regime: { entailmentRegime: 'http://www.w3.org/ns/entailment/Simple' },
            completeness: { complete: false, reasons: PARTIAL.reasons },
            result: { head: { vars: ['x'] }, results: { bindings: [] } },
        });
        const entailed = harness(ANIMALS);
        await runCli(['query', '--file', 'q.rq', '--json'], entailed.runtime);
        expect(JSON.parse(entailed.stdout.join(''))).toMatchObject({
            regime: {
                entailmentRegime: 'http://www.w3.org/ns/entailment/OWL-Direct',
                supportedEntailmentProfile: 'https://erden.sh/ns/profile/erden-required-constructs-v2',
                method: 'materialized',
            },
            completeness: { complete: true, reasons: [] },
        });
    });

    it('prints CONSTRUCT answers as N-Triples and refuses them in a results format', async () => {
        const construct = 'CONSTRUCT { ?x <urn:is> <urn:animal> } WHERE { ?x a <https://example.test/root#Animal> }';
        const run = harness(construct);
        expect(await runCli(['query', '--file', 'q.rq'], run.runtime)).toBe(0);
        expect(run.stdout.join('')).toBe('<https://example.test/root#rex> <urn:is> <urn:animal> .\n');
        const csv = harness(construct);
        expect(await runCli(['query', '--file', 'q.rq', '--csv'], csv.runtime)).toBe(CLI_EXIT.semanticFailure);
        expect(csv.stderr.join('')).toContain('LOCAL_QUERY_FORMAT_UNSUITED');
    });

    it.each([
        ['SERVICE', 'SELECT * { SERVICE <https://example.test/sparql> { ?s ?p ?o } }', 'LOCAL_QUERY_SERVICE_FORBIDDEN'],
        ['an update', 'INSERT DATA { <urn:a> <urn:b> <urn:c> }', 'LOCAL_QUERY_UPDATE_FORBIDDEN'],
        ['a syntax error', 'SELECT * WHERE { ?s ?p }', 'LOCAL_QUERY_INVALID'],
    ])('refuses %s with exit 1', async (_name, query, code) => {
        const run = harness(query);
        expect(await runCli(['query', '--file', 'q.rq'], run.runtime)).toBe(CLI_EXIT.semanticFailure);
        expect(run.stderr.join('')).toContain(code);
        expect(run.stdout).toEqual([]);
    });

    it('warns when the registry would refuse the query, and refuses it with --registry-compatible', async () => {
        const regex = 'SELECT ?x WHERE { ?x ?p ?label FILTER REGEX(STR(?x), ?label) }';
        const run = harness(regex);
        expect(await runCli(['query', '--file', 'q.rq'], run.runtime)).toBe(0);
        expect(run.stderr.join('')).toContain("Warning: the registry's query language refuses this query (regex-");
        const strict = harness(regex);
        expect(await runCli(['query', '--file', 'q.rq', '--registry-compatible'], strict.runtime)).toBe(
            CLI_EXIT.semanticFailure,
        );
        expect(strict.stderr.join('')).toContain('RELEASE_QUERY_REJECTED: regex-');
        expect(strict.requests).toEqual([]);
        const fine = harness(ANIMALS);
        expect(await runCli(['query', '--file', 'q.rq', '--registry-compatible'], fine.runtime)).toBe(0);
        expect(fine.stderr).toEqual([]);
    });

    it('exits 4 without an answer when the entailed regime was asked for and cannot be had', async () => {
        const run = harness(
            ANIMALS,
            prepared({ ...PARTIAL, entailedUnavailable: true, reasons: [PARTIAL.reasons?.[1] as never] }),
        );
        expect(await runCli(['query', '--file', 'q.rq', '--regime', 'entailed'], run.runtime)).toBe(CLI_EXIT.partial);
        expect(run.stdout).toEqual([]);
        expect(run.stderr.join('')).toContain('no entailed answer');
    });

    it('stops a query past --timeout and exits 3', async () => {
        const many = Array.from(
            { length: 300 },
            (_, index) => `<urn:s${String(index)}> <urn:p> "${String(index)}" <${DECLARED}> .`,
        ).join('\n');
        const run = harness(
            'SELECT (COUNT(*) AS ?n) WHERE { ?a ?p ?b . ?c ?q ?d . ?e ?r ?f . ?g ?t ?h . ?i ?j ?k }',
            prepared({ dataset: { ...prepared().dataset, nquads: `${many}\n` } }),
        );
        expect(await runCli(['query', '--file', 'q.rq', '--timeout', '1'], run.runtime)).toBe(CLI_EXIT.operational);
        expect(run.stderr.join('')).toContain('CLI_QUERY_TIMEOUT');
    });

    it('reports a project that cannot be read as operational, exit 3', async () => {
        const run = harness(
            ANIMALS,
            new CheckProjectOperationalError('CHECK_MANIFEST_NOT_FOUND', 'manifest', 'No project manifest was found'),
        );
        expect(await runCli(['query', '--file', 'q.rq'], run.runtime)).toBe(CLI_EXIT.operational);
        expect(run.stderr.join('')).toContain('Erden query could not complete [manifest/CHECK_MANIFEST_NOT_FOUND]');
    });

    it.each([
        ['--registry', ['query', '--file', 'q.rq', '--registry', 'https://registry.example']],
        ['an unknown regime', ['query', '--file', 'q.rq', '--regime', 'rdfs']],
        ['a zero timeout', ['query', '--file', 'q.rq', '--timeout', '0']],
        ['two outputs', ['query', '--file', 'q.rq', '--csv', '--json']],
        ['two projects', ['query', 'a', 'b', '--file', 'q.rq']],
        ['a project and --config', ['query', 'a', '--config', 'erden.config.json', '--file', 'q.rq']],
        ['no source', ['query']],
    ])('treats %s as a usage error', async (_name, arguments_) => {
        const run = harness(ANIMALS);
        expect(await runCli(arguments_, run.runtime)).toBe(CLI_EXIT.usage);
        expect(run.requests).toEqual([]);
    });

    describe('--questions', () => {
        function loaded(root: string, name: string, text: string): LoadedCompetencyQuestion {
            const bytes = new TextEncoder().encode(text);
            writeFileSync(join(root, name), text);
            const parsed = parseCompetencyQuestionMetadata(text);
            return {
                id: `root:competency-questions:${name}`,
                owner: { canonicalIri: 'https://example.test/root', role: 'root', ownedIriPrefixes: [] },
                locator: join(root, name),
                contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                bytes,
                text,
                placeholders: {},
                metadata: parsed.metadata,
                diagnostics: parsed.diagnostics,
            };
        }
        function head(expect: string, regime = ''): string {
            return `# @ask     Q?\n# @expect  ${expect}\n# @from    test\n${regime === '' ? '' : `# @regime  ${regime}\n`}`;
        }

        function questionsHarness(
            texts: ReadonlyArray<readonly [string, string]>,
            overrides: Partial<PreparedProjectQuery> = {},
        ) {
            const run = harness(ANIMALS);
            const root = run.runtime.cwd();
            const questions = texts.map(([name, text]) => loaded(root, name, text));
            const answer = prepared({ ...overrides, projectRoot: root, questions });
            const runtime: CliRuntime = {
                ...run.runtime,
                localQuery: {
                    prepare: (options = {}) => {
                        run.requests.push(options);
                        return Effect.succeed(answer);
                    },
                },
            };
            return { ...run, runtime, root };
        }

        it('runs each question under its regime and exits 0 when all are met and complete', async () => {
            const run = questionsHarness([
                ['a.rq', `${head('rows == 1')}${ANIMALS}`],
                ['b.rq', `${head('rows == 0', 'asserted')}${ANIMALS}`],
                ['c.rq', `${head('results c.srj')}${ANIMALS}`],
            ]);
            writeFileSync(
                join(run.root, 'c.srj'),
                JSON.stringify({
                    head: { vars: ['x'] },
                    results: { bindings: [{ x: { type: 'uri', value: 'https://example.test/root#rex' } }] },
                }),
            );
            expect(await runCli(['query', '--questions'], run.runtime)).toBe(0);
            const out = run.stdout.join('');
            expect(out).toContain('met              a.rq: 1 rows, expected == 1 [entailed]');
            expect(out).toContain('met              b.rq: 0 rows, expected == 0 [asserted]');
            expect(out).toContain('met              c.rq: results match: 1 rows, c.srj [entailed]');
            expect(out).toContain('3 questions: 3 met, 0 failed, 0 partial');
            expect(run.requests[0]).toMatchObject({ questions: 'all' });
        });

        it('exits 1 when a question fails, and 4 when all are met but one is partial', async () => {
            const failing = questionsHarness([['a.rq', `${head('rows == 0')}${ANIMALS}`]]);
            expect(
                await runCli(['query', '--questions', 'a.rq', 'root:competency-questions:a.rq'], failing.runtime),
            ).toBe(CLI_EXIT.semanticFailure);
            expect(failing.stdout.join('')).toContain('FAILED           a.rq: 1 rows, expected == 0');
            expect(failing.requests[0]).toMatchObject({
                questions: [
                    { name: 'a.rq', path: join(failing.root, 'a.rq') },
                    {
                        name: 'root:competency-questions:a.rq',
                        path: join(failing.root, 'root:competency-questions:a.rq'),
                    },
                ],
            });
            const partial = questionsHarness([['a.rq', `${head('rows == 0')}${ANIMALS}`]], PARTIAL);
            expect(await runCli(['query', '--questions', '--json'], partial.runtime)).toBe(CLI_EXIT.partial);
            const envelope = JSON.parse(partial.stdout.join('')) as { schema: string; questions: unknown[] };
            expect(envelope).toMatchObject({
                schema: 'erden.local-questions-result/v1',
                summary: { questions: 1, met: 1, failed: 0, incomplete: 1 },
                questions: [
                    {
                        file: 'a.rq',
                        regime: 'asserted',
                        ok: true,
                        completeness: { complete: false, reasons: PARTIAL.reasons },
                    },
                ],
            });
        });

        it('refuses an unknown question and a results output as usage errors', async () => {
            const unknown = questionsHarness([]);
            const answer = prepared({ unknownQuestions: ['nope'] });
            const runtime: CliRuntime = {
                ...unknown.runtime,
                localQuery: { prepare: () => Effect.succeed(answer) },
            };
            expect(await runCli(['query', '--questions', 'nope'], runtime)).toBe(CLI_EXIT.usage);
            expect(await runCli(['query', '--questions', '--csv'], unknown.runtime)).toBe(CLI_EXIT.usage);
            expect(await runCli(['query', '--questions', '--file', 'q.rq'], unknown.runtime)).toBe(CLI_EXIT.usage);
        });
    });
});
