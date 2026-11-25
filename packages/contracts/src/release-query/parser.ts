import { rejectQuery } from './errors.js';
import { makeReleaseQueryLexer, type ReleaseQueryLexer, type ReleaseQueryToken } from './lexer.js';
import {
    RELEASE_QUERY_AGGREGATES,
    RELEASE_QUERY_CALLS,
    RELEASE_QUERY_CASTS,
    RELEASE_QUERY_GRAPHS,
    RELEASE_QUERY_LIMITS as LIMITS,
    type ReleaseQueryAggregate,
    type ReleaseQueryAst,
    type ReleaseQueryBinaryOperator,
    type ReleaseQueryCall,
    type ReleaseQueryElement,
    type ReleaseQueryExpression,
    type ReleaseQueryGroup,
    type ReleaseQueryGroupKey,
    type ReleaseQueryOrderKey,
    type ReleaseQueryPath,
    type ReleaseQueryProjection,
    type ReleaseQueryTerm,
    type ReleaseQueryTriplePattern,
} from './model.js';

const XSD = 'http://www.w3.org/2001/XMLSchema#';
const RDF_TYPE = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#type';
const UPDATE_WORDS = new Set([
    'INSERT',
    'DELETE',
    'LOAD',
    'CLEAR',
    'CREATE',
    'DROP',
    'COPY',
    'MOVE',
    'ADD',
    'WITH',
    'USING',
]);
const NONDETERMINISTIC = new Set(['NOW', 'RAND', 'UUID', 'STRUUID', 'BNODE']);
const FORBIDDEN_FUNCTIONS = new Set([
    'REPLACE',
    'MD5',
    'SHA1',
    'SHA256',
    'SHA384',
    'SHA512',
    'YEAR',
    'MONTH',
    'DAY',
    'HOURS',
    'MINUTES',
    'SECONDS',
    'TIMEZONE',
    'TZ',
    'IRI',
    'URI',
    'STRDT',
    'STRLANG',
    'ENCODE_FOR_URI',
    'LANGDIR',
    'HASLANG',
    'HASLANGDIR',
    'STRLANGDIR',
    'ISTRIPLE',
    'TRIPLE',
    'SUBJECT',
    'PREDICATE',
    'OBJECT',
]);
const CALLS: ReadonlySet<string> = new Set(RELEASE_QUERY_CALLS);
const AGGREGATES: ReadonlySet<string> = new Set(RELEASE_QUERY_AGGREGATES);
const ARITY: Readonly<Record<ReleaseQueryCall, readonly [number, number]>> = Object.freeze({
    STR: [1, 1],
    LANG: [1, 1],
    LANGMATCHES: [2, 2],
    DATATYPE: [1, 1],
    BOUND: [1, 1],
    SAMETERM: [2, 2],
    ISIRI: [1, 1],
    ISURI: [1, 1],
    ISBLANK: [1, 1],
    ISLITERAL: [1, 1],
    ISNUMERIC: [1, 1],
    STRLEN: [1, 1],
    SUBSTR: [2, 3],
    UCASE: [1, 1],
    LCASE: [1, 1],
    STRSTARTS: [2, 2],
    STRENDS: [2, 2],
    CONTAINS: [2, 2],
    STRBEFORE: [2, 2],
    STRAFTER: [2, 2],
    CONCAT: [0, LIMITS.maxFunctionArguments],
    COALESCE: [0, LIMITS.maxFunctionArguments],
    IF: [3, 3],
    ABS: [1, 1],
    ROUND: [1, 1],
    CEIL: [1, 1],
    FLOOR: [1, 1],
    REGEX: [2, 3],
});
const RELATIONAL = new Set(['=', '!=', '<', '>', '<=', '>=']);

interface ParserState {
    readonly lexer: ReleaseQueryLexer;
    readonly prefixes: Map<string, string>;
    readonly variables: Set<string>;
    nodes: number;
    /** UTF-8 bytes produced by prefix expansion; the canonical text contains each at least once. */
    expandedBytes: number;
    triples: number;
    optional: number;
    unionBranches: number;
    minus: number;
    filterBind: number;
    groupDepth: number;
    expressionDepth: number;
    aggregates: boolean;
    sawAggregate: boolean;
}

