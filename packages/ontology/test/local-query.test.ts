import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    LOCAL_QUERY_GRAPHS,
    assembleOntologyTolerant,
    localQueryNQuads,
    localQueryNTriples,
    runLocalQuery,
    scanSparqlQuery,
    type LocalQueryEngineInput,
} from '../src/index.js';

import { memoryResourcePort, sourceDescriptor, type SourceFixture } from './reasoner-helpers.js';

const PREFIXES = `@prefix ex: <https://example.test/root#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
`;

describe('scanSparqlQuery', () => {
    it('finds the query form after the prologue, ignoring prefixed names, IRIs, strings and comments', () => {
        expect(scanSparqlQuery('PREFIX select: <urn:x#>\n# ASK\nSELECT * { ?s select:p "ASK" }').form).toBe('select');
        expect(scanSparqlQuery('BASE <urn:x>\nask { ?s ?p ?o }').form).toBe('ask');
        expect(scanSparqlQuery('CONSTRUCT WHERE { ?s ?p ?o }').form).toBe('construct');
        expect(scanSparqlQuery('describe <urn:a>').form).toBe('describe');
        expect(scanSparqlQuery('PREFIX ex: <urn:x#> INSERT DATA { ex:a ex:b ex:c }').form).toBe('update');
        expect(scanSparqlQuery('LOAD <http://example.test/data.ttl>').form).toBe('update');
        expect(scanSparqlQuery('# nothing').form).toBeNull();
    });

    it('finds SERVICE anywhere it is a keyword and nowhere else', () => {
        expect(scanSparqlQuery('SELECT * { ?s ?p ?o FILTER EXISTS { SERVICE <urn:x> { ?s ?q ?z } } }').service).toBe(
            true,
        );
        expect(scanSparqlQuery('SELECT * { OPTIONAL { service silent ?endpoint { ?s ?p ?o } } }').service).toBe(true);
        expect(
            scanSparqlQuery(
                "PREFIX service: <urn:service#>\nSELECT ?service { ?service service:SERVICE \"SERVICE\" ; <urn:SERVICE> '''SERVICE''' } # SERVICE",
            ).service,
        ).toBe(false);
        expect(scanSparqlQuery('SELECT * { ?s ?p ?o FILTER (?o < 3 && ?o > 1) }').service).toBe(false);
    });

    it('tells a top-level ORDER BY from one in a subquery', () => {
        expect(scanSparqlQuery('SELECT ?s { ?s ?p ?o } ORDER BY ?s').ordered).toBe(true);
        expect(scanSparqlQuery('SELECT ?s { { SELECT ?s { ?s ?p ?o } ORDER BY ?s LIMIT 1 } }').ordered).toBe(false);
        expect(scanSparqlQuery('SELECT ?s { ?s <urn:order> "ORDER BY" }').ordered).toBe(false);
    });
});

async function assemble(fixtures: ReadonlyArray<SourceFixture>) {
    return await Effect.runPromise(
        assembleOntologyTolerant(memoryResourcePort(fixtures), fixtures.map(sourceDescriptor)),
    );
}

describe('assembleOntologyTolerant', () => {
    it('assembles the sources that parse and names each one that does not, with its position', async () => {
        const { graph, unparsed } = await assemble([
            { id: 'root:ontology:0000', locator: 'good.ttl', text: `${PREFIXES}ex:A rdfs:subClassOf ex:B .\n` },
            { id: 'root:ontology:0001', locator: 'broken.ttl', text: `${PREFIXES}ex:C rdfs:subClassOf .\n` },
            { id: 'root:ontology:0002', locator: 'latin1.ttl', bytes: Uint8Array.from([0xff, 0xfe, 0x41]) },
        ]);
        expect(graph.sources.map((source) => source.descriptor.id)).toEqual(['root:ontology:0000']);
        expect(graph.dataset.size).toBe(1);
        expect(unparsed.map((item) => [item.locator, item.code, item.line])).toEqual([
            ['broken.ttl', 'TURTLE_SOURCE_PARSE_ERROR', 3],
            ['latin1.ttl', 'TURTLE_SOURCE_ENCODING_ERROR', null],
        ]);
    });

    it('gives an empty graph when nothing parses', async () => {
        const { graph, unparsed } = await assemble([{ id: 'root:ontology:0000', locator: 'x.ttl', text: 'ex:a' }]);
        expect(graph.dataset.size).toBe(0);
        expect(unparsed).toHaveLength(1);
    });
});

