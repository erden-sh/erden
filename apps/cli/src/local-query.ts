import { createHash } from 'node:crypto';
import { relative, resolve } from 'node:path';

import { Effect } from 'effect';

import { CheckProjectOperationalError, isReleaseQueryError, parseReleaseQuery } from '@erden/contracts';
import {
    expectedResultsLocator,
    judgeQuestionAnswer,
    questionAnswerFormats,
    questionRegime,
    renderQuestion,
    scanSparqlQuery,
    type LocalQueryEngineBatch,
    type LocalQueryEngineFormat,
    type LocalQueryEngineInput,
    type LocalQueryEngineResult,
    type SparqlScan,
} from '@erden/project';
import type {
    LocalQueryCompletenessReason,
    LocalQueryRegime,
    PreparedProjectQuery,
    QueryProjectOptions,
    QueryProjectServiceShape,
    ReasonerLimits,
} from '@erden/project';

import { CliRegistryUsageError, terminalText, type CliRegistryTextSink } from './registry.js';

/** The exit codes of a local query; 4 is a labeled partial answer (see docs/query.md). */
export const LOCAL_QUERY_EXIT = Object.freeze({ answered: 0, refused: 1, operational: 3, partial: 4 } as const);

/** Local query text may be much longer than the registry's 8 KiB: it runs on the user's own machine. */
export const MAXIMUM_LOCAL_QUERY_BYTES = 1_048_576;
/** The default wall-time budget for loading the dataset and running the query, in seconds. */
export const DEFAULT_LOCAL_QUERY_TIMEOUT_SECONDS = 60;

export const SIMPLE_ENTAILMENT = 'http://www.w3.org/ns/entailment/Simple';
export const OWL_DIRECT_ENTAILMENT = 'http://www.w3.org/ns/entailment/OWL-Direct';
export const ERDEN_PROFILE_NAMESPACE = 'https://erden.sh/ns/profile/';

export interface CliLocalQueryRuntime {
    readonly project: QueryProjectServiceShape;
    readonly run: (input: LocalQueryEngineInput, signal?: AbortSignal) => Promise<LocalQueryEngineResult>;
    readonly runBatch: (
        batch: LocalQueryEngineBatch,
        signal?: AbortSignal,
    ) => Promise<ReadonlyArray<LocalQueryEngineResult>>;
    readonly readFile: (path: string, maximum: number) => Promise<Uint8Array>;
    readonly readStdin: (maximum: number) => Promise<Uint8Array>;
    readonly reasonerLimits: () => ReasonerLimits | undefined;
}

export type LocalQueryOutput = 'table' | 'json' | 'sparql-json' | 'csv' | 'tsv';

export interface LocalQueryArguments {
    readonly project: string | undefined;
    readonly config: string | undefined;
    readonly source:
        | Readonly<{ kind: 'file'; path: string }>
        | Readonly<{ kind: 'stdin' }>
        | Readonly<{ kind: 'questions'; selection: ReadonlyArray<string> }>;
    readonly regime: LocalQueryRegime | undefined;
    readonly output: LocalQueryOutput;
    readonly timeoutSeconds: number;
    readonly allowIncomplete: boolean;
    readonly registryCompatible: boolean;
}

const OUTPUT_FLAGS: Readonly<Record<string, LocalQueryOutput>> = Object.freeze({
    '--json': 'json',
    '--sparql-json': 'sparql-json',
    '--csv': 'csv',
    '--tsv': 'tsv',
});
const VALUE_FLAGS = new Set(['--file', '--config', '--regime', '--timeout']);
const SWITCHES = new Set([
    '--stdin',
    '--offline',
    '--allow-incomplete',
    '--registry-compatible',
    '--questions',
    ...Object.keys(OUTPUT_FLAGS),
]);

