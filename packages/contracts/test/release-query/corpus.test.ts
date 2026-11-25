import { readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';

import { describe, expect, it } from 'vitest';

import {
    RELEASE_QUERY_GRAPHS,
    RELEASE_QUERY_LIMITS,
    RELEASE_QUERY_REJECTION_REASONS,
    isReleaseQueryError,
    type ReleaseQueryRejectionReason,
} from '@erden/contracts';

import { decodeReleaseQueryBytes, parseReleaseQuery } from '../../src/index.js';

const root = new URL('../fixtures/release-query/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', root), 'utf8')) as {
    readonly schema: string;
    readonly accepted: ReadonlyArray<string>;
    readonly rejected: Readonly<Record<string, ReleaseQueryRejectionReason>>;
};

function fixture(kind: 'accepted' | 'rejected', name: string): string {
    return readFileSync(new URL(`${kind}/${name}`, root), 'utf8');
}

function outcome(text: string): ReleaseQueryRejectionReason | 'accepted' {
    try {
        parseReleaseQuery(text);
        return 'accepted';
    } catch (cause) {
        if (isReleaseQueryError(cause) && cause.code === 'RELEASE_QUERY_REJECTED' && cause.reason !== null) {
            return cause.reason;
        }
        throw cause;
    }
}

function mulberry32(seed: number): () => number {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let value = state;
        value = Math.imul(value ^ (value >>> 15), value | 1);
        value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
        return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
    };
}

const FRAGMENTS = [
    ' ',
    '{',
    '}',
    '(',
    ')',
    '.',
    ';',
    ',',
    '*',
    '+',
    '?',
    '!',
    '^',
    '|',
    '/',
    '"',
    "'",
    '<',
    '>',
    '<<',
    '#',
    '\n',
    '\\u0041',
    '\\',
    '_:b',
    '[]',
    '$',
    '@en',
    '^^',
    '1001',
    'SERVICE ',
    'SERVICE SILENT <http://x.test/> ',
    'LOAD <file:///etc/passwd> ',
    'FROM <file:///etc/passwd> ',
    'INSERT ',
    'DELETE ',
    'SELECT ',
    'ASK ',
    'OPTIONAL ',
    'UNION ',
    'MINUS ',
    'FILTER ',
    'BIND ',
    'VALUES ',
    'GRAPH ',
    'EXISTS ',
    'NOT ',
    'BASE <http://x.test/> ',
    'PREFIX x: <urn:x:> ',
    'NOW()',
    'RAND()',
    'REPLACE',
    'REGEX',
    'COUNT(*)',
    '<urn:erden:release-query:v1:graph:inferred>',
    '<http://x.test/fn>(',
    '?s ?p ?o . ',
    ' LIMIT 5',
    ' OFFSET 3',
    ' GROUP BY ?s',
    ' ORDER BY ?s',
    '\u0000',
    '﻿',
    '‮',
    '😀',
];

function mutate(base: string, random: () => number): string {
    let text = base;
    const edits = 1 + Math.floor(random() * 3);
    for (let edit = 0; edit < edits; edit += 1) {
        const at = Math.floor(random() * (text.length + 1));
        const choice = random();
        if (choice < 0.35) {
            const length = 1 + Math.floor(random() * 6);
            text = text.slice(0, at) + text.slice(at + length);
        } else if (choice < 0.8) {
            const fragment = FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
            text = text.slice(0, at) + fragment + text.slice(at);
        } else {
            const length = 1 + Math.floor(random() * 12);
            text = text.slice(0, at) + text.slice(at, at + length).repeat(2) + text.slice(at + length);
        }
    }
    return text;
}

interface OxigraphStore {
    readonly load: (input: string, options: Readonly<Record<string, unknown>>) => void;
    readonly query: (query: string, options: Readonly<Record<string, unknown>>) => unknown;
}
interface Oxigraph {
    readonly Store: new () => OxigraphStore;
    readonly namedNode: (value: string) => unknown;
}

