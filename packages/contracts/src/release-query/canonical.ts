import { createHash } from 'node:crypto';

import { rejectQuery } from './errors.js';
import {
    RELEASE_QUERY_LIMITS as LIMITS,
    type ParsedReleaseQuery,
    type ReleaseQueryAst,
    type ReleaseQueryElement,
    type ReleaseQueryExpression,
    type ReleaseQueryGroup,
    type ReleaseQueryPath,
    type ReleaseQueryTerm,
    type ReleaseQueryTriplePattern,
} from './model.js';
import { parseReleaseQueryAst } from './parser.js';

const CALL_SPELLING: Readonly<Record<string, string>> = Object.freeze({ SAMETERM: 'sameTerm', ISIRI: 'isIRI' });

function quote(value: string): string {
    return `"${value.replace(/[\\"\n\r\t]/gu, (character) =>
        character === '\n' ? '\\n' : character === '\r' ? '\\r' : character === '\t' ? '\\t' : `\\${character}`,
    )}"`;
}

/**
 * UTF-16 units emitted for terms by the running serialization. Every unit encodes to at least one UTF-8 byte, so
 * exceeding the engine bound here proves the final text exceeds it: repeated subjects, paths, and expanded
 * prefixes stop the work as soon as the bound is certain, not after megabytes of output. Serialization is
 * synchronous, so one counter per module is sufficient.
 */
let emitted = 0;

function charge(text: string): string {
    emitted += text.length;
    if (emitted > LIMITS.maxEngineQueryBytes) {
        rejectQuery('complexity-limit');
    }
    return text;
}

function term(value: ReleaseQueryTerm): string {
    if (value.kind === 'variable') {
        return `?${value.name}`;
    }
    if (value.kind === 'iri') {
        return charge(`<${value.value}>`);
    }
    return charge(
        `${quote(value.value)}${value.language === null ? '' : `@${value.language}`}${
            value.datatype === null ? '' : `^^<${value.datatype}>`
        }`,
    );
}

function path(value: ReleaseQueryPath): string {
    switch (value.kind) {
        case 'link':
            return charge(`<${value.iri}>`);
        case 'inverse':
            return `^(${path(value.path)})`;
        case 'zero-or-one':
            return `(${path(value.path)})?`;
        case 'sequence':
            return `(${value.items.map(path).join(' / ')})`;
        case 'alternative':
            return `(${value.items.map(path).join(' | ')})`;
    }
}

function pattern(value: ReleaseQueryTriplePattern): string {
    const predicate = value.predicate.kind === 'variable' ? `?${value.predicate.name}` : path(value.predicate);
    return `${term(value.subject)} ${predicate} ${term(value.object)} .`;
}

function expression(value: ReleaseQueryExpression): string {
    switch (value.kind) {
        case 'variable':
        case 'iri':
        case 'literal':
            return term(value);
        case 'call':
            return `${CALL_SPELLING[value.name] ?? value.name}(${value.args.map(expression).join(', ')})`;
        case 'cast':
            return `<${value.datatype}>(${expression(value.arg)})`;
        case 'unary':
            return `(${value.operator}${expression(value.arg)})`;
        case 'chain':
            return `(${[expression(value.first), ...value.rest.map((entry) => `${entry.operator} ${expression(entry.arg)}`)].join(' ')})`;
        case 'in':
            return `(${expression(value.arg)} ${value.negated ? 'NOT IN' : 'IN'} (${value.list.map(expression).join(', ')}))`;
        case 'exists':
            return `${value.negated ? 'NOT EXISTS' : 'EXISTS'} ${group(value.group)}`;
        case 'aggregate':
            return `${value.name}(${value.distinct ? 'DISTINCT ' : ''}${value.arg === null ? '*' : expression(value.arg)}${
                value.separator === null ? '' : ` ; SEPARATOR = ${quote(value.separator)}`
            })`;
    }
}

function element(value: ReleaseQueryElement): string {
    switch (value.kind) {
        case 'triples':
            return value.patterns.map(pattern).join(' ');
        case 'group':
            return group(value.group);
        case 'optional':
            return `OPTIONAL ${group(value.group)}`;
        case 'union':
            return value.groups.map(group).join(' UNION ');
        case 'minus':
            return `MINUS ${group(value.group)}`;
        case 'graph':
            return `GRAPH ${term(value.name)} ${group(value.group)}`;
        case 'filter':
            return `FILTER (${expression(value.expression)})`;
        case 'bind':
            return `BIND (${expression(value.expression)} AS ?${value.variable})`;
        case 'values':
            return `VALUES (${value.variables.map((name) => `?${name}`).join(' ')}) { ${value.rows
                .map((row) => `(${row.map((cell) => (cell === null ? 'UNDEF' : term(cell))).join(' ')})`)
                .join(' ')} }`;
    }
}

function group(value: ReleaseQueryGroup): string {
    return value.elements.length === 0 ? '{ }' : `{ ${value.elements.map(element).join(' ')} }`;
}