export function parseLocalQueryArguments(arguments_: ReadonlyArray<string>): LocalQueryArguments {
    const positional: string[] = [];
    const selection: string[] = [];
    const values = new Map<string, string>();
    const seen = new Set<string>();
    let selecting = false;
    for (let index = 0; index < arguments_.length; index += 1) {
        const argument = arguments_[index] as string;
        if (selecting && !argument.startsWith('-')) {
            selection.push(argument);
            continue;
        }
        selecting = argument === '--questions';
        if (VALUE_FLAGS.has(argument) || SWITCHES.has(argument)) {
            if (seen.has(argument)) {
                throw new CliRegistryUsageError(`${argument} may be specified only once`);
            }
            seen.add(argument);
        }
        if (VALUE_FLAGS.has(argument)) {
            const value = arguments_[index + 1];
            if (value === undefined || value.startsWith('-')) {
                throw new CliRegistryUsageError(`${argument} requires a value`);
            }
            values.set(argument, value);
            index += 1;
        } else if (argument === '--registry') {
            throw new CliRegistryUsageError(
                '--registry applies only to a query of a registry release (<identifier>@<version>)',
            );
        } else if (argument.startsWith('-') && !SWITCHES.has(argument)) {
            throw new CliRegistryUsageError(`unknown query flag: ${argument}`);
        } else if (!argument.startsWith('-')) {
            positional.push(argument);
        }
    }
    if (positional.length > 1) {
        throw new CliRegistryUsageError('query accepts at most one project directory');
    }
    if (values.has('--config') && positional.length !== 0) {
        throw new CliRegistryUsageError('query cannot combine a project directory with --config');
    }
    const file = values.get('--file');
    const sources = [file !== undefined, seen.has('--stdin'), seen.has('--questions')].filter(Boolean).length;
    if (sources !== 1) {
        throw new CliRegistryUsageError('query requires exactly one of --file <path>, --stdin or --questions');
    }
    const outputs = Object.keys(OUTPUT_FLAGS).filter((flag) => seen.has(flag));
    if (outputs.length > 1) {
        throw new CliRegistryUsageError(`${outputs.join(' and ')} cannot be combined`);
    }
    if (seen.has('--questions') && outputs.some((flag) => flag !== '--json')) {
        throw new CliRegistryUsageError('--questions prints a table, or --json');
    }
    if (seen.has('--questions') && seen.has('--registry-compatible')) {
        throw new CliRegistryUsageError('--registry-compatible checks one query (--file or --stdin), not --questions');
    }
    const regime = values.get('--regime');
    if (regime !== undefined && regime !== 'asserted' && regime !== 'entailed') {
        throw new CliRegistryUsageError('--regime must be asserted or entailed');
    }
    const timeout = values.get('--timeout');
    const timeoutSeconds = timeout === undefined ? DEFAULT_LOCAL_QUERY_TIMEOUT_SECONDS : Number(timeout);
    if (!/^[1-9][0-9]{0,5}$/u.test(timeout ?? '60')) {
        throw new CliRegistryUsageError('--timeout must be a whole number of seconds, from 1 to 999999');
    }
    return Object.freeze({
        project: positional[0],
        config: values.get('--config'),
        source: seen.has('--questions')
            ? { kind: 'questions' as const, selection: Object.freeze(selection) }
            : file === undefined
              ? { kind: 'stdin' as const }
              : { kind: 'file' as const, path: file },
        regime,
        output: outputs.length === 0 ? 'table' : (OUTPUT_FLAGS[outputs[0] as string] as LocalQueryOutput),
        timeoutSeconds,
        allowIncomplete: seen.has('--allow-incomplete'),
        registryCompatible: seen.has('--registry-compatible'),
    });
}

/** Why the registry's query language would refuse this text, or null when it accepts it. */
export function registryRefusal(text: string): string | null {
    try {
        parseReleaseQuery(text);
        return null;
    } catch (cause) {
        if (isReleaseQueryError(cause)) {
            return cause.reason ?? 'syntax';
        }
        return 'syntax';
    }
}