function node<T>(state: ParserState, value: T): T {
    state.nodes += 1;
    if (state.nodes > LIMITS.maxAstNodes) {
        rejectQuery('complexity-limit');
    }
    return Object.freeze(value);
}
function isPunct(token: ReleaseQueryToken, value: string): boolean {
    return token.kind === 'punct' && token.value === value;
}
function isWord(token: ReleaseQueryToken, upper: string): boolean {
    return token.kind === 'word' && token.upper === upper;
}
function expectPunct(state: ParserState, value: string): void {
    if (!isPunct(state.lexer.next(), value)) {
        rejectQuery('syntax');
    }
}
function expectWord(state: ParserState, upper: string): void {
    if (!isWord(state.lexer.next(), upper)) {
        rejectQuery('syntax');
    }
}
function variable(state: ParserState, name: string): Readonly<{ kind: 'variable'; name: string }> {
    state.variables.add(name);
    if (state.variables.size > LIMITS.maxVariables) {
        rejectQuery('complexity-limit');
    }
    return node(state, { kind: 'variable' as const, name });
}
function expectVariable(state: ParserState): string {
    const token = state.lexer.next();
    if (token.kind !== 'variable') {
        return rejectQuery('syntax');
    }
    return variable(state, token.name).name;
}
function resolve(state: ParserState, token: ReleaseQueryToken): string | null {
    if (token.kind === 'iri') {
        return token.value;
    }
    if (token.kind !== 'pname') {
        return null;
    }
    const namespace = state.prefixes.get(token.prefix);
    if (namespace === undefined) {
        return rejectQuery('unknown-prefix');
    }
    const value = `${namespace}${token.local}`;
    const bytes = Buffer.byteLength(value);
    if (bytes > LIMITS.maxIriBytes) {
        return rejectQuery('term-limit');
    }
    state.expandedBytes += bytes;
    if (state.expandedBytes > LIMITS.maxEngineQueryBytes) {
        return rejectQuery('complexity-limit');
    }
    return value;
}
function iri(state: ParserState, value: string): ReleaseQueryTerm {
    return node(state, { kind: 'iri' as const, value });
}

function literal(state: ParserState, token: ReleaseQueryToken, sign = ''): ReleaseQueryTerm | null {
    if (token.kind === 'number') {
        return node(state, {
            kind: 'literal' as const,
            value: `${sign}${token.lexical}`,
            language: null,
            datatype: `${XSD}${token.datatype}`,
        });
    }
    if (sign !== '') {
        return null;
    }
    if (token.kind === 'word' && (token.value === 'true' || token.value === 'false')) {
        return node(state, { kind: 'literal' as const, value: token.value, language: null, datatype: `${XSD}boolean` });
    }
    if (token.kind !== 'string') {
        return null;
    }
    const after = state.lexer.peek();
    if (after.kind === 'language') {
        state.lexer.next();
        return node(state, { kind: 'literal' as const, value: token.value, language: after.value, datatype: null });
    }
    if (isPunct(after, '^^')) {
        state.lexer.next();
        const datatype = resolve(state, state.lexer.next());
        if (datatype === null) {
            return rejectQuery('syntax');
        }
        return node(state, {
            kind: 'literal' as const,
            value: token.value,
            language: null,
            datatype: datatype === `${XSD}string` ? null : datatype,
        });
    }
    return node(state, { kind: 'literal' as const, value: token.value, language: null, datatype: null });
}

/** Term in a triple, VALUES row, or GRAPH name. Signed numbers are accepted where SPARQL allows them. */
function dataTerm(state: ParserState, allowLiteral: boolean): ReleaseQueryTerm {
    const token = state.lexer.next();
    if (token.kind === 'variable') {
        return variable(state, token.name);
    }
    const resolved = resolve(state, token);
    if (resolved !== null) {
        return iri(state, resolved);
    }
    if (isPunct(token, '(')) {
        return rejectQuery('blank-node-forbidden');
    }
    const signed =
        (isPunct(token, '+') || isPunct(token, '-')) && state.lexer.peek().kind === 'number'
            ? literal(state, state.lexer.next(), token.kind === 'punct' ? token.value : '')
            : null;
    const value = signed ?? literal(state, token);
    if (value === null || !allowLiteral) {
        return rejectQuery('syntax');
    }
    return value;
}

function pathPrimary(state: ParserState, depth: number, budget: { iris: number }): ReleaseQueryPath {
    const token = state.lexer.next();
    if (isPunct(token, '!')) {
        return rejectQuery('negated-path-forbidden');
    }
    if (isPunct(token, '(')) {
        const inner = path(state, depth + 1, budget);
        expectPunct(state, ')');
        return inner;
    }
    const resolved = token.kind === 'word' && token.value === 'a' ? RDF_TYPE : resolve(state, token);
    if (resolved === null) {
        return rejectQuery('syntax');
    }
    budget.iris += 1;
    if (budget.iris > LIMITS.maxPathIris) {
        return rejectQuery('path-limit');
    }
    return node(state, { kind: 'link' as const, iri: resolved });
}
function pathElement(state: ParserState, depth: number, budget: { iris: number }): ReleaseQueryPath {
    const inverse = isPunct(state.lexer.peek(), '^');
    if (inverse) {
        state.lexer.next();
    }
    let element = pathPrimary(state, depth, budget);
    const modifier = state.lexer.peek();
    if (isPunct(modifier, '*') || isPunct(modifier, '+') || isPunct(modifier, '{')) {
        return rejectQuery('unbounded-path-forbidden');
    }
    if (isPunct(modifier, '?')) {
        state.lexer.next();
        element = node(state, { kind: 'zero-or-one' as const, path: element });
    }
    return inverse ? node(state, { kind: 'inverse' as const, path: element }) : element;
}
const MAX_PARENTHESES = 16;
const MAX_EXPRESSION_NESTING = 64;