function engineInput(overrides: Partial<LocalQueryEngineInput> = {}): LocalQueryEngineInput {
    const declared = '<urn:a> <urn:p> "one" .\n<urn:a> <urn:p> _:b1 .\n_:b1 <urn:label> "bnode" .\n';
    const inferred = '<urn:a> <urn:q> <urn:c> .\n';
    return {
        nquads: localQueryNQuads([
            { graph: LOCAL_QUERY_GRAPHS.declared, ntriples: declared },
            { graph: LOCAL_QUERY_GRAPHS.inferred, ntriples: inferred },
        ]),
        defaultGraph: [LOCAL_QUERY_GRAPHS.declared],
        namedGraphs: [LOCAL_QUERY_GRAPHS.declared, LOCAL_QUERY_GRAPHS.inferred],
        query: 'SELECT ?p ?o WHERE { <urn:a> ?p ?o } ORDER BY ?p ?o',
        format: 'json',
        milliseconds: 30_000,
        ...overrides,
    };
}

describe('runLocalQuery', () => {
    it('answers over the default graph it is given, as W3C SPARQL results', async () => {
        const asserted = await runLocalQuery(engineInput());
        expect(asserted.outcome).toBe('complete');
        const rows = JSON.parse(asserted.outcome === 'complete' ? asserted.text : '{}') as {
            results: { bindings: ReadonlyArray<Record<string, { value: string }>> };
        };
        expect(rows.results.bindings.map((row) => row.p?.value)).toEqual(['urn:p', 'urn:p']);
        const union = await runLocalQuery(
            engineInput({ defaultGraph: [LOCAL_QUERY_GRAPHS.declared, LOCAL_QUERY_GRAPHS.inferred] }),
        );
        expect(union.outcome === 'complete' && (JSON.parse(union.text) as typeof rows).results.bindings).toHaveLength(
            3,
        );
    });

    it('keeps blank nodes one node across graphs and gives the same labels each run', async () => {
        const query = 'SELECT ?label WHERE { <urn:a> <urn:p> ?b . ?b <urn:label> ?label }';
        const first = await runLocalQuery(engineInput({ query }));
        expect(first.outcome === 'complete' && first.text).toContain('"bnode"');
        const select = 'SELECT ?b WHERE { <urn:a> <urn:p> ?b FILTER isBlank(?b) }';
        const one = await runLocalQuery(engineInput({ query: select }));
        const two = await runLocalQuery(engineInput({ query: select }));
        expect(one).toMatchObject({ outcome: 'complete' });
        expect(one.outcome === 'complete' && two.outcome === 'complete' && one.text === two.text).toBe(true);
    });

    it('serializes CSV, TSV, ASK and graph answers with Oxigraph', async () => {
        const csv = await runLocalQuery(engineInput({ format: 'csv' }));
        expect(csv.outcome === 'complete' && csv.text.split('\r\n')[0]).toBe('p,o');
        const tsv = await runLocalQuery(engineInput({ format: 'tsv' }));
        expect(tsv.outcome === 'complete' && tsv.text.split('\n')[0]).toBe('?p\t?o');
        const ask = await runLocalQuery(engineInput({ query: 'ASK { GRAPH ?g { <urn:a> <urn:q> ?o } }' }));
        expect(ask.outcome === 'complete' && JSON.parse(ask.text)).toMatchObject({ boolean: true });
        const graph = await runLocalQuery(
            engineInput({
                query: 'CONSTRUCT { ?s <urn:r> ?o } WHERE { ?s <urn:p> "one" ; <urn:p> ?o }',
                format: 'ntriples',
            }),
        );
        expect(graph.outcome === 'complete' && graph.text).toContain('<urn:a> <urn:r> "one" .');
    });

    it('reports a syntax error as a refused query', async () => {
        const answer = await runLocalQuery(engineInput({ query: 'SELECT * WHERE { ?s ?p }' }));
        expect(answer.outcome).toBe('query-error');
    });

    it('stops a query that runs past its budget', async () => {
        const many = localQueryNTriples([]);
        expect(many).toBe('');
        const lines = Array.from({ length: 400 }, (_, index) => `<urn:s${String(index)}> <urn:p> "${String(index)}" .`);
        const answer = await runLocalQuery(
            engineInput({
                nquads: localQueryNQuads([{ graph: LOCAL_QUERY_GRAPHS.declared, ntriples: `${lines.join('\n')}\n` }]),
                query: 'SELECT (COUNT(*) AS ?n) WHERE { ?a ?p ?b . ?c ?q ?d . ?e ?r ?f . ?g ?t ?h }',
                milliseconds: 200,
            }),
        );
        expect(answer.outcome).toBe('time-limit');
    });
});