/** The W3C regime label of a prepared dataset: SPARQL 1.1 Entailment Regimes and Service Description terms. */
export function regimeLabel(prepared: PreparedProjectQuery) {
    if (prepared.entailment === null) {
        return Object.freeze({ entailmentRegime: SIMPLE_ENTAILMENT });
    }
    return Object.freeze({
        entailmentRegime: OWL_DIRECT_ENTAILMENT,
        supportedEntailmentProfile: `${ERDEN_PROFILE_NAMESPACE}${prepared.entailment.profile.id}`,
        reasoner: prepared.entailment.reasoner,
        inputDigest: prepared.entailment.inputDigest,
        certificateDigest: prepared.entailment.certificateDigest,
        method: 'materialized' as const,
        cached: prepared.entailment.cached,
    });
}

export function completenessLabel(prepared: PreparedProjectQuery) {
    return Object.freeze({ complete: prepared.reasons.length === 0, reasons: prepared.reasons });
}

export function regimeText(prepared: PreparedProjectQuery): string {
    const entailment = prepared.entailment;
    return entailment === null
        ? 'asserted (simple entailment: what the files say)'
        : `entailed (OWL 2 Direct Semantics, profile ${terminalText(entailment.profile.id)}, ${terminalText(entailment.reasoner.name)} ${terminalText(entailment.reasoner.version)}${entailment.cached ? ', cached inferences' : ''})`;
}

export function reasonText(reason: LocalQueryCompletenessReason): ReadonlyArray<string> {
    switch (reason.code) {
        case 'sources-unparsed':
            return [
                `sources-unparsed: ${String(reason.sources.length)} ${reason.sources.length === 1 ? 'source' : 'sources'} left out`,
                ...reason.sources.map(
                    (source) =>
                        `  ${terminalText(source.file)}${source.line === null ? '' : `:${String(source.line)}${source.column === null ? '' : `:${String(source.column)}`}`} [${terminalText(source.code)}] ${terminalText(source.message)}`,
                ),
            ];
        case 'dependencies-missing':
            return [`dependencies-missing: the project's own sources only [${terminalText(reason.cause)}]`];
        case 'entailment-unavailable':
            return [`entailment-unavailable: asserted answers only [${terminalText(reason.cause)}]`];
        case 'statements-outside-profile':
            return [
                `statements-outside-profile: ${String(reason.count)} statements were not reasoned over (outsideProfile: report)`,
            ];
    }
}

/** The lines that close every human-readable answer: the regime, and whether the answer is complete. */
export function labelLines(prepared: PreparedProjectQuery): string {
    const lines = [`Regime: ${regimeText(prepared)}`];
    if (prepared.reasons.length === 0) {
        lines.push('Complete');
    } else {
        lines.push('Partial answer:');
        for (const reason of prepared.reasons) {
            lines.push(...reasonText(reason).map((line) => `  ${line}`));
        }
    }
    return `${lines.join('\n')}\n`;
}

export function renderQueryError(error: CheckProjectOperationalError): string {
    const lines = [
        `Erden query could not complete [${error.stage}/${terminalText(error.code)}]: ${terminalText(error.message)}`,
    ];
    for (const diagnostic of error.diagnostics) {
        const location =
            diagnostic.file === null
                ? ''
                : `${terminalText(diagnostic.file)}${diagnostic.line === null ? '' : `:${String(diagnostic.line)}:${String(diagnostic.column ?? 1)}`} `;
        lines.push(`- ${location}[${terminalText(diagnostic.code)}] ${terminalText(diagnostic.message)}`);
    }
    return `${lines.join('\n')}\n`;
}

interface SparqlJsonTerm {
    readonly type: 'uri' | 'bnode' | 'literal' | 'triple';
    readonly value: unknown;
    readonly 'xml:lang'?: string;
    readonly datatype?: string;
}