function pathDepth(value: ReleaseQueryPath): number {
    switch (value.kind) {
        case 'link':
            return 0;
        case 'inverse':
        case 'zero-or-one':
            return 1 + pathDepth(value.path);
        case 'sequence':
        case 'alternative':
            return 1 + Math.max(...value.items.map(pathDepth));
    }
}

function path(state: ParserState, depth: number, budget: { iris: number }): ReleaseQueryPath {
    // Parenthesis nesting only bounds recursion; the structural depth below is the policy limit.
    if (depth > MAX_PARENTHESES) {
        return rejectQuery('path-limit');
    }
    const alternatives: ReleaseQueryPath[] = [];
    for (;;) {
        const sequence: ReleaseQueryPath[] = [pathElement(state, depth, budget)];
        while (isPunct(state.lexer.peek(), '/')) {
            state.lexer.next();
            sequence.push(pathElement(state, depth, budget));
        }
        alternatives.push(
            sequence.length === 1 && sequence[0] !== undefined
                ? sequence[0]
                : node(state, { kind: 'sequence' as const, items: Object.freeze(sequence) }),
        );
        if (!isPunct(state.lexer.peek(), '|')) {
            break;
        }
        state.lexer.next();
    }
    return alternatives.length === 1 && alternatives[0] !== undefined
        ? alternatives[0]
        : node(state, { kind: 'alternative' as const, items: Object.freeze(alternatives) });
}
function verb(state: ParserState): ReleaseQueryTriplePattern['predicate'] {
    const token = state.lexer.peek();
    if (token.kind === 'variable') {
        state.lexer.next();
        return variable(state, token.name);
    }
    const value = path(state, 1, { iris: 0 });
    if (pathDepth(value) > LIMITS.maxPathDepth) {
        return rejectQuery('path-limit');
    }
    return value;
}

function triples(state: ParserState, output: ReleaseQueryTriplePattern[]): void {
    const subject = dataTerm(state, false);
    for (;;) {
        const predicate = verb(state);
        for (;;) {
            const object = dataTerm(state, true);
            state.triples += 1;
            if (state.triples > LIMITS.maxTriplePatterns) {
                rejectQuery('pattern-limit');
            }
            output.push(node(state, { subject, predicate, object }));
            if (!isPunct(state.lexer.peek(), ',')) {
                break;
            }
            state.lexer.next();
        }
        if (!isPunct(state.lexer.peek(), ';')) {
            return;
        }
        while (isPunct(state.lexer.peek(), ';')) {
            state.lexer.next();
        }
        const after = state.lexer.peek();
        if (isPunct(after, '.') || isPunct(after, '}')) {
            return;
        }
    }
}

function values(state: ParserState): ReleaseQueryElement {
    const names: string[] = [];
    const single = state.lexer.peek().kind === 'variable';
    if (single) {
        names.push(expectVariable(state));
    } else {
        expectPunct(state, '(');
        while (state.lexer.peek().kind === 'variable') {
            names.push(expectVariable(state));
            if (names.length > LIMITS.maxValuesVariables) {
                rejectQuery('values-limit');
            }
        }
        expectPunct(state, ')');
    }
    if (new Set(names).size !== names.length) {
        rejectQuery('query-invalid');
    }
    expectPunct(state, '{');
    const rows: Array<ReadonlyArray<ReleaseQueryTerm | null>> = [];
    function cell(): ReleaseQueryTerm | null {
        if (isWord(state.lexer.peek(), 'UNDEF')) {
            state.lexer.next();
            return null;
        }
        const term = dataTerm(state, true);
        return term.kind === 'variable' ? rejectQuery('syntax') : term;
    }
    while (!isPunct(state.lexer.peek(), '}')) {
        const row: Array<ReleaseQueryTerm | null> = [];
        if (single) {
            row.push(cell());
        } else {
            expectPunct(state, '(');
            while (!isPunct(state.lexer.peek(), ')')) {
                row.push(cell());
                if (row.length > names.length) {
                    rejectQuery('syntax');
                }
            }
            expectPunct(state, ')');
        }
        if (row.length !== names.length) {
            rejectQuery('syntax');
        }
        rows.push(Object.freeze(row));
        if (rows.length > LIMITS.maxValuesRows) {
            rejectQuery('values-limit');
        }
    }
    expectPunct(state, '}');
    return node(state, { kind: 'values' as const, variables: Object.freeze(names), rows: Object.freeze(rows) });
}

