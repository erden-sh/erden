import { createHash } from 'node:crypto';

import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';

import {
    expectedResultsLocator,
    judgeQuestionAnswer,
    makeReasonerService,
    parseCompetencyQuestionExpectation,
    parseCompetencyQuestionMetadata,
    questionAnswerFormats,
    runCompetencyQuestions,
    sourceGraphIri,
    type LoadedCompetencyQuestion,
} from '../src/index.js';

import { ROOT_OWNER, assembleFixtures } from './reasoner-helpers.js';

const encoder = new TextEncoder();

function question(id: string, text: string, locator = `/project/queries/${id}.rq`): LoadedCompetencyQuestion {
    const bytes = encoder.encode(text);
    const parsed = parseCompetencyQuestionMetadata(text);
    return Object.freeze({
        id: `root:competency-questions:${id}`,
        owner: ROOT_OWNER,
        locator,
        contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
        bytes,
        text,
        placeholders: {},
        metadata: parsed.metadata,
        diagnostics: parsed.diagnostics,
    });
}

function header(expectation: string, regime?: string): string {
    return `# @ask     A question?\n# @expect  ${expectation}\n# @from    test\n${regime === undefined ? '' : `# @regime  ${regime}\n`}`;
}

const SELECT = JSON.stringify({
    head: { vars: ['x', 'label'] },
    results: {
        bindings: [
            { x: { type: 'uri', value: 'urn:a' }, label: { type: 'literal', value: 'A', 'xml:lang': 'en' } },
            {
                x: { type: 'bnode', value: 'b0' },
                label: { type: 'literal', value: '2', datatype: 'http://www.w3.org/2001/XMLSchema#integer' },
            },
        ],
    },
});

describe('question metadata', () => {
    it('reads @regime and the three expectation forms, and refuses what it cannot read', () => {
        expect(parseCompetencyQuestionMetadata(header('rows == 0', 'asserted')).diagnostics).toEqual([]);
        expect(parseCompetencyQuestionMetadata(header('rows == 0', 'rdfs')).diagnostics).toEqual([
            { code: 'invalid-regime', message: 'Unknown @regime: rdfs (asserted or entailed)' },
        ]);
        expect(parseCompetencyQuestionExpectation('results expected/a.srj')).toEqual({
            kind: 'results',
            file: 'expected/a.srj',
        });
        expect(parseCompetencyQuestionExpectation('contains a.csv')).toEqual({ kind: 'contains', file: 'a.csv' });
        for (const bad of ['results ../a.srj', 'results /etc/a.srj', 'results a.ttl', 'rows = 3', 'contains']) {
            expect(parseCompetencyQuestionExpectation(bad)).toBeNull();
        }
        expect(expectedResultsLocator(question('q', header('results expected/a.srj')))).toBe(
            '/project/queries/expected/a.srj',
        );
        expect(questionAnswerFormats('SELECT * {}', 'contains a.tsv')).toEqual(['json', 'tsv']);
        expect(questionAnswerFormats('CONSTRUCT WHERE { ?s ?p ?o }', 'rows > 1')).toEqual(['ntriples']);
    });
});

describe('judgeQuestionAnswer', () => {
    function expected(value: unknown): Uint8Array {
        return encoder.encode(typeof value === 'string' ? value : JSON.stringify(value));
    }

    it('compares results as a set, matching any blank node to any other', () => {
        const reordered = JSON.parse(SELECT) as { results: { bindings: unknown[] } };
        reordered.results.bindings.reverse();
        (reordered.results.bindings[0] as { x: { value: string } }).x.value = 'other-label';
        expect(judgeQuestionAnswer('results e.srj', { json: SELECT }, expected(reordered), false)).toMatchObject({
            ok: true,
            rows: 2,
        });
        expect(judgeQuestionAnswer('results e.srj', { json: SELECT }, expected(reordered), true)).toMatchObject({
            ok: false,
            reason: 'results differ from e.srj: the order differs',
        });
        const fewer = JSON.parse(SELECT) as { results: { bindings: unknown[] } };
        fewer.results.bindings.pop();
        expect(judgeQuestionAnswer('results e.srj', { json: SELECT }, expected(fewer), false)).toMatchObject({
            ok: false,
            reason: 'results differ from e.srj: 0 expected rows missing, 1 unexpected',
        });
        expect(judgeQuestionAnswer('contains e.srj', { json: SELECT }, expected(fewer), false)).toMatchObject({
            ok: true,
        });
    });

    it('keeps language and datatype in the comparison', () => {
        const changed = SELECT.replace('"xml:lang":"en"', '"xml:lang":"fr"');
        expect(judgeQuestionAnswer('results e.srj', { json: SELECT }, expected(changed), false).ok).toBe(false);
    });

    it('compares CSV and TSV answers in the W3C serializations', () => {
        const csv = 'label,x\r\n"A, quoted",urn:a\r\n2,_:b1\r\n';
        const sameCsv = 'x,label\r\n_:other,2\r\nurn:a,"A, quoted"\r\n';
        expect(judgeQuestionAnswer('results e.csv', { json: SELECT, csv }, expected(sameCsv), false).ok).toBe(true);
        const tsv = '?x\t?label\n<urn:a>\t"A"@en\n';
        expect(
            judgeQuestionAnswer(
                'contains e.tsv',
                { json: SELECT, tsv },
                expected('?label\t?x\n"A"@en\t<urn:a>\n'),
                false,
            ).ok,
        ).toBe(true);
        expect(
            judgeQuestionAnswer(
                'contains e.tsv',
                { json: SELECT, tsv },
                expected('?label\t?x\n"B"@en\t<urn:a>\n'),
                false,
            ),
        ).toMatchObject({
            ok: false,
            reason: 'contains differ from e.tsv: 1 expected rows missing, 0 unexpected',
        });
    });

    it('says when the expected file is missing or not results', () => {
        expect(judgeQuestionAnswer('results e.srj', { json: SELECT }, null, false).reason).toBe(
            'expected results file e.srj could not be read',
        );
        expect(judgeQuestionAnswer('results e.srj', { json: SELECT }, expected('nope'), false).ok).toBe(false);
        expect(
            judgeQuestionAnswer(
                'results e.srj',
                { json: '{"head":{},"boolean":true}' },
                expected({ head: {}, boolean: true }),
                false,
            ).ok,
        ).toBe(true);
    });
});

