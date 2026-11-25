import { describe, expect, it } from 'vitest';

import { RELEASE_QUERY_LIMITS, isReleaseQueryError, type ReleaseQueryRejectionReason } from '@erden/contracts';

import { parseReleaseQuery } from '../../src/index.js';

function reason(text: string): ReleaseQueryRejectionReason | 'accepted' {
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

describe('release query language', () => {
    it('P34 keeps one digest across whitespace, comments, prefix choice, keyword case, and variable sigils', () => {
        const variants = [
            'PREFIX ex: <https://example.test/o#>\nSELECT ?s WHERE { ?s a ex:C . }',
            'prefix e: <https://example.test/o#> select $s where{?s a e:C}',
            '# comment\nSELECT ?s # trailing\nWHERE {\n\t?s <http://www.w3.org/1999/02/22-rdf-syntax-ns#type> <https://example.test/o#C> .\n}',
            'SeLeCt ?s { $s a <https://example.test/o#C> }',
        ];
        const digests = new Set(variants.map((text) => parseReleaseQuery(text).querySha256));
        expect(digests.size).toBe(1);
    });

    it('appends the row sentinel only for SELECT without LIMIT', () => {
        expect(parseReleaseQuery('SELECT * { ?s ?p ?o }').engineQuery.endsWith(' LIMIT 1001')).toBe(true);
        expect(parseReleaseQuery('SELECT * { ?s ?p ?o } OFFSET 5').engineQuery.endsWith(' LIMIT 1001 OFFSET 5')).toBe(
            true,
        );
        expect(parseReleaseQuery('SELECT * { ?s ?p ?o } LIMIT 3').engineQuery.endsWith(' LIMIT 3')).toBe(true);
        expect(parseReleaseQuery('ASK { ?s ?p ?o }').engineQuery).toBe('ASK WHERE { ?s ?p ?o . }');
    });

    it('reports closed reasons for the principal forbidden features', () => {
        expect(reason('SELECT * { SERVICE <http://x.test/> { ?s ?p ?o } }')).toBe('service-forbidden');
        expect(reason('SELECT * WHERE { ?s ?p ?o }\n; DROP ALL')).toBe('update-forbidden');
        expect(reason('CONSTRUCT { ?s ?p ?o } WHERE { ?s ?p ?o }')).toBe('form-forbidden');
        expect(reason(`SELECT * { ?s ?p ?o } LIMIT ${String(RELEASE_QUERY_LIMITS.maxLimit + 1)}`)).toBe(
            'limit-exceeded',
        );
    });
});

describe('release query expansion and nesting bounds', () => {
    const namespace = `urn:${'a'.repeat(4_088)}`;

    it('rejects prefix expansion whose canonical text would exceed the engine query bound', () => {
        const objects = Array.from({ length: 64 }, (_, index) => `p:o${String(index)}`).join(', ');
        const rows = Array.from({ length: 120 }, () => '(p:a p:b p:c p:d)').join(' ');
        const amplified = `PREFIX p: <${namespace}>\nSELECT * WHERE { p:s (p:a/p:b/p:c/p:d/p:e/p:f/p:g/p:h) ${objects} . VALUES (?v ?w ?x ?y) { ${rows} } }`;
        expect(Buffer.byteLength(amplified)).toBeLessThanOrEqual(RELEASE_QUERY_LIMITS.maxQueryBytes);
        expect(reason(amplified)).toBe('complexity-limit');
        const patterns = Array.from({ length: 17 }, (_, index) => `?s ?p p:o${String(index)} .`).join(' ');
        expect(reason(`PREFIX p: <${namespace}>\nASK { ${patterns} }`)).toBe('complexity-limit');
    });

    it('accepts expansion up to the bound and never emits engine text beyond it', () => {
        const patterns = Array.from({ length: 4 }, (_, index) => `?s ?p p:o${String(index)} .`).join(' ');
        const parsed = parseReleaseQuery(`PREFIX p: <${namespace}>\nSELECT * WHERE { ${patterns} }`);
        expect(Buffer.byteLength(parsed.engineQuery)).toBeLessThanOrEqual(RELEASE_QUERY_LIMITS.maxEngineQueryBytes);
    });

    it('enforces expression depth and BIND scope inside EXISTS groups outside WHERE', () => {
        let deep = '?o';
        for (let level = 0; level < 17; level += 1) {
            deep = `(${deep} + 1)`;
        }
        const exists = `EXISTS { ?s ?p ?o . FILTER (${deep}) }`;
        expect(reason(`SELECT ?s WHERE { ?s ?p ?o . FILTER (${deep}) }`)).toBe('depth-limit');
        expect(reason(`SELECT ?s WHERE { ?s ?p ?o . } ORDER BY ASC(${exists})`)).toBe('depth-limit');
        expect(reason(`SELECT ?s (${exists} AS ?e) WHERE { ?s ?p ?o . }`)).toBe('depth-limit');
        expect(reason(`SELECT ?s WHERE { ?s ?p ?o . } GROUP BY ?s HAVING (${exists})`)).toBe('depth-limit');
        expect(reason(`SELECT ?k WHERE { ?s ?p ?o . } GROUP BY (${exists} AS ?k)`)).toBe('depth-limit');
        expect(reason(`SELECT (COUNT(${exists}) AS ?n) WHERE { ?s ?p ?o . }`)).toBe('depth-limit');
        const rebound = 'EXISTS { ?s ?p ?o . BIND (1 AS ?o) }';
        expect(reason(`SELECT ?s WHERE { ?s ?p ?o . FILTER (${rebound}) }`)).toBe('query-invalid');
        expect(reason(`SELECT ?s WHERE { ?s ?p ?o . } ORDER BY ASC(${rebound})`)).toBe('query-invalid');
    });
});