function graphName(state: ParserState): ReleaseQueryTerm {
    const token = state.lexer.next();
    if (token.kind === 'variable') {
        return variable(state, token.name);
    }
    const resolved = resolve(state, token);
    if (resolved === null) {
        return rejectQuery('syntax');
    }
    if (resolved !== RELEASE_QUERY_GRAPHS.declared && resolved !== RELEASE_QUERY_GRAPHS.inferred) {
        return rejectQuery('unknown-graph');
    }
    return iri(state, resolved);
}

function countFilterBind(state: ParserState): void {
    state.filterBind += 1;
    if (state.filterBind > LIMITS.maxFilterBind) {
        rejectQuery('pattern-limit');
    }
}

/** One element that is not a triples block, or null when the next token starts triples or closes the group. */
function nonTriples(state: ParserState): ReleaseQueryElement | null {
    const token = state.lexer.peek();
    if (isPunct(token, '{')) {
        const first = group(state);
        if (!isWord(state.lexer.peek(), 'UNION')) {
            return node(state, { kind: 'group' as const, group: first });
        }
        const groups = [first];
        state.unionBranches += 1;
        while (isWord(state.lexer.peek(), 'UNION')) {
            state.lexer.next();
            groups.push(group(state));
            state.unionBranches += 1;
            if (state.unionBranches > LIMITS.maxUnionBranches) {
                rejectQuery('pattern-limit');
            }
        }
        return node(state, { kind: 'union' as const, groups: Object.freeze(groups) });
    }
    if (token.kind !== 'word') {
        return null;
    }
    switch (token.upper) {
        case 'OPTIONAL':
            state.lexer.next();
            state.optional += 1;
            if (state.optional > LIMITS.maxOptional) {
                rejectQuery('pattern-limit');
            }
            return node(state, { kind: 'optional' as const, group: group(state) });
        case 'MINUS':
            state.lexer.next();
            state.minus += 1;
            if (state.minus > LIMITS.maxMinus) {
                rejectQuery('pattern-limit');
            }
            return node(state, { kind: 'minus' as const, group: group(state) });
        case 'GRAPH': {
            state.lexer.next();
            const name = graphName(state);
            return node(state, { kind: 'graph' as const, name, group: group(state) });
        }
        case 'SERVICE':
            return rejectQuery('service-forbidden');
        case 'FILTER':
            state.lexer.next();
            countFilterBind(state);
            return node(state, { kind: 'filter' as const, expression: constraint(state) });
        case 'BIND': {
            state.lexer.next();
            countFilterBind(state);
            expectPunct(state, '(');
            const expression = expressionRoot(state, false);
            expectWord(state, 'AS');
            const name = expectVariable(state);
            expectPunct(state, ')');
            return node(state, { kind: 'bind' as const, expression, variable: name });
        }
        case 'VALUES':
            state.lexer.next();
            return values(state);
        case 'SELECT':
            return rejectQuery('subquery-forbidden');
        default:
            return UPDATE_WORDS.has(token.upper) ? rejectQuery('update-forbidden') : null;
    }
}

function group(state: ParserState): ReleaseQueryGroup {
    expectPunct(state, '{');
    state.groupDepth += 1;
    if (state.groupDepth > LIMITS.maxGroupDepth) {
        rejectQuery('depth-limit');
    }
    if (isWord(state.lexer.peek(), 'SELECT')) {
        rejectQuery('subquery-forbidden');
    }
    const elements: ReleaseQueryElement[] = [];
    let pending: ReleaseQueryTriplePattern[] | null = null;
    // start | open (triples without a final dot) | closed (after a dot) | element (a dot may follow once)
    let mode: 'start' | 'open' | 'closed' | 'element' = 'start';
    function flush(): void {
        if (pending !== null) {
            elements.push(node(state, { kind: 'triples' as const, patterns: Object.freeze(pending) }));
            pending = null;
        }
    }
    for (;;) {
        const token = state.lexer.peek();
        if (isPunct(token, '}')) {
            break;
        }
        if (isPunct(token, '.')) {
            if (mode !== 'element') {
                rejectQuery('syntax');
            }
            state.lexer.next();
            mode = 'closed';
            continue;
        }
        const element = nonTriples(state);
        if (element !== null) {
            flush();
            elements.push(element);
            mode = 'element';
            continue;
        }
        if (mode === 'open') {
            rejectQuery('syntax');
        }
        pending ??= [];
        triples(state, pending);
        if (isPunct(state.lexer.peek(), '.')) {
            state.lexer.next();
            mode = 'closed';
        } else {
            flush();
            mode = 'open';
        }
    }
    flush();
    expectPunct(state, '}');
    state.groupDepth -= 1;
    return node(state, { elements: Object.freeze(elements) });
}

