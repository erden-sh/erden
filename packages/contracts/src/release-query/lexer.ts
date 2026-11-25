import { rejectQuery } from './errors.js';
import { RELEASE_QUERY_LIMITS as LIMITS } from './model.js';

export type ReleaseQueryToken =
    | Readonly<{ kind: 'iri'; value: string }>
    | Readonly<{ kind: 'pname'; prefix: string; local: string }>
    | Readonly<{ kind: 'variable'; name: string }>
    | Readonly<{ kind: 'string'; value: string }>
    | Readonly<{ kind: 'language'; value: string }>
    | Readonly<{ kind: 'number'; datatype: 'integer' | 'decimal' | 'double'; lexical: string }>
    | Readonly<{ kind: 'word'; value: string; upper: string }>
    | Readonly<{ kind: 'punct'; value: string }>
    | Readonly<{ kind: 'end' }>;

const ABSOLUTE_IRI = /^[A-Za-z][A-Za-z0-9+.-]*:/u;
const TWO_CHARACTER = new Set(['^^', '!=', '<=', '>=', '&&', '||']);
const ONE_CHARACTER = new Set([
    '{',
    '}',
    '(',
    ')',
    '.',
    ';',
    ',',
    '*',
    '/',
    '|',
    '^',
    '?',
    '!',
    '=',
    '<',
    '>',
    '+',
    '-',
]);

function isAsciiLetter(code: number): boolean {
    return (code >= 65 && code <= 90) || (code >= 97 && code <= 122);
}
function isDigit(code: number): boolean {
    return code >= 48 && code <= 57;
}
function isNameCharacter(code: number): boolean {
    return isAsciiLetter(code) || isDigit(code) || code === 95;
}
function isLocalCharacter(code: number): boolean {
    return isNameCharacter(code) || code === 45 || code === 46;
}
function isIriCharacter(code: number): boolean {
    // IRIREF excludes <>"{}|^`\ and every code point up to and including U+0020.
    return code > 0x20 && ![60, 62, 34, 123, 125, 124, 94, 96, 92].includes(code);
}

/** Whole-text checks that run before any token: size, encoding, controls, and codepoint escapes anywhere. */
export function checkReleaseQueryText(text: string): void {
    if (typeof text !== 'string' || !text.isWellFormed()) {
        rejectQuery('encoding-invalid');
    }
    if (Buffer.byteLength(text) > LIMITS.maxQueryBytes) {
        rejectQuery('query-too-large');
    }
    if (text.charCodeAt(0) === 0xfeff) {
        rejectQuery('encoding-invalid');
    }
    for (let index = 0; index < text.length; index += 1) {
        const code = text.charCodeAt(index);
        if (code < 0x20 && code !== 9 && code !== 10 && code !== 13) {
            rejectQuery('encoding-invalid');
        }
        // SPARQL 1.1 section 19.2 decodes \u and \U before parsing, including inside strings and comments.
        if (code === 92 && (text.charCodeAt(index + 1) === 117 || text.charCodeAt(index + 1) === 85)) {
            rejectQuery('escape-forbidden');
        }
    }
}

export interface ReleaseQueryLexer {
    readonly peek: (offset?: number) => ReleaseQueryToken;
    readonly next: () => ReleaseQueryToken;
}