type SparqlJson =
    | Readonly<{ head: Readonly<{ vars?: ReadonlyArray<string> }>; boolean: boolean }>
    | Readonly<{
          head: Readonly<{ vars: ReadonlyArray<string> }>;
          results: Readonly<{ bindings: ReadonlyArray<Readonly<Record<string, SparqlJsonTerm>>> }>;
      }>;

function termText(term: SparqlJsonTerm | undefined): string {
    if (term === undefined) {
        return '';
    }
    if (term.type === 'uri') {
        return `<${String(term.value)}>`;
    }
    if (term.type === 'bnode') {
        return `_:${String(term.value)}`;
    }
    if (term.type === 'triple') {
        return `<< ${JSON.stringify(term.value)} >>`;
    }
    const lexical = JSON.stringify(String(term.value));
    return term['xml:lang'] !== undefined
        ? `${lexical}@${term['xml:lang']}`
        : term.datatype !== undefined
          ? `${lexical}^^<${term.datatype}>`
          : lexical;
}

function displayWidth(text: string): number {
    return Array.from(new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(text)).length;
}

/** The answer as a table, one row per solution, then the row count. */
export function renderSparqlTable(result: SparqlJson): string {
    if ('boolean' in result) {
        return `${String(result.boolean)}\n`;
    }
    const columns = result.head.vars;
    const rows = result.results.bindings.map((binding) =>
        columns.map((name) => terminalText(termText(Object.hasOwn(binding, name) ? binding[name] : undefined))),
    );
    const header = columns.map((name) => `?${name}`);
    const widths = header.map((name, column) =>
        Math.max(displayWidth(name), ...rows.map((row) => displayWidth(row[column] ?? ''))),
    );
    function line(cells: ReadonlyArray<string>): string {
        return cells
            .map((cell, column) => cell.padEnd(widths[column] ?? 0))
            .join(' | ')
            .trimEnd();
    }
    const table = columns.length === 0 ? '' : `${[line(header), ...rows.map(line)].join('\n')}\n`;
    const count = result.results.bindings.length;
    return `${table}${String(count)} ${count === 1 ? 'row' : 'rows'}\n`;
}