function differentialStore(): Readonly<{ oxigraph: Oxigraph; store: OxigraphStore }> {
    const oxigraph = createRequire(new URL('../../../ontology/package.json', import.meta.url))('oxigraph') as Oxigraph;
    const store = new oxigraph.Store();
    const ex = 'https://example.test/onto#';
    const declared = [
        `<${ex}A> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .`,
        `<${ex}B> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .`,
        `<${ex}C> <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <http://www.w3.org/2002/07/owl#Class> .`,
        `<${ex}B> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${ex}A> .`,
        `<${ex}C> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${ex}B> .`,
        `<${ex}A> <http://www.w3.org/2000/01/rdf-schema#label> "Class A"@en .`,
        `<${ex}A> <http://www.w3.org/2000/01/rdf-schema#label> "classe A"@fr .`,
        `<${ex}B> <http://www.w3.org/2000/01/rdf-schema#label> "Class B" .`,
        `<${ex}D> <http://www.w3.org/2002/07/owl#deprecated> "true"^^<http://www.w3.org/2001/XMLSchema#boolean> .`,
        `<${ex}A> <${ex}p> <${ex}B> .`,
        `<${ex}A> <${ex}q> <${ex}B> .`,
    ].join('\n');
    const inferred = `<${ex}C> <http://www.w3.org/2000/01/rdf-schema#subClassOf> <${ex}A> .`;
    store.load(declared, {
        format: 'application/n-quads',
        to_graph_name: oxigraph.namedNode(RELEASE_QUERY_GRAPHS.declared),
    });
    store.load(inferred, {
        format: 'application/n-quads',
        to_graph_name: oxigraph.namedNode(RELEASE_QUERY_GRAPHS.inferred),
    });
    return { oxigraph, store };
}

function run(context: ReturnType<typeof differentialStore>, query: string, ordered: boolean): unknown {
    const raw = context.store.query(query, {
        results_format: 'application/sparql-results+json',
        default_graph: context.oxigraph.namedNode(RELEASE_QUERY_GRAPHS.declared),
        named_graphs: [
            context.oxigraph.namedNode(RELEASE_QUERY_GRAPHS.declared),
            context.oxigraph.namedNode(RELEASE_QUERY_GRAPHS.inferred),
        ],
    });
    const value = JSON.parse(String(raw)) as {
        head: unknown;
        boolean?: boolean;
        results?: { bindings: unknown[] };
    };
    if (value.results === undefined || ordered) {
        return value;
    }
    return { head: value.head, rows: value.results.bindings.map((row) => JSON.stringify(row)).sort() };
}