function argumentList(state: ParserState): ReadonlyArray<ReleaseQueryExpression> {
    expectPunct(state, '(');
    const args: ReleaseQueryExpression[] = [];
    if (isPunct(state.lexer.peek(), ')')) {
        state.lexer.next();
        return Object.freeze(args);
    }
    for (;;) {
        args.push(expression(state));
        if (args.length > LIMITS.maxFunctionArguments) {
            rejectQuery('complexity-limit');
        }
        const token = state.lexer.next();
        if (isPunct(token, ')')) {
            return Object.freeze(args);
        }
        if (!isPunct(token, ',')) {
            rejectQuery('syntax');
        }
    }
}

function simpleString(value: ReleaseQueryExpression | undefined): string | null {
    return value?.kind === 'literal' && value.language === null && value.datatype === null ? value.value : null;
}

function builtin(state: ParserState, name: ReleaseQueryCall): ReleaseQueryExpression {
    const args = argumentList(state);
    const [minimum, maximum] = ARITY[name];
    if (args.length < minimum || args.length > maximum) {
        return rejectQuery(args.length > LIMITS.maxFunctionArguments ? 'complexity-limit' : 'syntax');
    }
    if (name === 'BOUND' && args[0]?.kind !== 'variable') {
        return rejectQuery('syntax');
    }
    if (name === 'REGEX') {
        const pattern = simpleString(args[1]);
        const flags = args.length === 3 ? simpleString(args[2]) : '';
        if (
            pattern === null ||
            flags === null ||
            Buffer.byteLength(pattern) > LIMITS.maxRegexBytes ||
            !/^[imsx]{0,4}$/u.test(flags) ||
            new Set(flags).size !== flags.length
        ) {
            return rejectQuery('regex-forbidden');
        }
    }
    return node(state, { kind: 'call' as const, name, args });
}

function aggregate(state: ParserState, name: ReleaseQueryAggregate): ReleaseQueryExpression {
    if (!state.aggregates) {
        return rejectQuery('query-invalid');
    }
    state.sawAggregate = true;
    state.aggregates = false;
    expectPunct(state, '(');
    const distinct = isWord(state.lexer.peek(), 'DISTINCT');
    if (distinct) {
        state.lexer.next();
    }
    let arg: ReleaseQueryExpression | null = null;
    if (name === 'COUNT' && isPunct(state.lexer.peek(), '*')) {
        state.lexer.next();
    } else {
        arg = expression(state);
    }
    let separator: string | null = null;
    if (name === 'GROUP_CONCAT' && isPunct(state.lexer.peek(), ';')) {
        state.lexer.next();
        expectWord(state, 'SEPARATOR');
        expectPunct(state, '=');
        const token = state.lexer.next();
        if (token.kind !== 'string' || state.lexer.peek().kind === 'language' || isPunct(state.lexer.peek(), '^^')) {
            return rejectQuery('syntax');
        }
        if (Buffer.byteLength(token.value) > LIMITS.maxSeparatorBytes) {
            return rejectQuery('term-limit');
        }
        separator = token.value;
    }
    expectPunct(state, ')');
    state.aggregates = true;
    return node(state, { kind: 'aggregate' as const, name, distinct, arg, separator });
}

function exists(state: ParserState, negated: boolean): ReleaseQueryExpression {
    const saved = state.aggregates;
    state.aggregates = false;
    const inner = group(state);
    state.aggregates = saved;
    return node(state, { kind: 'exists' as const, negated, group: inner });
}

function namedCall(state: ParserState, token: Extract<ReleaseQueryToken, { kind: 'word' }>): ReleaseQueryExpression {
    const name = token.upper;
    if (name === 'EXISTS') {
        return exists(state, false);
    }
    if (name === 'NOT') {
        expectWord(state, 'EXISTS');
        return exists(state, true);
    }
    if (AGGREGATES.has(name)) {
        return aggregate(state, name as ReleaseQueryAggregate);
    }
    if (NONDETERMINISTIC.has(name)) {
        return rejectQuery('nondeterministic-function-forbidden');
    }
    if (FORBIDDEN_FUNCTIONS.has(name)) {
        return rejectQuery('function-forbidden');
    }
    if (CALLS.has(name)) {
        return builtin(state, name as ReleaseQueryCall);
    }
    return rejectQuery('syntax');
}

