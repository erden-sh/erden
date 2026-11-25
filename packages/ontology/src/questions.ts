import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import { TextDecoder } from 'node:util';

import { DataFactory, type Quad, type Term } from 'n3';

import { CompetencyQuestionArtifactError } from './errors.js';
import { scanSparqlQuery } from './local-query/scan.js';
import type {
    AssembledOntology,
    CompetencyQuestionMetadata,
    CompetencyQuestionMetadataDiagnostic,
    CompetencyQuestionResult,
    CompetencyQuestionValidation,
    LoadedCompetencyQuestion,
} from './model.js';
import { compareCodePoints } from './order.js';
import { discardOxigraphAfterTrap, withOxigraph } from './oxigraph-runtime.js';

/** The regime a question answers under: what the files say, or what they imply under Erden's reasoner. */
export type QuestionRegime = 'asserted' | 'entailed';

/** The graphs questions and local queries see; the registry's release query graphs, plus one graph per source. */
export const QUESTION_GRAPHS = Object.freeze({
    declared: 'urn:erden:release-query:v1:graph:declared',
    inferred: 'urn:erden:release-query:v1:graph:inferred',
    sourcePrefix: 'urn:erden:source:',
});

/** The named graph of one source: `urn:erden:source:<source-id>`, the id percent-encoded where an IRI needs it. */
export function sourceGraphIri(sourceId: string): string {
    return `${QUESTION_GRAPHS.sourcePrefix}${encodeURIComponent(sourceId).replaceAll('%3A', ':')}`;
}

export type CompetencyQuestionExpectation =
    | Readonly<{ kind: 'rows'; operator: '==' | '>=' | '<=' | '>' | '<'; count: number }>
    /** Exactly these results: a set, or a sequence when the query orders its solutions. */
    | Readonly<{ kind: 'results'; file: string }>
    /** At least these rows. */
    | Readonly<{ kind: 'contains'; file: string }>;

interface OxigraphTerm {
    readonly termType: 'BlankNode' | 'DefaultGraph' | 'Literal' | 'NamedNode' | 'Quad' | 'Variable';
    readonly value: string;
}

interface OxigraphStoreShape {
    readonly add: (quad: unknown) => void;
    readonly query: (query: string, options?: Readonly<Record<string, unknown>>) => unknown;
}

interface OxigraphModule {
    readonly Store: new () => OxigraphStoreShape;
    readonly fromQuad: (quad: unknown) => unknown;
    readonly namedNode: (value: string) => OxigraphTerm;
}

function metadataValue(text: string, tag: string): string | null {
    const lines = text.split(/\r?\n/u);
    const marker = `# @${tag}`;
    const index = lines.findIndex((line) => line.startsWith(marker));
    if (index < 0) {
        return null;
    }
    let value = (lines[index] ?? '').slice(marker.length).trim();
    for (let next = index + 1; next < lines.length; next += 1) {
        const line = lines[next];
        if (line === undefined || !/^#\s{10,}/u.test(line)) {
            break;
        }
        value += ` ${line.replace(/^#\s+/u, '')}`;
    }
    return value;
}

const ROWS_EXPECTATION = /^rows\s*(==|>=|<=|>|<)\s*(\d+)$/u;
const FILE_EXPECTATION = /^(results|contains)\s+(\S+)$/u;
/** The W3C result formats an expected-results file may use, by extension. */
const RESULT_FORMATS = Object.freeze({ '.srj': 'json', '.json': 'json', '.csv': 'csv', '.tsv': 'tsv' } as const);
export type ExpectedResultsFormat = (typeof RESULT_FORMATS)[keyof typeof RESULT_FORMATS];

/** The format of an expected-results file by its extension, or null when it is not one of `.srj`, `.json`, `.csv`, `.tsv`. */
export function expectedResultsFormat(file: string): ExpectedResultsFormat | null {
    const extension = posix.extname(file).toLowerCase();
    return Object.hasOwn(RESULT_FORMATS, extension) ? RESULT_FORMATS[extension as keyof typeof RESULT_FORMATS] : null;
}