/** Canonical SPARQL for a closed AST. `limitOverride` replaces an absent LIMIT for the engine text only. */
export function serializeReleaseQuery(ast: ReleaseQueryAst, limitOverride: number | null = null): string {
    emitted = 0;
    if (ast.form === 'ask') {
        return `ASK WHERE ${group(ast.where)}`;
    }
    const parts = [ast.distinct ? 'SELECT DISTINCT' : 'SELECT'];
    parts.push(
        ast.projection === null
            ? '*'
            : ast.projection
                  .map((item) =>
                      item.kind === 'variable' ? `?${item.name}` : `(${expression(item.expression)} AS ?${item.name})`,
                  )
                  .join(' '),
    );
    parts.push(`WHERE ${group(ast.where)}`);
    if (ast.groupBy.length > 0) {
        parts.push(
            `GROUP BY ${ast.groupBy
                .map((key) =>
                    key.kind === 'alias'
                        ? `(${expression(key.expression)} AS ?${key.name})`
                        : key.expression.kind === 'variable'
                          ? `?${key.expression.name}`
                          : `(${expression(key.expression)})`,
                )
                .join(' ')}`,
        );
    }
    if (ast.having.length > 0) {
        parts.push(`HAVING ${ast.having.map((entry) => `(${expression(entry)})`).join(' ')}`);
    }
    if (ast.orderBy.length > 0) {
        parts.push(
            `ORDER BY ${ast.orderBy
                .map((key) => `${key.descending ? 'DESC' : 'ASC'}(${expression(key.expression)})`)
                .join(' ')}`,
        );
    }
    const limit = ast.limit ?? limitOverride;
    if (limit !== null) {
        parts.push(`LIMIT ${String(limit)}`);
    }
    if (ast.offset !== null) {
        parts.push(`OFFSET ${String(ast.offset)}`);
    }
    return parts.join(' ');
}

function expressionVariables(value: ReleaseQueryExpression, output: Set<string>, outsideAggregates = false): void {
    switch (value.kind) {
        case 'variable':
            output.add(value.name);
            return;
        case 'iri':
        case 'literal':
            return;
        case 'call':
        case 'in':
            for (const arg of value.kind === 'call' ? value.args : [value.arg, ...value.list]) {
                expressionVariables(arg, output, outsideAggregates);
            }
            return;
        case 'cast':
        case 'unary':
            expressionVariables(value.arg, output, outsideAggregates);
            return;
        case 'chain':
            expressionVariables(value.first, output, outsideAggregates);
            for (const entry of value.rest) {
                expressionVariables(entry.arg, output, outsideAggregates);
            }
            return;
        case 'exists':
            groupVariables(value.group, output);
            return;
        case 'aggregate':
            if (!outsideAggregates && value.arg !== null) {
                expressionVariables(value.arg, output);
            }
            return;
    }
}

function elementVariables(value: ReleaseQueryElement, output: Set<string>): void {
    switch (value.kind) {
        case 'triples':
            for (const entry of value.patterns) {
                for (const item of [entry.subject, entry.object]) {
                    if (item.kind === 'variable') {
                        output.add(item.name);
                    }
                }
                if (entry.predicate.kind === 'variable') {
                    output.add(entry.predicate.name);
                }
            }
            return;
        case 'group':
        case 'optional':
        case 'minus':
            groupVariables(value.group, output);
            return;
        case 'union':
            for (const entry of value.groups) {
                groupVariables(entry, output);
            }
            return;
        case 'graph':
            if (value.name.kind === 'variable') {
                output.add(value.name.name);
            }
            groupVariables(value.group, output);
            return;
        case 'filter':
            expressionVariables(value.expression, output);
            return;
        case 'bind':
            expressionVariables(value.expression, output);
            output.add(value.variable);
            return;
        case 'values':
            for (const name of value.variables) {
                output.add(name);
            }
            return;
    }
}

function groupVariables(value: ReleaseQueryGroup, output: Set<string>): void {
    for (const entry of value.elements) {
        elementVariables(entry, output);
    }
}

/** Conservative scope rule: a BIND target must not occur anywhere earlier in its group. */
function checkBindScopes(value: ReleaseQueryGroup): void {
    const seen = new Set<string>();
    for (const entry of value.elements) {
        if (entry.kind === 'bind' && seen.has(entry.variable)) {
            rejectQuery('query-invalid');
        }
        elementVariables(entry, seen);
        for (const nested of nestedGroups(entry)) {
            checkBindScopes(nested);
        }
    }
}

function nestedGroups(value: ReleaseQueryElement): ReadonlyArray<ReleaseQueryGroup> {
    switch (value.kind) {
        case 'group':
        case 'optional':
        case 'minus':
        case 'graph':
            return [value.group];
        case 'union':
            return value.groups;
        case 'filter':
        case 'bind':
            return existsGroups(value.expression);
        default:
            return [];
    }
}

function existsGroups(value: ReleaseQueryExpression): ReadonlyArray<ReleaseQueryGroup> {
    switch (value.kind) {
        case 'exists':
            return [value.group];
        case 'call':
            return value.args.flatMap(existsGroups);
        case 'in':
            return [value.arg, ...value.list].flatMap(existsGroups);
        case 'cast':
        case 'unary':
            return existsGroups(value.arg);
        case 'chain':
            return [value.first, ...value.rest.map((entry) => entry.arg)].flatMap(existsGroups);
        case 'aggregate':
            return value.arg === null ? [] : existsGroups(value.arg);
        default:
            return [];
    }
}