function primary(state: ParserState): ReleaseQueryExpression {
    const token = state.lexer.next();
    if (isPunct(token, '(')) {
        const inner = expression(state);
        expectPunct(state, ')');
        return inner;
    }
    if (token.kind === 'variable') {
        return variable(state, token.name);
    }
    const resolved = resolve(state, token);
    if (resolved !== null) {
        if (!isPunct(state.lexer.peek(), '(')) {
            return iri(state, resolved);
        }
        if (!RELEASE_QUERY_CASTS.has(resolved)) {
            return rejectQuery('extension-function-forbidden');
        }
        const args = argumentList(state);
        const arg = args[0];
        if (args.length !== 1 || arg === undefined) {
            return rejectQuery('syntax');
        }
        return node(state, { kind: 'cast' as const, datatype: resolved, arg });
    }
    const value = literal(state, token);
    if (value !== null) {
        return value;
    }
    if (token.kind === 'word') {
        return namedCall(state, token);
    }
    return rejectQuery('syntax');
}

function unary(state: ParserState): ReleaseQueryExpression {
    const token = state.lexer.peek();
    if (isPunct(token, '!') || isPunct(token, '+') || isPunct(token, '-')) {
        state.lexer.next();
        const operator = (token as Extract<ReleaseQueryToken, { kind: 'punct' }>).value as '!' | '+' | '-';
        return node(state, { kind: 'unary' as const, operator, arg: primary(state) });
    }
    return primary(state);
}

function chain(
    state: ParserState,
    operators: ReadonlySet<string>,
    operand: (state: ParserState) => ReleaseQueryExpression,
): ReleaseQueryExpression {
    const first = operand(state);
    const rest: Array<Readonly<{ operator: ReleaseQueryBinaryOperator; arg: ReleaseQueryExpression }>> = [];
    for (;;) {
        const token = state.lexer.peek();
        if (token.kind !== 'punct' || !operators.has(token.value)) {
            break;
        }
        state.lexer.next();
        rest.push(node(state, { operator: token.value as ReleaseQueryBinaryOperator, arg: operand(state) }));
    }
    return rest.length === 0 ? first : node(state, { kind: 'chain' as const, first, rest: Object.freeze(rest) });
}

const MULTIPLICATIVE = new Set(['*', '/']);
const ADDITIVE = new Set(['+', '-']);
const AND = new Set(['&&']);
const OR = new Set(['||']);

function multiplicative(state: ParserState): ReleaseQueryExpression {
    return chain(state, MULTIPLICATIVE, unary);
}
function additive(state: ParserState): ReleaseQueryExpression {
    return chain(state, ADDITIVE, multiplicative);
}
function relational(state: ParserState): ReleaseQueryExpression {
    const left = additive(state);
    const token = state.lexer.peek();
    if (token.kind === 'punct' && RELATIONAL.has(token.value)) {
        state.lexer.next();
        const right = additive(state);
        return node(state, {
            kind: 'chain' as const,
            first: left,
            rest: Object.freeze([node(state, { operator: token.value as ReleaseQueryBinaryOperator, arg: right })]),
        });
    }
    const negated = isWord(token, 'NOT') && isWord(state.lexer.peek(1), 'IN');
    if (negated || isWord(token, 'IN')) {
        state.lexer.next();
        if (negated) {
            state.lexer.next();
        }
        return node(state, { kind: 'in' as const, negated, arg: left, list: argumentList(state) });
    }
    return left;
}
function conjunction(state: ParserState): ReleaseQueryExpression {
    return chain(state, AND, relational);
}
function expression(state: ParserState): ReleaseQueryExpression {
    // Parenthesis nesting only bounds recursion; the structural depth check after parsing is the policy limit.
    state.expressionDepth += 1;
    if (state.expressionDepth > MAX_EXPRESSION_NESTING) {
        rejectQuery('depth-limit');
    }
    const value = chain(state, OR, conjunction);
    state.expressionDepth -= 1;
    return value;
}
function expressionRoot(state: ParserState, aggregates: boolean): ReleaseQueryExpression {
    const saved = state.aggregates;
    state.aggregates = aggregates;
    const value = expression(state);
    state.aggregates = saved;
    return value;
}

/** FILTER, HAVING, and ORDER BY constraint: a bracketed expression or a built-in call. */
function constraint(state: ParserState, aggregates = false): ReleaseQueryExpression {
    const token = state.lexer.peek();
    if (isPunct(token, '(')) {
        state.lexer.next();
        const value = expressionRoot(state, aggregates);
        expectPunct(state, ')');
        return value;
    }
    if (token.kind === 'word' || token.kind === 'iri' || token.kind === 'pname') {
        const saved = state.aggregates;
        state.aggregates = aggregates;
        const value = primary(state);
        state.aggregates = saved;
        if (value.kind !== 'call' && value.kind !== 'cast' && value.kind !== 'exists' && value.kind !== 'aggregate') {
            return rejectQuery('syntax');
        }
        return value;
    }
    return rejectQuery('syntax');
}