/** A relative path inside the question's own folder or below it; nothing absolute, and no `..`. */
function isContainedPath(file: string): boolean {
    return (
        !file.startsWith('/') &&
        !file.includes('\\') &&
        !/^[A-Za-z]:/u.test(file) &&
        file.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..')
    );
}

/** The expectation of an `# @expect` value, or null when it is not one Erden reads. */
export function parseCompetencyQuestionExpectation(value: string | null): CompetencyQuestionExpectation | null {
    const text = value?.trim() ?? '';
    const rows = ROWS_EXPECTATION.exec(text);
    if (rows !== null) {
        return Object.freeze({
            kind: 'rows',
            operator: rows[1] as '==' | '>=' | '<=' | '>' | '<',
            count: Number(rows[2] ?? '0'),
        });
    }
    const file = FILE_EXPECTATION.exec(text);
    if (file !== null && isContainedPath(file[2] ?? '') && expectedResultsFormat(file[2] ?? '') !== null) {
        return Object.freeze({ kind: file[1] as 'results' | 'contains', file: file[2] ?? '' });
    }
    return null;
}

/** The regime a question asks for: `# @regime asserted|entailed`, entailed when absent. */
export function questionRegime(metadata: CompetencyQuestionMetadata): QuestionRegime {
    return metadata.regime?.trim() === 'asserted' ? 'asserted' : 'entailed';
}

/** Where a question's expected-results file is: beside the question file, as its `# @expect` names it. */
export function expectedResultsLocator(
    question: Pick<LoadedCompetencyQuestion, 'locator' | 'metadata'>,
): string | null {
    const expectation = parseCompetencyQuestionExpectation(question.metadata.expect);
    if (expectation === null || expectation.kind === 'rows') {
        return null;
    }
    const separator = question.locator.includes('\\') && !question.locator.includes('/') ? '\\' : '/';
    const directory = question.locator.slice(0, Math.max(0, question.locator.lastIndexOf(separator)));
    return directory.length === 0
        ? expectation.file
        : `${directory}${separator}${expectation.file.split('/').join(separator)}`;
}

export function parseCompetencyQuestionMetadata(text: string): {
    readonly metadata: CompetencyQuestionMetadata;
    readonly diagnostics: ReadonlyArray<CompetencyQuestionMetadataDiagnostic>;
} {
    const metadata: CompetencyQuestionMetadata = {
        ask: metadataValue(text, 'ask'),
        expect: metadataValue(text, 'expect'),
        from: metadataValue(text, 'from'),
        status: metadataValue(text, 'status'),
        closes: metadataValue(text, 'closes'),
        regime: metadataValue(text, 'regime'),
    };
    const diagnostics: CompetencyQuestionMetadataDiagnostic[] = [];
    if (metadata.ask === null) {
        diagnostics.push({ code: 'missing-ask', message: 'Missing # @ask metadata.' });
    }
    if (metadata.expect === null) {
        diagnostics.push({ code: 'missing-expect', message: 'Missing # @expect metadata.' });
    } else if (parseCompetencyQuestionExpectation(metadata.expect) === null) {
        diagnostics.push({
            code: 'invalid-expectation',
            message: `Unparseable @expect: ${metadata.expect}`,
        });
    }
    if (metadata.from === null) {
        diagnostics.push({ code: 'missing-from', message: 'Missing # @from metadata.' });
    }
    if (/EXPECTED TO FAIL/iu.test(metadata.status ?? '') && metadata.closes === null) {
        diagnostics.push({
            code: 'missing-closes',
            message: 'An expected-to-fail question must name # @closes.',
        });
    }
    if (metadata.regime !== null && metadata.regime !== 'asserted' && metadata.regime !== 'entailed') {
        diagnostics.push({
            code: 'invalid-regime',
            message: `Unknown @regime: ${metadata.regime} (asserted or entailed)`,
        });
    }
    return { metadata, diagnostics };
}

export function renderQuestion(question: LoadedCompetencyQuestion): {
    readonly text: string;
    readonly missing: ReadonlyArray<string>;
} {
    const missing = new Set<string>();
    const text = question.text.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/gu, (_match, rawKey: string) => {
        const replacement = question.placeholders[rawKey];
        if (replacement !== undefined) {
            return replacement;
        }
        missing.add(rawKey);
        return `{{${rawKey}}}`;
    });
    return { text, missing: [...missing].sort(compareCodePoints) };
}