const ONTOLOGY = `@prefix ex: <https://example.test/root#> .
@prefix owl: <http://www.w3.org/2002/07/owl#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
<https://example.test/root> a owl:Ontology .
ex:Dog a owl:Class ; rdfs:subClassOf ex:Animal .
ex:Animal a owl:Class .
`;
const DATA = `@prefix ex: <https://example.test/root#> .
ex:rex a ex:Dog .
`;
const ANIMALS = 'SELECT ?x WHERE { ?x a <https://example.test/root#Animal> }';

describe('runCompetencyQuestions', () => {
    it('answers each question under its own regime, and reads the graph of each source', async () => {
        const graph = await assembleFixtures([
            { id: 'root:ontology:0000', locator: 'ontology.ttl', text: ONTOLOGY },
            { id: 'root:ontology:0001:data.ttl', locator: 'data.ttl', text: DATA },
        ]);
        const reasoned = await Effect.runPromise(makeReasonerService().reason(graph));
        const validation = runCompetencyQuestions(reasoned, [
            question('a-entailed', `${header('rows == 1')}${ANIMALS}`),
            question('b-asserted', `${header('rows == 0', 'asserted')}${ANIMALS}`),
            question(
                'c-source',
                `${header('rows == 1', 'asserted')}SELECT ?x WHERE { GRAPH <${sourceGraphIri('root:ontology:0001:data.ttl')}> { ?x a ?type } }`,
            ),
        ]);
        expect(validation.questions.map((item) => [item.id, item.ok, item.rows, item.regime])).toEqual([
            ['root:competency-questions:a-entailed', true, 1, undefined],
            ['root:competency-questions:b-asserted', true, 0, 'asserted'],
            ['root:competency-questions:c-source', true, 1, 'asserted'],
        ]);
        expect(sourceGraphIri('root:ontology:0001:a b.ttl')).toBe('urn:erden:source:root:ontology:0001:a%20b.ttl');
    });

    it('runs over the asserted statements alone when reasoning did not complete, and says so', async () => {
        const graph = await assembleFixtures([
            { id: 'root:ontology:0000', locator: 'ontology.ttl', text: `${ONTOLOGY}${DATA}` },
        ]);
        const validation = runCompetencyQuestions(
            graph,
            [
                question('a', `${header('rows == 1')}${ANIMALS}`),
                question('b', `${header('rows == 0', 'asserted')}${ANIMALS}`),
            ],
            { entailmentUnavailable: 'global-inconsistency' },
        );
        expect(
            validation.questions.map((item) => [item.ok, item.rows, item.regime, item.entailmentUnavailable]),
        ).toEqual([
            [false, 0, 'asserted', 'global-inconsistency'],
            [true, 0, 'asserted', undefined],
        ]);
    });

    it('judges expected-results files it is given', async () => {
        const graph = await assembleFixtures([
            { id: 'root:ontology:0000', locator: 'ontology.ttl', text: `${ONTOLOGY}${DATA}` },
        ]);
        const expectedFile = JSON.stringify({
            head: { vars: ['x'] },
            results: { bindings: [{ x: { type: 'uri', value: 'https://example.test/root#rex' } }] },
        });
        const asked = question(
            'a',
            `${header('results a.srj', 'asserted')}SELECT ?x WHERE { ?x a <https://example.test/root#Dog> }`,
        );
        const validation = runCompetencyQuestions(graph, [asked], {
            expectedResults: new Map([['/project/queries/a.srj', encoder.encode(expectedFile)]]),
        });
        expect(validation.questions[0]).toMatchObject({ ok: true, reason: 'results match: 1 rows, a.srj' });
    });
});