function prologue(state: ParserState): void {
    for (;;) {
        const token = state.lexer.peek();
        if (isWord(token, 'BASE')) {
            rejectQuery('base-forbidden');
        }
        if (!isWord(token, 'PREFIX')) {
            return;
        }
        state.lexer.next();
        const name = state.lexer.next();
        if (name.kind !== 'pname' || name.local !== '') {
            rejectQuery('syntax');
        }
        const target = state.lexer.next();
        if (target.kind !== 'iri') {
            rejectQuery('syntax');
        }
        if (state.prefixes.has(name.prefix)) {
            rejectQuery('prefix-redeclared');
        }
        state.prefixes.set(name.prefix, target.value);
        if (state.prefixes.size > LIMITS.maxPrefixes) {
            rejectQuery('complexity-limit');
        }
    }
}

function projection(state: ParserState): ReadonlyArray<ReleaseQueryProjection> | null {
    if (isPunct(state.lexer.peek(), '*')) {
        state.lexer.next();
        return null;
    }
    const items: ReleaseQueryProjection[] = [];
    for (;;) {
        const token = state.lexer.peek();
        if (token.kind === 'variable') {
            items.push(node(state, { kind: 'variable' as const, name: expectVariable(state) }));
        } else if (isPunct(token, '(')) {
            state.lexer.next();
            const value = expressionRoot(state, true);
            expectWord(state, 'AS');
            const name = expectVariable(state);
            expectPunct(state, ')');
            items.push(node(state, { kind: 'expression' as const, expression: value, name }));
        } else {
            break;
        }
        if (items.length > LIMITS.maxProjection) {
            rejectQuery('complexity-limit');
        }
    }
    if (items.length === 0) {
        rejectQuery('syntax');
    }
    return Object.freeze(items);
}

function datasetAndWhere(state: ParserState): ReleaseQueryGroup {
    if (isWord(state.lexer.peek(), 'FROM')) {
        rejectQuery('dataset-clause-forbidden');
    }
    if (isWord(state.lexer.peek(), 'WHERE')) {
        state.lexer.next();
    }
    return group(state);
}

function boundedInteger(state: ParserState, reason: 'limit-exceeded' | 'offset-exceeded', maximum: number): number {
    const token = state.lexer.next();
    if (token.kind !== 'number' || token.datatype !== 'integer') {
        return rejectQuery('syntax');
    }
    const digits = token.lexical.replace(/^0+(?=\d)/u, '');
    if (digits.length > 6 || Number(digits) > maximum) {
        return rejectQuery(reason);
    }
    return Number(digits);
}

function groupKeys(state: ParserState): ReadonlyArray<ReleaseQueryGroupKey> {
    const keys: ReleaseQueryGroupKey[] = [];
    for (;;) {
        const token = state.lexer.peek();
        if (token.kind === 'variable') {
            state.lexer.next();
            keys.push(node(state, { kind: 'expression' as const, expression: variable(state, token.name) }));
        } else if (isPunct(token, '(')) {
            state.lexer.next();
            const value = expressionRoot(state, false);
            let name: string | null = null;
            if (isWord(state.lexer.peek(), 'AS')) {
                state.lexer.next();
                name = expectVariable(state);
            }
            expectPunct(state, ')');
            keys.push(
                name === null
                    ? node(state, { kind: 'expression' as const, expression: value })
                    : node(state, { kind: 'alias' as const, expression: value, name }),
            );
        } else if (token.kind === 'word' && CALLS.has(token.upper)) {
            keys.push(node(state, { kind: 'expression' as const, expression: constraint(state) }));
        } else {
            break;
        }
        if (keys.length > LIMITS.maxGroupKeys) {
            rejectQuery('complexity-limit');
        }
    }
    return keys.length === 0 ? rejectQuery('syntax') : Object.freeze(keys);
}

function orderKeys(state: ParserState): ReadonlyArray<ReleaseQueryOrderKey> {
    const keys: ReleaseQueryOrderKey[] = [];
    for (;;) {
        const token = state.lexer.peek();
        if (isWord(token, 'ASC') || isWord(token, 'DESC')) {
            state.lexer.next();
            expectPunct(state, '(');
            const value = expressionRoot(state, true);
            expectPunct(state, ')');
            keys.push(node(state, { descending: token.kind === 'word' && token.upper === 'DESC', expression: value }));
        } else if (token.kind === 'variable') {
            state.lexer.next();
            keys.push(node(state, { descending: false, expression: variable(state, token.name) }));
        } else if (
            isPunct(token, '(') ||
            (token.kind === 'word' && (CALLS.has(token.upper) || AGGREGATES.has(token.upper)))
        ) {
            keys.push(node(state, { descending: false, expression: constraint(state, true) }));
        } else {
            break;
        }
        if (keys.length > LIMITS.maxOrderKeys) {
            rejectQuery('complexity-limit');
        }
    }
    return keys.length === 0 ? rejectQuery('syntax') : Object.freeze(keys);
}

