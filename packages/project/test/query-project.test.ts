import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';

import {
    makeEmptyLockfile,
    nodeCurrentToolchainService,
    normalizeManifestV1,
    serializeLockfile,
    serializeManifestV1,
    type LoadedManifestV1,
} from '@erden/contracts';
import {
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
    type ReasonerServiceShape,
} from '@erden/ontology';
import { encodePackage } from '@erden/package-format';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import {
    disabledEntailmentCache,
    makeCheckProjectService,
    makeFixtureDependencyRegistry,
    makeManifestService,
    makeNodeEntailmentCache,
    makeNodeInstallProjectService,
    makeQueryProjectService,
    runLocalQuery,
    type EntailmentCachePort,
    type PreparedProjectQuery,
    type QueryProjectOptions,
} from '../src/index.js';

const tempRoots: string[] = [];
const CURRENT_TOOLCHAIN = Effect.runSync(nodeCurrentToolchainService.inspect());

afterEach(() => {
    for (const root of tempRoots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

function tempRoot(): string {
    const root = makeTestTempRoot('erden-query-project-');
    tempRoots.push(root);
    return root;
}

function write(path: string, text: string): void {
    writeFileSync(path, text, { encoding: 'utf8', mode: 0o644 });
}

const PREFIXES = `@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;
const ONTOLOGY = `${PREFIXES}<https://example.test/root> a owl:Ontology .
ex:Dog a owl:Class ; rdfs:subClassOf ex:Animal .
ex:Animal a owl:Class .
ex:rex a ex:Dog .
`;

function writeProject(
    files: Readonly<Record<string, string>>,
    options: Readonly<{
        sources?: ReadonlyArray<string>;
        dependencies?: Readonly<Record<string, string>>;
        outsideProfile?: 'report';
    }> = {},
): string {
    const root = tempRoot();
    for (const [name, text] of Object.entries(files)) {
        write(join(root, name), text);
    }
    const manifest: LoadedManifestV1['manifest'] = normalizeManifestV1({
        schemaVersion: 1,
        canonicalIri: 'https://example.test/root',
        alias: '@example/root',
        ownedIriPrefixes: ['https://example.test/root#'],
        sources: { ontology: [...(options.sources ?? ['ontology.ttl'])] },
        dependencies: options.dependencies ?? {},
        ...(options.outsideProfile === undefined ? {} : { outsideProfile: options.outsideProfile }),
    });
    write(join(root, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
    if (Object.keys(manifest.dependencies).length === 0) {
        write(join(root, 'erden.lock'), serializeLockfile(makeEmptyLockfile(manifest, CURRENT_TOOLCHAIN)));
    }
    return root;
}

function counting(reasoner: ReasonerServiceShape): { service: ReasonerServiceShape; calls: () => number } {
    let calls = 0;
    return {
        service: Object.freeze({
            ...reasoner,
            decideAndMaterialize: (...input: Parameters<ReasonerServiceShape['decideAndMaterialize']>) => {
                calls += 1;
                return reasoner.decideAndMaterialize(...input);
            },
        }),
        calls: () => calls,
    };
}

function queryService(cache: EntailmentCachePort = disabledEntailmentCache, reasoner = nodeReasonerService) {
    return makeQueryProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        reasoner,
        undefined,
        undefined,
        undefined,
        cache,
    );
}

async function prepare(root: string, options: QueryProjectOptions = {}, service = queryService()) {
    return await Effect.runPromise(service.prepare({ from: root, ...options }));
}

async function ask(prepared: PreparedProjectQuery, query: string): Promise<boolean> {
    const answer = await runLocalQuery({
        ...prepared.dataset,
        query,
        format: 'json',
        milliseconds: 30_000,
    });
    if (answer.outcome !== 'complete') {
        throw new Error(`query did not complete: ${JSON.stringify(answer)}`);
    }
    return (JSON.parse(answer.text) as { boolean: boolean }).boolean;
}

const REX_IS_ANIMAL = 'ASK { <https://example.test/root#rex> a <https://example.test/root#Animal> }';

describe('QueryProject', () => {
    it('answers entailed when reasoning succeeds and asserted when asked, each complete', async () => {
        const root = writeProject({ 'ontology.ttl': ONTOLOGY });
        const entailed = await prepare(root);
        expect(entailed).toMatchObject({ regime: 'entailed', reasons: [], entailedUnavailable: false });
        expect(entailed.entailment).toMatchObject({
            profile: { id: 'erden-required-constructs-v2' },
            reasoner: { name: 'erden-reasoner' },
            cached: false,
        });
        expect(entailed.dataset.quadCounts.inferred).toBeGreaterThan(0);
        expect(await ask(entailed, REX_IS_ANIMAL)).toBe(true);
        expect(
            await ask(
                entailed,
                'ASK { GRAPH <urn:erden:release-query:v1:graph:inferred> { <https://example.test/root#rex> a <https://example.test/root#Animal> } }',
            ),
        ).toBe(true);
        const asserted = await prepare(root, { regime: 'asserted' });
        expect(asserted).toMatchObject({ regime: 'asserted', reasons: [], entailment: null });
        expect(await ask(asserted, REX_IS_ANIMAL)).toBe(false);
    });

    it('reuses the inferences check or an earlier query kept for the same inputs, and only those', async () => {
        const root = writeProject({ 'ontology.ttl': ONTOLOGY });
        const cache = makeNodeEntailmentCache(join(tempRoot(), 'cache'));
        const reasoner = counting(nodeReasonerService);
        const report = await Effect.runPromise(
            makeCheckProjectService(
                makeManifestService(),
                makeOntologyService(makeNodeOntologyPorts()),
                nodeReasonerService,
                undefined,
                undefined,
                undefined,
                cache,
            ).check({ from: root }),
        );
        expect(report.outcome).toBe('passed');
        const fromCheck = await prepare(root, {}, queryService(cache, reasoner.service));
        expect(fromCheck.entailment).toMatchObject({ cached: true, inputDigest: report.reasoning.inputDigest });
        expect(reasoner.calls()).toBe(0);
        expect(await ask(fromCheck, REX_IS_ANIMAL)).toBe(true);
        write(join(root, 'ontology.ttl'), `${ONTOLOGY}ex:fido a ex:Dog .\n`);
        const changed = await prepare(root, {}, queryService(cache, reasoner.service));
        expect(changed.entailment).toMatchObject({ cached: false });
        expect(reasoner.calls()).toBe(1);
        expect(
            await ask(changed, 'ASK { <https://example.test/root#fido> a <https://example.test/root#Animal> }'),
        ).toBe(true);
    });

    it('answers from the sources that parse and names each one that does not', async () => {
        const root = writeProject(
            { 'ontology.ttl': ONTOLOGY, 'broken.ttl': `${PREFIXES}ex:cat a .\n` },
            { sources: ['ontology.ttl', 'broken.ttl', 'missing.ttl'] },
        );
        const prepared = await prepare(root);
        expect(prepared.regime).toBe('entailed');
        expect(prepared.reasons).toEqual([
            {
                code: 'sources-unparsed',
                sources: [
                    expect.objectContaining({ file: 'missing.ttl', line: null }),
                    expect.objectContaining({ file: 'broken.ttl', line: 4, code: 'TURTLE_SOURCE_PARSE_ERROR' }),
                ],
            },
        ]);
        expect(await ask(prepared, REX_IS_ANIMAL)).toBe(true);
    });

    it('falls back to asserted, labeled, when the reasoner refuses, and keeps the refusal', async () => {
        const root = writeProject({ 'ontology.ttl': ONTOLOGY });
        const cache = makeNodeEntailmentCache(join(tempRoot(), 'cache'));
        const reasoner = counting(nodeReasonerService);
        const limits = {
            maxWallTimeMs: 30_000,
            maxInputAxioms: 1,
            maxInferences: 100_000,
            maxRequestBytes: 16_777_216,
        };
        const first = await prepare(root, { reasonerLimits: limits }, queryService(cache, reasoner.service));
        expect(first).toMatchObject({ regime: 'asserted', entailment: null, entailedUnavailable: false });
        expect(first.reasons).toEqual([{ code: 'entailment-unavailable', cause: expect.any(String) as string }]);
        const again = await prepare(
            root,
            { reasonerLimits: limits, regime: 'entailed' },
            queryService(cache, reasoner.service),
        );
        expect(reasoner.calls()).toBe(1);
        expect(again).toMatchObject({ regime: 'asserted', entailedUnavailable: true, reasons: first.reasons });
        const defaults = await prepare(root, {}, queryService(cache, reasoner.service));
        expect(defaults.regime).toBe('entailed');
        expect(reasoner.calls()).toBe(2);
    });

    it('never answers entailed over an inconsistent ontology', async () => {
        const root = writeProject({
            'ontology.ttl': `${ONTOLOGY}ex:Cat a owl:Class ; owl:disjointWith ex:Dog .\nex:rex a ex:Cat .\n`,
        });
        const prepared = await prepare(root);
        expect(prepared).toMatchObject({
            regime: 'asserted',
            reasons: [{ code: 'entailment-unavailable', cause: 'global-inconsistency' }],
        });
    });

    it('counts the statements a report-mode project leaves out of reasoning', async () => {
        const root = writeProject(
            {
                'ontology.ttl': `${ONTOLOGY}ex:Cat a owl:Class ; owl:equivalentClass [ a owl:Class ; owl:complementOf ex:Dog ] .\n`,
            },
            { outsideProfile: 'report' },
        );
        const prepared = await prepare(root);
        expect(prepared.regime).toBe('entailed');
        expect(prepared.reasons).toEqual([{ code: 'statements-outside-profile', count: expect.any(Number) as number }]);
    });

    it('answers over the project alone when its dependencies are not installed', async () => {
        const root = writeProject({ 'ontology.ttl': ONTOLOGY }, { dependencies: { '@example/dependency': '^1.0.0' } });
        const prepared = await prepare(root, { regime: 'asserted' });
        expect(prepared.reasons).toEqual([{ code: 'dependencies-missing', cause: 'CHECK_LOCK_MISSING' }]);
        expect(await ask(prepared, 'ASK { <https://example.test/root#rex> a <https://example.test/root#Dog> }')).toBe(
            true,
        );
    });

    it('answers over installed dependencies too', async () => {
        const workspace = tempRoot();
        const projectRoot = join(workspace, 'consumer');
        mkdirSync(projectRoot, { recursive: true });
        const dependencyManifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/dependency',
            alias: '@example/dependency',
            ownedIriPrefixes: ['https://example.test/dependency#'],
            dependencies: {},
            sources: { ontology: ['ontology.ttl'] },
        });
        const encoded = encodePackage({
            canonicalIri: dependencyManifest.canonicalIri,
            version: '1.0.0',
            dependencies: [],
            validator: CURRENT_TOOLCHAIN.validator,
            reasoner: CURRENT_TOOLCHAIN.reasoner,
            files: [
                {
                    path: 'erden.config.json',
                    bytes: serializeManifestV1(dependencyManifest, 'json'),
                    executable: false,
                },
                {
                    path: 'erden.lock',
                    bytes: serializeLockfile(makeEmptyLockfile(dependencyManifest, CURRENT_TOOLCHAIN)),
                    executable: false,
                },
                {
                    path: 'ontology.ttl',
                    bytes: '@prefix dep: <https://example.test/dependency#> .\n@prefix owl: <http://www.w3.org/2002/07/owl#> .\ndep:Animal a owl:Class .\n',
                    executable: false,
                },
            ],
        });
        const registry = makeFixtureDependencyRegistry({
            registryOrigin: 'https://registry.example',
            aliases: [{ alias: '@example/dependency', canonicalIri: dependencyManifest.canonicalIri }],
            packages: [
                {
                    canonicalIri: dependencyManifest.canonicalIri,
                    version: '1.0.0',
                    archiveSha256: encoded.archiveSha256,
                    manifest: encoded.manifest,
                    archive: encoded.archiveBytes,
                },
            ],
        });
        const manifest = normalizeManifestV1({
            schemaVersion: 1,
            canonicalIri: 'https://example.test/root',
            alias: '@example/root',
            ownedIriPrefixes: ['https://example.test/root#'],
            registry: 'https://registry.example',
            dependencies: { '@example/dependency': '^1.0.0' },
            sources: { ontology: ['ontology.ttl'] },
        });
        write(join(projectRoot, 'erden.config.json'), serializeManifestV1(manifest, 'json'));
        write(
            join(projectRoot, 'ontology.ttl'),
            `${PREFIXES}ex:Dog a owl:Class ; rdfs:subClassOf <https://example.test/dependency#Animal> .\nex:rex a ex:Dog .\n`,
        );
        await Effect.runPromise(
            makeNodeInstallProjectService(registry).install({ from: projectRoot, storeRoot: join(workspace, 'store') }),
        );
        const prepared = await prepare(projectRoot);
        expect(prepared).toMatchObject({ regime: 'entailed', reasons: [] });
        expect(
            await ask(prepared, 'ASK { <https://example.test/root#rex> a <https://example.test/dependency#Animal> }'),
        ).toBe(true);
    });
});