/** Projection, GROUP BY, HAVING, and ORDER BY expressions: roots that are not inside the WHERE group. */
function solutionExpressions(ast: ReleaseQueryAst): ReadonlyArray<ReleaseQueryExpression> {
    if (ast.form === 'ask') {
        return [];
    }
    return [
        ...(ast.projection ?? []).flatMap((item) => (item.kind === 'expression' ? [item.expression] : [])),
        ...ast.groupBy.map((key) => key.expression),
        ...ast.having,
        ...ast.orderBy.map((key) => key.expression),
    ];
}

/** Every group pattern the query evaluates: WHERE plus each EXISTS group reached from a solution expression. */
function queryGroups(ast: ReleaseQueryAst): ReadonlyArray<ReleaseQueryGroup> {
    return [ast.where, ...solutionExpressions(ast).flatMap(existsGroups)];
}

function checkSelect(ast: Extract<ReleaseQueryAst, { form: 'select' }>, grouped: boolean): void {
    const whereVariables = new Set<string>();
    groupVariables(ast.where, whereVariables);
    const keys = new Set<string>();
    for (const key of ast.groupBy) {
        if (key.kind === 'alias') {
            if (whereVariables.has(key.name) || keys.has(key.name)) {
                rejectQuery('query-invalid');
            }
            keys.add(key.name);
        } else if (key.expression.kind === 'variable') {
            keys.add(key.expression.name);
        }
    }
    if (grouped && ast.projection === null) {
        rejectQuery('query-invalid');
    }
    const projected = new Set<string>();
    for (const item of ast.projection ?? []) {
        if (projected.has(item.name)) {
            rejectQuery('query-invalid');
        }
        if (item.kind === 'expression') {
            if (whereVariables.has(item.name) || keys.has(item.name)) {
                rejectQuery('query-invalid');
            }
            if (grouped) {
                const free = new Set<string>();
                expressionVariables(item.expression, free, true);
                if ([...free].some((name) => !keys.has(name) && !projected.has(name))) {
                    rejectQuery('query-invalid');
                }
            }
        } else if (grouped && !keys.has(item.name)) {
            rejectQuery('query-invalid');
        }
        projected.add(item.name);
    }
}

function expressionDepth(value: ReleaseQueryExpression): number {
    switch (value.kind) {
        case 'variable':
        case 'iri':
        case 'literal':
        case 'exists':
            return 1;
        case 'aggregate':
            return 1 + (value.arg === null ? 0 : expressionDepth(value.arg));
        case 'call':
            return 1 + Math.max(0, ...value.args.map(expressionDepth));
        case 'in':
            return 1 + Math.max(...[value.arg, ...value.list].map(expressionDepth));
        case 'cast':
        case 'unary':
            return 1 + expressionDepth(value.arg);
        case 'chain':
            return 1 + Math.max(expressionDepth(value.first), ...value.rest.map((entry) => expressionDepth(entry.arg)));
    }
}

function groupExpressions(value: ReleaseQueryGroup): ReadonlyArray<ReleaseQueryExpression> {
    return value.elements.flatMap((entry) => [
        ...(entry.kind === 'filter' || entry.kind === 'bind' ? [entry.expression] : []),
        ...nestedGroups(entry).flatMap(groupExpressions),
    ]);
}

function checkExpressionDepth(ast: ReleaseQueryAst): void {
    const roots = [...queryGroups(ast).flatMap(groupExpressions), ...solutionExpressions(ast)];
    if (roots.some((root) => expressionDepth(root) > LIMITS.maxExpressionDepth)) {
        rejectQuery('depth-limit');
    }
}

/** Parse, validate, and canonicalize. Throws `RELEASE_QUERY_REJECTED` with a closed reason and nothing else. */
export function parseReleaseQuery(text: string): ParsedReleaseQuery {
    const parsed = parseReleaseQueryAst(text);
    const ast = parsed.ast;
    checkExpressionDepth(ast);
    for (const entry of queryGroups(ast)) {
        checkBindScopes(entry);
    }
    if (ast.form === 'select') {
        checkSelect(ast, parsed.grouped);
    }
    const canonical = serializeReleaseQuery(ast);
    const engineQuery =
        ast.form === 'select' && ast.limit === null ? serializeReleaseQuery(ast, LIMITS.maxResultRows + 1) : canonical;
    if (Buffer.byteLength(engineQuery) > LIMITS.maxEngineQueryBytes) {
        rejectQuery('complexity-limit');
    }
    return Object.freeze({
        form: ast.form,
        ast,
        canonical,
        querySha256: createHash('sha256').update(`${canonical}\n`).digest('hex'),
        engineQuery,
        projection:
            ast.form === 'ask'
                ? Object.freeze([])
                : ast.projection === null
                  ? null
                  : Object.freeze(ast.projection.map((item) => item.name)),
        variables: parsed.variables,
    });
}