describe('release query adversarial corpus', () => {
    it('records a closed manifest with only known reasons', () => {
        expect(manifest.schema).toBe('erden.release-query-corpus/v1');
        expect(readdirSync(new URL('accepted/', root)).sort()).toEqual([...manifest.accepted].sort());
        expect(readdirSync(new URL('rejected/', root)).sort()).toEqual(Object.keys(manifest.rejected).sort());
        for (const reason of Object.values(manifest.rejected)) {
            expect(RELEASE_QUERY_REJECTION_REASONS).toContain(reason);
        }
    });

    it('accepts every accepted fixture and rejects every rejected fixture with its recorded reason', () => {
        for (const name of manifest.accepted) {
            expect([name, outcome(fixture('accepted', name))]).toEqual([name, 'accepted']);
        }
        for (const [name, reason] of Object.entries(manifest.rejected)) {
            expect([name, outcome(fixture('rejected', name))]).toEqual([name, reason]);
        }
    });

    it('P01 P02 P03 P04 P05 enforce size, token, depth, and pattern bounds', () => {
        const base = 'SELECT * { ?s ?p ?o }';
        expect(outcome(`${base}${' '.repeat(RELEASE_QUERY_LIMITS.maxQueryBytes - base.length)}`)).toBe('accepted');
        expect(outcome(`${base}${' '.repeat(RELEASE_QUERY_LIMITS.maxQueryBytes - base.length + 1)}`)).toBe(
            'query-too-large',
        );
        expect(outcome(`SELECT * { ?s ?p ?o ${'; '.repeat(2_040)} }`)).toBe('accepted');
        expect(outcome(`SELECT * { ?s ?p ?o ${'; '.repeat(2_045)} }`)).toBe('token-limit');
        expect(outcome(`SELECT * ${'{ '.repeat(8)}?s ?p ?o${' }'.repeat(8)}`)).toBe('accepted');
        expect(outcome(`SELECT * ${'{ '.repeat(9)}?s ?p ?o${' }'.repeat(9)}`)).toBe('depth-limit');
        expect(outcome(`SELECT * { FILTER (${'STR('.repeat(15)}?o${')'.repeat(15)}) }`)).toBe('accepted');
        expect(outcome(`SELECT * { FILTER (${'STR('.repeat(16)}?o${')'.repeat(16)}) }`)).toBe('depth-limit');
        function patterns(count: number): string {
            return `SELECT * { ${Array.from({ length: count }, (_, index) => `?s <urn:p${String(index)}> ?o .`).join(' ')} }`;
        }
        expect(outcome(patterns(64))).toBe('accepted');
        expect(outcome(patterns(65))).toBe('pattern-limit');
        expect(outcome(`SELECT * { ${'OPTIONAL { ?s ?p ?o } '.repeat(17)} }`)).toBe('pattern-limit');
        expect(outcome(`SELECT * { ${'FILTER (true) '.repeat(33)} }`)).toBe('pattern-limit');
        expect(outcome(`SELECT * { ${Array.from({ length: 17 }, () => '{ ?s ?p ?o }').join(' UNION ')} }`)).toBe(
            'pattern-limit',
        );
    });

    it('P06 P08 reject a BOM and malformed UTF-8 at the byte boundary', () => {
        function bytesOutcome(bytes: Uint8Array): string {
            try {
                return outcome(decodeReleaseQueryBytes(bytes));
            } catch (cause) {
                return isReleaseQueryError(cause) ? (cause.reason ?? cause.code) : 'thrown';
            }
        }
        expect(bytesOutcome(Uint8Array.from([0xef, 0xbb, 0xbf, ...Buffer.from('ASK {}')]))).toBe('encoding-invalid');
        expect(
            bytesOutcome(Uint8Array.from([...Buffer.from('ASK { ?s ?p "'), 0xc3, 0x28, ...Buffer.from('" }')])),
        ).toBe('encoding-invalid');
        expect(
            bytesOutcome(Uint8Array.from([...Buffer.from('ASK { ?s ?p "'), 0xed, 0xa0, 0x80, ...Buffer.from('" }')])),
        ).toBe('encoding-invalid');
        expect(bytesOutcome(new Uint8Array(RELEASE_QUERY_LIMITS.maxQueryBytes + 1).fill(32))).toBe('query-too-large');
        expect(bytesOutcome(Buffer.from('ASK { ?s ?p ?o }'))).toBe('accepted');
        // P07: a NUL inside a string; generated, so the repository holds no file with a NUL byte.
        expect(bytesOutcome(Buffer.from('SELECT * { ?s ?p "a\u0000b" }'))).toBe('encoding-invalid');
    });

    it('P33 rejects pathological input in linear time', () => {
        const cases = [
            `SELECT * { FILTER (${'('.repeat(8_000)}`,
            `SELECT * ${'{'.repeat(8_000)}`,
            `SELECT * { ?s ?p """${'a'.repeat(8_000)}`,
            `SELECT * { ?s ?p "${'a'.repeat(8_000)}`,
            `SELECT * { ?s ?p ?o ${';'.repeat(4_000)} }`,
            `SELECT * { ?s ?p <${'a'.repeat(8_000)}`,
            '#'.repeat(8_000),
            `SELECT * { ?s ${'^'.repeat(4_000)}<urn:p> ?o }`,
            `SELECT * { ?s ${'('.repeat(4_000)}<urn:p> ?o }`,
        ];
        for (const text of cases) {
            const started = performance.now();
            expect(outcome(text)).not.toBe('accepted');
            expect(performance.now() - started).toBeLessThan(50);
        }
    });

    it('P35 keeps bidirectional controls and homoglyphs as inert data', () => {
        const parsed = parseReleaseQuery(fixture('accepted', 'p35-bidi-homoglyph.rq'));
        expect(parsed.canonical).toContain('‮evil‬ text');
        expect(parsed.canonical).toContain('https://exаmple.test/сlass');
    });

    it('never throws an unclosed error across 5,000 seeded mutations and round-trips every accepted mutant', () => {
        const random = mulberry32(0x5eed_2024);
        const bases = manifest.accepted.map((name) => fixture('accepted', name));
        const reasons = new Set<string>(RELEASE_QUERY_REJECTION_REASONS);
        let accepted = 0;
        for (let index = 0; index < 5_000; index += 1) {
            const text = mutate(bases[index % bases.length] ?? '', random);
            let parsed;
            try {
                parsed = parseReleaseQuery(text);
            } catch (cause) {
                if (!isReleaseQueryError(cause) || cause.code !== 'RELEASE_QUERY_REJECTED' || cause.reason === null) {
                    throw new Error(`Unclosed failure for mutant ${String(index)}`, { cause });
                }
                expect(reasons.has(cause.reason)).toBe(true);
                continue;
            }
            accepted += 1;
            if (
                Buffer.byteLength(parsed.canonical) <= RELEASE_QUERY_LIMITS.maxQueryBytes &&
                parsed.canonical.length < 4_000
            ) {
                const again = parseReleaseQuery(parsed.canonical);
                expect(again.canonical).toBe(parsed.canonical);
                expect(again.querySha256).toBe(parsed.querySha256);
            }
        }
        expect(accepted).toBeGreaterThan(100);
    });

    it('returns identical engine results for the original and canonical text of every accepted fixture', () => {
        const context = differentialStore();
        for (const name of manifest.accepted) {
            const text = fixture('accepted', name);
            const parsed = parseReleaseQuery(text);
            const ordered = parsed.ast.form === 'select' && parsed.ast.orderBy.length > 0;
            expect([name, run(context, parsed.canonical, ordered)]).toEqual([name, run(context, text, ordered)]);
            expect(() => run(context, parsed.engineQuery, ordered)).not.toThrow();
        }
    });
});