/** C1, bidirectional and line-separator controls inside JSON strings, escaped so a terminal never acts on them. */
export function terminalSafeJson(text: string): string {
    return text.replace(
        /[\u007f-\u009f\u061c\u200e\u200f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu,
        (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, '0')}`,
    );
}

/** The engine format for an output and a query form; null when the output cannot hold that form's answer. */
function engineFormat(output: LocalQueryOutput, form: SparqlScan['form']): LocalQueryEngineFormat | null {
    const graph = form === 'construct' || form === 'describe';
    if (graph) {
        return output === 'table' || output === 'json' ? 'ntriples' : null;
    }
    return output === 'csv' ? 'csv' : output === 'tsv' ? 'tsv' : 'json';
}

export interface LocalQueryRunContext {
    readonly cwd: () => string;
    readonly stdout: CliRegistryTextSink;
    readonly stderr: CliRegistryTextSink;
}

function refuse(context: LocalQueryRunContext, code: string, detail: string | null): number {
    context.stderr.write(`Erden query refused [${code}${detail === null ? '' : `: ${terminalText(detail)}`}]\n`);
    return LOCAL_QUERY_EXIT.refused;
}

function exitFor(prepared: PreparedProjectQuery, options: LocalQueryArguments): number {
    return prepared.reasons.length === 0 || options.allowIncomplete
        ? LOCAL_QUERY_EXIT.answered
        : LOCAL_QUERY_EXIT.partial;
}

export async function prepareLocalQuery(
    runtime: CliLocalQueryRuntime,
    options: Pick<LocalQueryArguments, 'project' | 'config' | 'regime'>,
    cwd: string,
    questions?: QueryProjectOptions['questions'],
): Promise<PreparedProjectQuery> {
    const limits = runtime.reasonerLimits();
    const request: QueryProjectOptions = {
        ...(questions === undefined ? {} : { questions }),
        from: options.project === undefined ? cwd : resolve(cwd, options.project),
        ...(options.config === undefined ? {} : { manifestPath: resolve(cwd, options.config) }),
        ...(options.regime === undefined ? {} : { regime: options.regime }),
        ...(limits === undefined ? {} : { reasonerLimits: limits }),
    };
    return await Effect.runPromise(runtime.project.prepare(request));
}

/** `erden query [project-dir]`: full SPARQL 1.1 over the local project, its answers labeled with regime and completeness. */
export async function runLocalQueryCommand(
    options: LocalQueryArguments,
    context: LocalQueryRunContext,
    runtime: CliLocalQueryRuntime,
): Promise<number> {
    const cwd = context.cwd();
    if (options.source.kind === 'questions') {
        return await runLocalQuestionsCommand(options, options.source.selection, context, runtime);
    }
    let bytes: Uint8Array;
    try {
        bytes =
            options.source.kind === 'file'
                ? await runtime.readFile(resolve(cwd, options.source.path), MAXIMUM_LOCAL_QUERY_BYTES)
                : await runtime.readStdin(MAXIMUM_LOCAL_QUERY_BYTES);
    } catch {
        context.stderr.write('Erden query could not complete [CLI_QUERY_FILE_INVALID]\n');
        return LOCAL_QUERY_EXIT.operational;
    }
    if (bytes.byteLength > MAXIMUM_LOCAL_QUERY_BYTES) {
        return refuse(context, 'LOCAL_QUERY_TOO_LARGE', `more than ${String(MAXIMUM_LOCAL_QUERY_BYTES)} bytes`);
    }
    if (bytes.byteLength === 0) {
        throw new CliRegistryUsageError('query text is empty');
    }
    let text: string;
    try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
        return refuse(context, 'LOCAL_QUERY_INVALID', 'the query is not UTF-8');
    }
    const scan = scanSparqlQuery(text);
    if (scan.form === 'update') {
        return refuse(context, 'LOCAL_QUERY_UPDATE_FORBIDDEN', 'local query runs queries, not SPARQL Update');
    }
    if (scan.service) {
        return refuse(context, 'LOCAL_QUERY_SERVICE_FORBIDDEN', 'local query never reaches the network (SERVICE)');
    }
    const format = engineFormat(options.output, scan.form);
    if (format === null) {
        return refuse(
            context,
            'LOCAL_QUERY_FORMAT_UNSUITED',
            `--${options.output} holds SELECT and ASK answers; CONSTRUCT and DESCRIBE print N-Triples or --json`,
        );
    }
    const refusal = registryRefusal(text);
    if (refusal !== null) {
        if (options.registryCompatible) {
            return refuse(context, 'RELEASE_QUERY_REJECTED', refusal);
        }
        context.stderr.write(
            `Warning: the registry's query language refuses this query (${terminalText(refusal)}), so it runs only locally, not on a published release.\n`,
        );
    }
    let prepared: PreparedProjectQuery;
    try {
        prepared = await prepareLocalQuery(runtime, options, cwd);
    } catch (cause) {
        const error =
            cause instanceof CheckProjectOperationalError
                ? cause
                : new CheckProjectOperationalError(
                      'CHECK_OPERATION_FAILED',
                      'validation',
                      'The project could not be read',
                  );
        context.stderr.write(renderQueryError(error));
        return LOCAL_QUERY_EXIT.operational;
    }
    if (prepared.entailedUnavailable) {
        context.stderr.write(
            `Erden query has no entailed answer: ${prepared.reasons
                .filter((reason) => reason.code === 'entailment-unavailable')
                .flatMap(reasonText)
                .join('; ')}\n${labelLines(prepared)}`,
        );
        return LOCAL_QUERY_EXIT.partial;
    }
    const answer = await runtime.run({
        nquads: prepared.dataset.nquads,
        defaultGraph: prepared.dataset.defaultGraph,
        namedGraphs: prepared.dataset.namedGraphs,
        query: text,
        format,
        milliseconds: options.timeoutSeconds * 1000,
    });
    if (answer.outcome === 'query-error') {
        return refuse(context, 'LOCAL_QUERY_INVALID', answer.message);
    }
    if (answer.outcome === 'time-limit') {
        context.stderr.write(
            `Erden query could not complete [CLI_QUERY_TIMEOUT]: no answer within ${String(options.timeoutSeconds)} s (--timeout)\n`,
        );
        return LOCAL_QUERY_EXIT.operational;
    }
    if (answer.outcome === 'unavailable') {
        context.stderr.write(
            `Erden query could not complete [LOCAL_QUERY_ENGINE_UNAVAILABLE]: ${terminalText(answer.message)}\n`,
        );
        return LOCAL_QUERY_EXIT.operational;
    }
    const exit = exitFor(prepared, options);
    if (options.output === 'json') {
        const result = format === 'ntriples' ? { ntriples: answer.text } : (JSON.parse(answer.text) as unknown);
        context.stdout.write(
            `${terminalSafeJson(
                JSON.stringify(
                    {
                        schema: 'erden.local-query-result/v1',
                        project: { canonicalIri: prepared.canonicalIri, manifest: prepared.manifestFile },
                        query: {
                            form: scan.form,
                            sha256: createHash('sha256').update(bytes).digest('hex'),
                        },
                        regime: regimeLabel(prepared),
                        completeness: completenessLabel(prepared),
                        dataset: { quadCounts: prepared.dataset.quadCounts },
                        warnings: refusal === null ? [] : [{ code: 'registry-refuses', reason: refusal }],
                        result,
                    },
                    null,
                    2,
                ),
            )}\n`,
        );
        return exit;
    }
    if (options.output === 'table' && format === 'json') {
        context.stdout.write(`${renderSparqlTable(JSON.parse(answer.text) as SparqlJson)}${labelLines(prepared)}`);
        return exit;
    }
    // Machine formats keep standard output a pure W3C document; the labels go to standard error.
    context.stdout.write(options.output === 'sparql-json' ? terminalSafeJson(answer.text) : answer.text);
    if (options.output === 'sparql-json' && !answer.text.endsWith('\n')) {
        context.stdout.write('\n');
    }
    context.stderr.write(labelLines(prepared));
    return exit;
}