// ---------------------------------------------------------------------------------------------------------------
// Answers and expectations. A question's answer is W3C SPARQL results JSON (SELECT, ASK) or N-Triples (CONSTRUCT,
// DESCRIBE), and, when its expected results are CSV or TSV, that serialization too; Oxigraph writes all of them.

interface JsonTerm {
    readonly type: string;
    readonly value: unknown;
    readonly 'xml:lang'?: string;
    readonly datatype?: string;
}

type JsonResults =
    | Readonly<{ head: Readonly<{ vars?: ReadonlyArray<string> }>; boolean: boolean }>
    | Readonly<{
          head: Readonly<{ vars: ReadonlyArray<string> }>;
          results: Readonly<{ bindings: ReadonlyArray<Readonly<Record<string, JsonTerm>>> }>;
      }>;

/** One question's answer, in each serialization it was asked for. */
export interface QuestionAnswer {
    /** SPARQL 1.1 results JSON, for SELECT and ASK. */
    readonly json?: string;
    /** N-Triples, for CONSTRUCT and DESCRIBE. */
    readonly ntriples?: string;
    readonly csv?: string;
    readonly tsv?: string;
}

export interface QuestionVerdict {
    readonly rows: number;
    readonly ok: boolean;
    readonly reason: string;
    readonly sample: ReadonlyArray<Readonly<Record<string, string>>>;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** A term as the check report's samples show it: the value, then `@language` or `^^datatype`. */
function sampleValue(term: JsonTerm): string {
    const value = typeof term.value === 'string' ? term.value : JSON.stringify(term.value);
    if (term.type !== 'literal') {
        return value;
    }
    const language = term['xml:lang'] ?? '';
    return language.length > 0 ? `${value}@${language}` : `${value}^^${term.datatype ?? XSD_STRING}`;
}

/** A term as a comparison key: blank nodes are equal to each other, literals keep language and datatype. */
function termKey(term: JsonTerm | undefined): string {
    if (term === undefined) {
        return '';
    }
    if (term.type === 'bnode') {
        return '_:';
    }
    if (term.type === 'uri') {
        return `<${String(term.value)}>`;
    }
    if (term.type === 'literal') {
        const language = term['xml:lang'] ?? '';
        const datatype = language.length > 0 ? RDF_LANG_STRING : (term.datatype ?? XSD_STRING);
        return `${JSON.stringify(term.value)}@${language}^^${datatype}`;
    }
    return JSON.stringify(term.value);
}

function jsonRows(results: JsonResults): Readonly<{ vars: ReadonlyArray<string>; rows: ReadonlyArray<string> }> | null {
    if ('boolean' in results) {
        return null;
    }
    const vars = [...results.head.vars].sort(compareCodePoints);
    return {
        vars,
        rows: results.results.bindings.map((binding) =>
            JSON.stringify(vars.map((name) => termKey(Object.hasOwn(binding, name) ? binding[name] : undefined))),
        ),
    };
}

/** RFC 4180 records of a W3C CSV result, or the lines of a TSV one, with blank-node labels made equal. */
function delimitedRows(text: string, format: 'csv' | 'tsv'): ReadonlyArray<string> {
    const records: string[][] = [];
    if (format === 'tsv') {
        for (const line of text.split(/\r?\n/u)) {
            if (line.length > 0) {
                records.push(line.split('\t'));
            }
        }
    } else {
        let record: string[] = [];
        let field = '';
        let quoted = false;
        let any = false;
        for (let index = 0; index < text.length; index += 1) {
            const character = text[index] as string;
            any = true;
            if (quoted) {
                if (character === '"' && text[index + 1] === '"') {
                    field += '"';
                    index += 1;
                } else if (character === '"') {
                    quoted = false;
                } else {
                    field += character;
                }
            } else if (character === '"') {
                quoted = true;
            } else if (character === ',') {
                record.push(field);
                field = '';
            } else if (character === '\n' || character === '\r') {
                if (character === '\r' && text[index + 1] === '\n') {
                    index += 1;
                }
                record.push(field);
                records.push(record);
                record = [];
                field = '';
                any = false;
            } else {
                field += character;
            }
        }
        if (any) {
            record.push(field);
            records.push(record);
        }
    }
    const [header = [], ...body] = records;
    const order = header
        .map((name, index) => [name, index] as const)
        .sort(([left], [right]) => compareCodePoints(left, right));
    const blank = format === 'csv' ? /^_:.*/su : /^_:\S*$/u;
    return [
        JSON.stringify(order.map(([name]) => name)),
        ...body.map((record) => JSON.stringify(order.map(([, index]) => (record[index] ?? '').replace(blank, '_:')))),
    ];
}

function compareRows(
    actual: ReadonlyArray<string>,
    expected: ReadonlyArray<string>,
    mode: 'set' | 'sequence' | 'contains',
): Readonly<{ ok: boolean; missing: number; unexpected: number }> {
    if (mode === 'sequence') {
        const same = actual.length === expected.length && actual.every((row, index) => row === expected[index]);
        if (same) {
            return { ok: true, missing: 0, unexpected: 0 };
        }
    }
    const remaining = new Map<string, number>();
    for (const row of actual) {
        remaining.set(row, (remaining.get(row) ?? 0) + 1);
    }
    let missing = 0;
    for (const row of expected) {
        const count = remaining.get(row) ?? 0;
        if (count === 0) {
            missing += 1;
        } else {
            remaining.set(row, count - 1);
        }
    }
    const unexpected = [...remaining.values()].reduce((total, count) => total + count, 0);
    if (mode === 'contains') {
        return { ok: missing === 0, missing, unexpected: 0 };
    }
    return { ok: mode === 'set' ? missing === 0 && unexpected === 0 : false, missing, unexpected };
}

function sampleOf(results: JsonResults | null): ReadonlyArray<Readonly<Record<string, string>>> {
    if (results === null || 'boolean' in results) {
        return [];
    }
    return results.results.bindings
        .slice(0, 4)
        .map((binding) =>
            Object.freeze(
                Object.fromEntries(
                    Object.entries(binding)
                        .sort(([left], [right]) => compareCodePoints(left, right))
                        .map(([name, term]) => [name, sampleValue(term)]),
                ),
            ),
        )
        .sort((left, right) => compareCodePoints(JSON.stringify(left), JSON.stringify(right)));
}

function rowExpectation(
    expectation: Extract<CompetencyQuestionExpectation, { kind: 'rows' }>,
    rows: number,
): Readonly<{ ok: boolean; reason: string }> {
    const { operator, count } = expectation;
    const ok =
        operator === '=='
            ? rows === count
            : operator === '>='
              ? rows >= count
              : operator === '<='
                ? rows <= count
                : operator === '>'
                  ? rows > count
                  : rows < count;
    return { ok, reason: `${String(rows)} rows, expected ${operator} ${String(count)}` };
}

/**
 * Judges one answer against a question's expectation. `expected` is the expected-results file's bytes, when the
 * expectation names one; `ordered` says whether the query orders its solutions, so its results are a sequence.
 */
export function judgeQuestionAnswer(
    expectationText: string | null,
    answer: QuestionAnswer,
    expected: Uint8Array | null,
    ordered: boolean,
): QuestionVerdict {
    const results = answer.json === undefined ? null : (JSON.parse(answer.json) as JsonResults);
    const rows =
        results === null
            ? (answer.ntriples ?? '').split('\n').filter((line) => line.length > 0).length
            : 'boolean' in results
              ? results.boolean
                  ? 1
                  : 0
              : results.results.bindings.length;
    const sample = sampleOf(results);
    const expectation = parseCompetencyQuestionExpectation(expectationText);
    if (expectation === null) {
        return { rows, ok: false, reason: `unparseable @expect: ${expectationText ?? '<missing>'}`, sample };
    }
    if (expectation.kind === 'rows') {
        return { rows, sample, ...rowExpectation(expectation, rows) };
    }
    if (expected === null) {
        return { rows, ok: false, reason: `expected results file ${expectation.file} could not be read`, sample };
    }
    let expectedText: string;
    try {
        expectedText = new TextDecoder('utf-8', { fatal: true }).decode(expected);
    } catch {
        return { rows, ok: false, reason: `expected results file ${expectation.file} is not UTF-8`, sample };
    }
    const format = expectedResultsFormat(expectation.file);
    const mode = expectation.kind === 'contains' ? 'contains' : ordered ? 'sequence' : 'set';
    let actualRows: ReadonlyArray<string>;
    let expectedRows: ReadonlyArray<string>;
    try {
        if (format === 'json') {
            const parsed = JSON.parse(expectedText) as JsonResults;
            if (results === null) {
                return {
                    rows,
                    ok: false,
                    reason: 'a CONSTRUCT or DESCRIBE answer has no SPARQL results to compare',
                    sample,
                };
            }
            if ('boolean' in parsed || 'boolean' in results) {
                const ok = 'boolean' in parsed && 'boolean' in results && parsed.boolean === results.boolean;
                return {
                    rows,
                    ok,
                    reason: ok ? 'results match' : 'results differ: the boolean answer differs',
                    sample,
                };
            }
            const actualTable = jsonRows(results);
            const expectedTable = jsonRows(parsed);
            if (actualTable === null || expectedTable === null) {
                throw new TypeError('malformed results');
            }
            actualRows = [JSON.stringify(actualTable.vars), ...actualTable.rows];
            expectedRows = [JSON.stringify(expectedTable.vars), ...expectedTable.rows];
        } else {
            const actualText = format === 'csv' ? answer.csv : answer.tsv;
            if (actualText === undefined || format === null) {
                return { rows, ok: false, reason: `no ${String(format)} answer to compare`, sample };
            }
            actualRows = delimitedRows(actualText, format);
            expectedRows = delimitedRows(expectedText, format);
        }
    } catch {
        return {
            rows,
            ok: false,
            reason: `expected results file ${expectation.file} is not valid W3C results`,
            sample,
        };
    }
    if (actualRows[0] !== expectedRows[0]) {
        return { rows, ok: false, reason: 'results differ: the variables differ', sample };
    }
    const compared = compareRows(actualRows.slice(1), expectedRows.slice(1), mode);
    const noun = expectation.kind === 'contains' ? 'contains' : 'results';
    if (compared.ok) {
        return { rows, ok: true, reason: `${noun} match: ${String(rows)} rows, ${expectation.file}`, sample };
    }
    const detail =
        compared.missing === 0 && compared.unexpected === 0
            ? 'the order differs'
            : `${String(compared.missing)} expected rows missing, ${String(compared.unexpected)} unexpected`;
    return { rows, ok: false, reason: `${noun} differ from ${expectation.file}: ${detail}`, sample };
}

/** Which serializations a question needs: JSON or N-Triples by its form, plus CSV or TSV for such an expectation. */
export function questionAnswerFormats(
    text: string,
    expectationText: string | null,
): ReadonlyArray<'json' | 'ntriples' | 'csv' | 'tsv'> {
    const form = scanSparqlQuery(text).form;
    const primary = form === 'construct' || form === 'describe' ? 'ntriples' : 'json';
    const expectation = parseCompetencyQuestionExpectation(expectationText);
    const extra = expectation === null || expectation.kind === 'rows' ? null : expectedResultsFormat(expectation.file);
    return extra === 'csv' || extra === 'tsv' ? [primary, extra] : [primary];
}

/**
 * Assembled blank-node labels carry the source prefix and a `/` (`source/anonymous/1`), which Oxigraph rejects as a
 * blank-node identifier. At the Oxigraph boundary only, each label becomes `b` plus the hex SHA-256 of the assembled
 * label: valid, deterministic, and stable across runs. Assembly, provenance, digests, and reasoner input keep the
 * assembled labels; a question can bind a blank node but never name one, so results do not depend on the spelling.
 */
function oxigraphBlankNodeLabel(label: string): string {
    return `b${createHash('sha256').update(label, 'utf8').digest('hex')}`;
}

function oxigraphTerm<T extends Term>(term: T): T {
    return (term.termType === 'BlankNode' ? DataFactory.blankNode(oxigraphBlankNodeLabel(term.value)) : term) as T;
}

/** A quad as Oxigraph receives it: assembled blank-node labels made valid, deterministic identifiers. */
export function oxigraphQuad(quad: Quad): Quad {
    if (quad.subject.termType !== 'BlankNode' && quad.object.termType !== 'BlankNode') {
        return quad;
    }
    return DataFactory.quad(oxigraphTerm(quad.subject), quad.predicate, oxigraphTerm(quad.object), quad.graph);
}

/**
 * The statements of a graph by where questions see them: asserted ones in the declared graph and in the graph of
 * each source that asserts them, inferred ones (not also asserted) in the inferred graph.
 */
export function questionGraphQuads(graph: AssembledOntology): Readonly<{
    declared: ReadonlyArray<Quad>;
    inferred: ReadonlyArray<Quad>;
    bySource: ReadonlyMap<string, ReadonlyArray<Quad>>;
}> {
    const declared: Quad[] = [];
    const inferred: Quad[] = [];
    const bySource = new Map<string, Quad[]>();
    for (const entry of graph.provenance) {
        if (entry.asserted.length === 0) {
            inferred.push(entry.quad);
            continue;
        }
        declared.push(entry.quad);
        for (const contributor of entry.asserted) {
            let quads = bySource.get(contributor.sourceId);
            if (quads === undefined) {
                quads = [];
                bySource.set(contributor.sourceId, quads);
            }
            quads.push(entry.quad);
        }
    }
    return { declared, inferred, bySource };
}

export interface CompetencyQuestionRunOptions {
    /**
     * Set when reasoning did not complete: every question answers over the asserted statements, as advisory, and
     * one that asks for the entailed regime says it did not get it, naming this cause.
     */
    readonly entailmentUnavailable?: string;
    /** The bytes of an expected-results file by its locator, read before the questions run; null when unreadable. */
    readonly expectedResults?: ReadonlyMap<string, Uint8Array | null>;
}

function isText(value: unknown): value is string {
    return typeof value === 'string';
}

export function runCompetencyQuestions(
    graph: AssembledOntology,
    questions: ReadonlyArray<LoadedCompetencyQuestion>,
    options: CompetencyQuestionRunOptions = {},
): CompetencyQuestionValidation {
    const boundQuestions = questions.map((question): LoadedCompetencyQuestion => {
        try {
            const digest = `sha256:${createHash('sha256').update(question.bytes).digest('hex')}`;
            const text = new TextDecoder('utf-8', { fatal: true }).decode(question.bytes);
            if (digest !== question.contentDigest || text !== question.text) {
                throw new Error('content digest or decoded text mismatch');
            }
            const parsed = parseCompetencyQuestionMetadata(text);
            return {
                ...question,
                text,
                metadata: parsed.metadata,
                diagnostics: parsed.diagnostics,
            };
        } catch (cause) {
            throw new CompetencyQuestionArtifactError(question.id, cause, question.locator);
        }
    });
    const quads = questionGraphQuads(graph);
    const sourceGraphs = [...quads.bySource.keys()].sort(compareCodePoints).map(sourceGraphIri);
    let queryStore: OxigraphStoreShape;
    let namedNode: OxigraphModule['namedNode'];
    try {
        ({ queryStore, namedNode } = withOxigraph((module) => {
            const oxigraph = module as OxigraphModule;
            const store = new oxigraph.Store();
            function add(quad: Quad, graphIri: string): void {
                const relabeled = oxigraphQuad(quad);
                store.add(
                    oxigraph.fromQuad(
                        DataFactory.quad(
                            relabeled.subject,
                            relabeled.predicate,
                            relabeled.object,
                            DataFactory.namedNode(graphIri),
                        ),
                    ),
                );
            }
            for (const quad of quads.declared) {
                add(quad, QUESTION_GRAPHS.declared);
            }
            for (const quad of quads.inferred) {
                add(quad, QUESTION_GRAPHS.inferred);
            }
            for (const [sourceId, sourceQuads] of quads.bySource) {
                const iri = sourceGraphIri(sourceId);
                for (const quad of sourceQuads) {
                    add(quad, iri);
                }
            }
            return { queryStore: store, namedNode: oxigraph.namedNode };
        }));
    } catch (cause) {
        throw new CompetencyQuestionArtifactError(
            'store',
            cause,
            boundQuestions.find((question) => question.owner.role === 'root')?.locator,
        );
    }
    const entailed = options.entailmentUnavailable === undefined;
    const results: CompetencyQuestionResult[] = boundQuestions.map((question) => {
        const expectedToFail = /EXPECTED TO FAIL/iu.test(question.metadata.status ?? '');
        const asked = questionRegime(question.metadata);
        const regime: QuestionRegime = asked === 'entailed' && entailed ? 'entailed' : 'asserted';
        const labels = {
            ...(regime === 'asserted' ? { regime } : {}),
            ...(asked === 'entailed' && options.entailmentUnavailable !== undefined
                ? { entailmentUnavailable: options.entailmentUnavailable }
                : {}),
        };
        if (question.owner.role === 'dependency') {
            return {
                id: question.id,
                owner: question.owner,
                locator: question.locator,
                execution: 'dormant-dependency',
                metadata: question.metadata,
                metadataDiagnostics: question.diagnostics,
                rows: null,
                ok: null,
                expectedToFail,
                blocking: false,
                reason: 'dependency competency questions are loaded but execute only when their project is root',
                sample: [],
            };
        }
        const rendered = renderQuestion(question);
        if (rendered.missing.length > 0) {
            return {
                id: question.id,
                owner: question.owner,
                locator: question.locator,
                execution: 'executed',
                metadata: question.metadata,
                metadataDiagnostics: question.diagnostics,
                rows: null,
                ok: false,
                expectedToFail,
                blocking: true,
                reason: `unknown placeholder(s): ${rendered.missing.map((key) => `{{${key}}}`).join(', ')}`,
                sample: [],
                ...labels,
            };
        }
        const graphs =
            regime === 'entailed' ? [QUESTION_GRAPHS.declared, QUESTION_GRAPHS.inferred] : [QUESTION_GRAPHS.declared];
        const named = [...graphs, ...sourceGraphs];
        let verdict: Readonly<{ rows: number | null; ok: boolean; reason: string; sample: QuestionVerdict['sample'] }>;
        try {
            const answer: { json?: string; ntriples?: string; csv?: string; tsv?: string } = {};
            for (const format of questionAnswerFormats(rendered.text, question.metadata.expect)) {
                const text = queryStore.query(rendered.text, {
                    results_format:
                        format === 'json'
                            ? 'application/sparql-results+json'
                            : format === 'ntriples'
                              ? 'application/n-triples'
                              : format === 'csv'
                                ? 'text/csv'
                                : 'text/tab-separated-values',
                    default_graph: graphs.map((iri) => namedNode(iri)),
                    named_graphs: named.map((iri) => namedNode(iri)),
                });
                if (!isText(text)) {
                    throw new Error('query returned no serialized result');
                }
                answer[format] = text;
            }
            const locator = expectedResultsLocator(question);
            verdict = judgeQuestionAnswer(
                question.metadata.expect,
                answer,
                locator === null ? null : (options.expectedResults?.get(locator) ?? null),
                scanSparqlQuery(rendered.text).ordered,
            );
        } catch (cause) {
            // A trapped query leaves the store's instance broken; later checks get a fresh one.
            discardOxigraphAfterTrap(cause);
            verdict = {
                rows: 0,
                ok: false,
                reason: `query error: ${cause instanceof Error ? cause.message : String(cause)}`,
                sample: [],
            };
        }
        const metadataBlocks = question.diagnostics.length > 0;
        const expectedFailureIsDocumented =
            expectedToFail && !verdict.ok && question.metadata.closes !== null && !metadataBlocks;
        const blocking = metadataBlocks || (!verdict.ok && !expectedFailureIsDocumented);
        return {
            id: question.id,
            owner: question.owner,
            locator: question.locator,
            execution: 'executed',
            metadata: question.metadata,
            metadataDiagnostics: question.diagnostics,
            rows: verdict.rows,
            ok: verdict.ok,
            expectedToFail,
            blocking,
            reason: verdict.reason,
            sample: verdict.sample,
            ...labels,
        };
    });
    return {
        conforms: results.every((result) => !result.blocking),
        questions: results,
        executed: results.filter((result) => result.execution === 'executed').length,
        dormant: results.filter((result) => result.execution === 'dormant-dependency').length,
    };
}