function solutionModifiers(
    state: ParserState,
): Omit<Extract<ReleaseQueryAst, { form: 'select' }>, 'schema' | 'form' | 'distinct' | 'projection' | 'where'> {
    let groupBy: ReadonlyArray<ReleaseQueryGroupKey> = Object.freeze([]);
    const having: ReleaseQueryExpression[] = [];
    let orderBy: ReadonlyArray<ReleaseQueryOrderKey> = Object.freeze([]);
    if (isWord(state.lexer.peek(), 'GROUP')) {
        state.lexer.next();
        expectWord(state, 'BY');
        groupBy = groupKeys(state);
    }
    if (isWord(state.lexer.peek(), 'HAVING')) {
        state.lexer.next();
        do {
            having.push(constraint(state, true));
        } while (startsConstraint(state.lexer.peek()));
    }
    if (isWord(state.lexer.peek(), 'ORDER')) {
        state.lexer.next();
        expectWord(state, 'BY');
        orderBy = orderKeys(state);
    }
    let limit: number | null = null;
    let offset: number | null = null;
    for (let round = 0; round < 2; round += 1) {
        if (limit === null && isWord(state.lexer.peek(), 'LIMIT')) {
            state.lexer.next();
            limit = boundedInteger(state, 'limit-exceeded', LIMITS.maxLimit);
        } else if (offset === null && isWord(state.lexer.peek(), 'OFFSET')) {
            state.lexer.next();
            offset = boundedInteger(state, 'offset-exceeded', LIMITS.maxOffset);
        }
    }
    return { groupBy, having: Object.freeze(having), orderBy, limit, offset };
}
function startsConstraint(token: ReleaseQueryToken): boolean {
    return (
        isPunct(token, '(') ||
        (token.kind === 'word' &&
            (CALLS.has(token.upper) ||
                AGGREGATES.has(token.upper) ||
                token.upper === 'EXISTS' ||
                token.upper === 'NOT'))
    );
}

function selectQuery(state: ParserState): ReleaseQueryAst {
    state.lexer.next();
    const modifier = state.lexer.peek();
    if (isWord(modifier, 'REDUCED')) {
        rejectQuery('form-forbidden');
    }
    const distinct = isWord(modifier, 'DISTINCT');
    if (distinct) {
        state.lexer.next();
    }
    const projected = projection(state);
    const where = datasetAndWhere(state);
    return node(state, {
        schema: 'erden.release-query-ast/v1' as const,
        form: 'select' as const,
        distinct,
        projection: projected,
        where,
        ...solutionModifiers(state),
    });
}

function askQuery(state: ParserState): ReleaseQueryAst {
    state.lexer.next();
    const where = datasetAndWhere(state);
    return node(state, { schema: 'erden.release-query-ast/v1' as const, form: 'ask' as const, where });
}

/** Parse caller text into the closed AST. Pure: runs before, and independent of, any data or authority access. */
export function parseReleaseQueryAst(text: string): Readonly<{
    ast: ReleaseQueryAst;
    variables: ReadonlyArray<string>;
    grouped: boolean;
}> {
    const state: ParserState = {
        lexer: makeReleaseQueryLexer(text),
        prefixes: new Map(),
        variables: new Set(),
        nodes: 0,
        expandedBytes: 0,
        triples: 0,
        optional: 0,
        unionBranches: 0,
        minus: 0,
        filterBind: 0,
        groupDepth: 0,
        expressionDepth: 0,
        aggregates: false,
        sawAggregate: false,
    };
    prologue(state);
    const token = state.lexer.peek();
    let ast: ReleaseQueryAst;
    if (isWord(token, 'SELECT')) {
        ast = selectQuery(state);
    } else if (isWord(token, 'ASK')) {
        ast = askQuery(state);
    } else if (isWord(token, 'CONSTRUCT') || isWord(token, 'DESCRIBE')) {
        return rejectQuery('form-forbidden');
    } else if (token.kind === 'word' && UPDATE_WORDS.has(token.upper)) {
        return rejectQuery('update-forbidden');
    } else {
        return rejectQuery('syntax');
    }
    const trailing = state.lexer.next();
    if (isPunct(trailing, ';')) {
        return rejectQuery('update-forbidden');
    }
    if (trailing.kind !== 'end') {
        return rejectQuery('syntax');
    }
    return Object.freeze({
        ast,
        variables: Object.freeze([...state.variables].sort()),
        grouped: ast.form === 'select' && (ast.groupBy.length > 0 || state.sawAggregate),
    });
}