/** One question's line in `erden query --questions`. */
export interface LocalQuestionResult {
    readonly id: string;
    readonly file: string;
    readonly ask: string | null;
    readonly expect: string | null;
    readonly regime: LocalQueryRegime;
    readonly rows: number | null;
    readonly ok: boolean;
    readonly blocking: boolean;
    readonly expectedToFail: boolean;
    readonly reason: string;
    readonly completeness: Readonly<{ complete: boolean; reasons: ReadonlyArray<LocalQueryCompletenessReason> }>;
}

const QUESTION_GRAPH_DECLARED = 'urn:erden:release-query:v1:graph:declared';
const QUESTION_GRAPH_INFERRED = 'urn:erden:release-query:v1:graph:inferred';
const MAXIMUM_EXPECTED_RESULTS_BYTES = 64 * 1_048_576;

/** The question selection as `prepare` takes it: ids as given, file paths made absolute. */
function questionSelection(selection: ReadonlyArray<string>, cwd: string): QueryProjectOptions['questions'] {
    if (selection.length === 0) {
        return 'all';
    }
    return selection.map((item) => ({ name: item, path: resolve(cwd, item) }));
}

/**
 * `erden query [project-dir] --questions [<id-or-path>…]`: the project's competency questions, or a subset, without
 * the rest of the check, each judged against its expectation and labeled with its regime and completeness.
 */