/** Linear, lazily evaluated tokenizer. Every rejection is a closed reason; no regular expression runs on unbounded input. */
export function makeReleaseQueryLexer(text: string): ReleaseQueryLexer {
    checkReleaseQueryText(text);
    let position = 0;
    let count = 0;
    const buffer: ReleaseQueryToken[] = [];

    function skipTrivia(): void {
        while (position < text.length) {
            const code = text.charCodeAt(position);
            if (code === 32 || code === 9 || code === 10 || code === 13) {
                position += 1;
            } else if (code === 35) {
                while (position < text.length && text.charCodeAt(position) !== 10 && text.charCodeAt(position) !== 13) {
                    position += 1;
                }
            } else {
                return;
            }
        }
    }
    function iriOrOperator(): ReleaseQueryToken {
        if (text.charCodeAt(position + 1) === 60) {
            return rejectQuery('triple-term-forbidden');
        }
        let end = position + 1;
        while (end < text.length && isIriCharacter(text.charCodeAt(end))) {
            end += 1;
        }
        if (text.charCodeAt(end) === 62) {
            const value = text.slice(position + 1, end);
            position = end + 1;
            if (Buffer.byteLength(value) > LIMITS.maxIriBytes) {
                return rejectQuery('term-limit');
            }
            if (!ABSOLUTE_IRI.test(value.slice(0, 256))) {
                return rejectQuery('relative-iri-forbidden');
            }
            return { kind: 'iri', value };
        }
        if (text.charCodeAt(position + 1) === 61) {
            position += 2;
            return { kind: 'punct', value: '<=' };
        }
        position += 1;
        return { kind: 'punct', value: '<' };
    }
    function stringLiteral(): ReleaseQueryToken {
        const quote = text.charCodeAt(position);
        const long = text.charCodeAt(position + 1) === quote && text.charCodeAt(position + 2) === quote;
        position += long ? 3 : 1;
        let value = '';
        let chunk = position;
        for (;;) {
            if (position >= text.length) {
                return rejectQuery('syntax');
            }
            const code = text.charCodeAt(position);
            if (code === quote) {
                if (!long) {
                    value += text.slice(chunk, position);
                    position += 1;
                    break;
                }
                if (text.charCodeAt(position + 1) === quote && text.charCodeAt(position + 2) === quote) {
                    // A long string may end with up to two extra quote characters before the closing triple.
                    let extra = 0;
                    while (extra < 2 && text.charCodeAt(position + 3 + extra) === quote) {
                        extra += 1;
                    }
                    value += text.slice(chunk, position + extra);
                    position += 3 + extra;
                    break;
                }
                position += 1;
            } else if (code === 92) {
                value += text.slice(chunk, position);
                const escaped = text.charCodeAt(position + 1);
                const decoded =
                    escaped === 116
                        ? '\t'
                        : escaped === 110
                          ? '\n'
                          : escaped === 114
                            ? '\r'
                            : escaped === 34
                              ? '"'
                              : escaped === 39
                                ? "'"
                                : escaped === 92
                                  ? '\\'
                                  : null;
                if (decoded === null) {
                    return rejectQuery(escaped === 98 || escaped === 102 ? 'escape-forbidden' : 'syntax');
                }
                value += decoded;
                position += 2;
                chunk = position;
            } else if (!long && (code === 10 || code === 13)) {
                return rejectQuery('syntax');
            } else {
                position += 1;
            }
        }
        if (Buffer.byteLength(value) > LIMITS.maxLiteralBytes) {
            return rejectQuery('term-limit');
        }
        return { kind: 'string', value };
    }
    function number(): ReleaseQueryToken {
        const start = position;
        let datatype: 'integer' | 'decimal' | 'double' = 'integer';
        while (isDigit(text.charCodeAt(position))) {
            position += 1;
        }
        if (text.charCodeAt(position) === 46 && isDigit(text.charCodeAt(position + 1))) {
            datatype = 'decimal';
            position += 1;
            while (isDigit(text.charCodeAt(position))) {
                position += 1;
            }
        }
        const exponent = text.charCodeAt(position);
        if (exponent === 101 || exponent === 69) {
            let cursor = position + 1;
            if (text.charCodeAt(cursor) === 43 || text.charCodeAt(cursor) === 45) {
                cursor += 1;
            }
            if (!isDigit(text.charCodeAt(cursor))) {
                return rejectQuery('syntax');
            }
            while (isDigit(text.charCodeAt(cursor))) {
                cursor += 1;
            }
            datatype = 'double';
            position = cursor;
        }
        const lexical = text.slice(start, position);
        if (lexical.length > LIMITS.maxLiteralBytes) {
            return rejectQuery('term-limit');
        }
        if (isNameCharacter(text.charCodeAt(position))) {
            return rejectQuery('syntax');
        }
        return { kind: 'number', datatype, lexical };
    }
    function variable(): ReleaseQueryToken | null {
        const first = text.charCodeAt(position + 1);
        if (!isNameCharacter(first)) {
            return null;
        }
        if (isDigit(first)) {
            return rejectQuery('syntax');
        }
        let end = position + 1;
        while (isNameCharacter(text.charCodeAt(end))) {
            end += 1;
        }
        if (end - position - 1 > LIMITS.maxVariableLength) {
            return rejectQuery('term-limit');
        }
        const name = text.slice(position + 1, end);
        position = end;
        return { kind: 'variable', name };
    }
    function local(start: number): string {
        let end = start;
        if (isNameCharacter(text.charCodeAt(end))) {
            end += 1;
            while (isLocalCharacter(text.charCodeAt(end))) {
                end += 1;
            }
            while (text.charCodeAt(end - 1) === 46) {
                end -= 1;
            }
        }
        const after = text.charCodeAt(end);
        if (after === 92) {
            return rejectQuery('escape-forbidden');
        }
        if (after === 37 || after === 58 || after > 127) {
            return rejectQuery('syntax');
        }
        position = end;
        const value = text.slice(start, end);
        if (value.length > LIMITS.maxIriBytes) {
            return rejectQuery('term-limit');
        }
        return value;
    }
    function wordOrName(): ReleaseQueryToken {
        let end = position;
        while (isLocalCharacter(text.charCodeAt(end))) {
            end += 1;
        }
        const run = text.slice(position, end);
        if (
            text.charCodeAt(end) === 58 &&
            isAsciiLetter(run.charCodeAt(0)) &&
            !run.endsWith('.') &&
            run.length <= 128
        ) {
            const prefix = run;
            return { kind: 'pname', prefix, local: local(end + 1) };
        }
        end = position;
        while (isNameCharacter(text.charCodeAt(end))) {
            end += 1;
        }
        const value = text.slice(position, end);
        if (text.charCodeAt(end) === 58) {
            return rejectQuery('syntax');
        }
        if (value.length > 64) {
            return rejectQuery('syntax');
        }
        position = end;
        return { kind: 'word', value, upper: value.toUpperCase() };
    }
    function lexOne(): ReleaseQueryToken {
        skipTrivia();
        if (position >= text.length) {
            return { kind: 'end' };
        }
        const code = text.charCodeAt(position);
        if (code === 60) {
            return iriOrOperator();
        }
        if (code === 34 || code === 39) {
            return stringLiteral();
        }
        if (code === 63 || code === 36) {
            const found = variable();
            if (found !== null) {
                return found;
            }
            if (code === 36) {
                return rejectQuery('syntax');
            }
        }
        if (isDigit(code) || (code === 46 && isDigit(text.charCodeAt(position + 1)))) {
            return number();
        }
        if (code === 64) {
            let end = position + 1;
            while (isLocalCharacter(text.charCodeAt(end)) && text.charCodeAt(end) !== 46) {
                end += 1;
            }
            const value = text.slice(position + 1, end);
            if (!/^[A-Za-z]{1,8}(?:-[A-Za-z0-9]{1,8})*$/u.test(value.slice(0, 64))) {
                return rejectQuery(value.length > LIMITS.maxLanguageBytes ? 'term-limit' : 'syntax');
            }
            if (value.length > LIMITS.maxLanguageBytes) {
                return rejectQuery('term-limit');
            }
            position = end;
            return { kind: 'language', value };
        }
        if (code === 95 && text.charCodeAt(position + 1) === 58) {
            return rejectQuery('blank-node-forbidden');
        }
        if (code === 91) {
            return rejectQuery('blank-node-forbidden');
        }
        if (code === 58) {
            return { kind: 'pname', prefix: '', local: local(position + 1) };
        }
        if (isAsciiLetter(code) || code === 95) {
            return wordOrName();
        }
        if (code === 92) {
            return rejectQuery('syntax');
        }
        const pair = text.slice(position, position + 2);
        if (TWO_CHARACTER.has(pair)) {
            position += 2;
            return { kind: 'punct', value: pair };
        }
        const single = text.charAt(position);
        if (ONE_CHARACTER.has(single)) {
            position += 1;
            return { kind: 'punct', value: single };
        }
        return rejectQuery('syntax');
    }
    function fill(offset: number): void {
        while (buffer.length <= offset) {
            const last = buffer.at(-1);
            if (last?.kind === 'end') {
                buffer.push(last);
                continue;
            }
            const token = lexOne();
            if (token.kind !== 'end') {
                count += 1;
                if (count > LIMITS.maxTokens) {
                    rejectQuery('token-limit');
                }
            }
            buffer.push(Object.freeze(token));
        }
    }
    return Object.freeze({
        peek: (offset = 0) => {
            fill(offset);
            return buffer[offset] ?? { kind: 'end' };
        },
        next: () => {
            fill(0);
            return buffer.shift() ?? { kind: 'end' };
        },
    });
}

/** Strict UTF-8 decoding of a transport body before parsing. A BOM or malformed byte sequence is rejected. */
export function decodeReleaseQueryBytes(bytes: Uint8Array): string {
    if (!(bytes instanceof Uint8Array)) {
        return rejectQuery('encoding-invalid');
    }
    if (bytes.byteLength > LIMITS.maxQueryBytes) {
        return rejectQuery('query-too-large');
    }
    if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
        return rejectQuery('encoding-invalid');
    }
    try {
        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    } catch {
        return rejectQuery('encoding-invalid');
    }
}