export async function runLocalQuestionsCommand(
    options: LocalQueryArguments,
    selection: ReadonlyArray<string>,
    context: LocalQueryRunContext,
    runtime: CliLocalQueryRuntime,
): Promise<number> {
    const cwd = context.cwd();
    let prepared: PreparedProjectQuery;
    try {
        prepared = await prepareLocalQuery(runtime, options, cwd, questionSelection(selection, cwd));
    } catch (cause) {
        const error =
            cause instanceof CheckProjectOperationalError
                ? cause
                : new CheckProjectOperationalError(
                      'CHECK_OPERATION_FAILED',
                      'validation',
                      'The project could not be read',
                  );
        context.stderr.write(renderQueryError(error));
        return LOCAL_QUERY_EXIT.operational;
    }
    if (prepared.unknownQuestions.length > 0) {
        throw new CliRegistryUsageError(
            `not a competency question of this project: ${prepared.unknownQuestions.join(', ')}`,
        );
    }
    if (prepared.entailedUnavailable) {
        context.stderr.write(`Erden query has no entailed answer.\n${labelLines(prepared)}`);
        return LOCAL_QUERY_EXIT.partial;
    }
    const shared = prepared.reasons.filter(
        (reason) => reason.code === 'sources-unparsed' || reason.code === 'dependencies-missing',
    );
    const unavailable = prepared.reasons.find((reason) => reason.code === 'entailment-unavailable');
    const outside = prepared.reasons.find((reason) => reason.code === 'statements-outside-profile');
    const planned = prepared.questions.map((question) => {
        const asked = questionRegime(question.metadata);
        const regime: LocalQueryRegime =
            asked === 'entailed' && prepared.regime === 'entailed' ? 'entailed' : 'asserted';
        const rendered = renderQuestion(question);
        const graphs =
            regime === 'entailed' ? [QUESTION_GRAPH_DECLARED, QUESTION_GRAPH_INFERRED] : [QUESTION_GRAPH_DECLARED];
        const formats = questionAnswerFormats(rendered.text, question.metadata.expect);
        const reasons: LocalQueryCompletenessReason[] = [...shared];
        if (asked === 'entailed' && regime === 'asserted') {
            reasons.push(
                unavailable ?? {
                    code: 'entailment-unavailable',
                    cause: options.regime === 'asserted' ? 'regime-asserted-requested' : 'not-run',
                },
            );
        }
        if (regime === 'entailed' && outside !== undefined) {
            reasons.push(outside);
        }
        return { question, asked, regime, rendered, graphs, formats, reasons };
    });
    const queries = planned.flatMap((plan) =>
        plan.rendered.missing.length > 0
            ? []
            : plan.formats.map((format) => ({
                  query: plan.rendered.text,
                  defaultGraph: plan.graphs,
                  namedGraphs: [...plan.graphs, ...prepared.dataset.sourceGraphs],
                  format,
              })),
    );
    const answers =
        queries.length === 0
            ? []
            : await runtime.runBatch({
                  nquads: prepared.dataset.nquads,
                  queries,
                  milliseconds: options.timeoutSeconds * 1000,
              });
    let cursor = 0;
    let operational = false;
    const results: LocalQuestionResult[] = [];
    for (const plan of planned) {
        const { question } = plan;
        const file = relativeFile(prepared.projectRoot, question.locator);
        const expectedToFail = /EXPECTED TO FAIL/iu.test(question.metadata.status ?? '');
        let verdict: Readonly<{ rows: number | null; ok: boolean; reason: string }>;
        if (plan.rendered.missing.length > 0) {
            verdict = {
                rows: null,
                ok: false,
                reason: `unknown placeholder(s): ${plan.rendered.missing.map((key) => `{{${key}}}`).join(', ')}`,
            };
        } else {
            const answer: { json?: string; ntriples?: string; csv?: string; tsv?: string } = {};
            let failure: string | null = null;
            for (const format of plan.formats) {
                const result = answers[cursor];
                cursor += 1;
                if (result?.outcome === 'complete') {
                    answer[format] = result.text;
                } else if (failure === null) {
                    failure =
                        result?.outcome === 'query-error'
                            ? `query error: ${result.message}`
                            : result?.outcome === 'time-limit'
                              ? `no answer within ${String(options.timeoutSeconds)} s (--timeout)`
                              : `the query engine is unavailable${result?.outcome === 'unavailable' ? `: ${result.message}` : ''}`;
                    operational ||= result?.outcome !== 'query-error';
                }
            }
            if (failure !== null) {
                verdict = { rows: null, ok: false, reason: failure };
            } else {
                const locator = expectedResultsLocator(question);
                let expected: Uint8Array | null = null;
                if (locator !== null) {
                    try {
                        expected = await runtime.readFile(locator, MAXIMUM_EXPECTED_RESULTS_BYTES);
                    } catch {
                        expected = null;
                    }
                }
                try {
                    verdict = judgeQuestionAnswer(
                        question.metadata.expect,
                        answer,
                        expected,
                        scanSparqlQuery(plan.rendered.text).ordered,
                    );
                } catch (cause) {
                    verdict = { rows: null, ok: false, reason: cause instanceof Error ? cause.message : String(cause) };
                }
            }
        }
        const metadataBlocks = question.diagnostics.length > 0;
        const documented = expectedToFail && !verdict.ok && question.metadata.closes !== null && !metadataBlocks;
        results.push({
            id: question.id,
            file,
            ask: question.metadata.ask,
            expect: question.metadata.expect,
            regime: plan.regime,
            rows: verdict.rows,
            ok: verdict.ok && !metadataBlocks,
            blocking: metadataBlocks || (!verdict.ok && !documented),
            expectedToFail,
            reason: metadataBlocks
                ? `${verdict.reason}; ${question.diagnostics.map((item) => item.message).join(' ')}`
                : verdict.reason,
            completeness: { complete: plan.reasons.length === 0, reasons: plan.reasons },
        });
    }
    const failed = results.filter((result) => result.blocking).length;
    const incomplete = results.filter((result) => !result.completeness.complete).length;
    const exit = operational
        ? LOCAL_QUERY_EXIT.operational
        : failed > 0
          ? LOCAL_QUERY_EXIT.refused
          : incomplete > 0 && !options.allowIncomplete
            ? LOCAL_QUERY_EXIT.partial
            : LOCAL_QUERY_EXIT.answered;
    if (options.output === 'json') {
        context.stdout.write(
            `${terminalSafeJson(
                JSON.stringify(
                    {
                        schema: 'erden.local-questions-result/v1',
                        project: { canonicalIri: prepared.canonicalIri, manifest: prepared.manifestFile },
                        regime: regimeLabel(prepared),
                        completeness: completenessLabel(prepared),
                        dataset: { quadCounts: prepared.dataset.quadCounts },
                        summary: {
                            questions: results.length,
                            met: results.filter((result) => result.ok).length,
                            failed,
                            incomplete,
                        },
                        questions: results,
                    },
                    null,
                    2,
                ),
            )}\n`,
        );
        return exit;
    }
    const lines = results.map((result) => {
        const status = result.ok ? 'met' : result.blocking ? 'FAILED' : 'expected to fail';
        const partial = result.completeness.complete
            ? ''
            : ` (partial: ${result.completeness.reasons.map((reason) => reason.code).join(', ')})`;
        return `${status.padEnd(16)} ${terminalText(result.file)}: ${terminalText(result.reason)} [${result.regime}]${partial}`;
    });
    context.stdout.write(
        `${lines.join('\n')}${lines.length === 0 ? '' : '\n'}${String(results.length)} ${results.length === 1 ? 'question' : 'questions'}: ${String(results.filter((result) => result.ok).length)} met, ${String(failed)} failed, ${String(incomplete)} partial\n${labelLines(prepared)}`,
    );
    return exit;
}

function relativeFile(projectRoot: string, locator: string): string {
    const path = relative(projectRoot, locator).split('\\').join('/');
    return path.startsWith('../') || path.length === 0 ? locator : path;
}
