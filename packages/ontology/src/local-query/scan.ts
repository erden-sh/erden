/**
 * A lexical scan of SPARQL text: enough to tell the query form, whether `SERVICE` appears anywhere, and whether the
 * outermost query orders its solutions. It skips comments, strings, IRIs, variables, prefixed names, blank-node
 * labels and language tags, so a keyword inside any of them is never counted. It is not a parser: Oxigraph parses
 * the query and reports syntax errors; this only answers what Oxigraph's API does not expose before evaluation.
 */

export type SparqlQueryForm = 'select' | 'ask' | 'construct' | 'describe';

export interface SparqlScan {
    /** The first query or update keyword outside braces; null when there is none (Oxigraph reports the error). */
    readonly form: SparqlQueryForm | 'update' | null;
    /** `SERVICE` appears as a keyword, at any depth: local query never touches the network. */
    readonly service: boolean;
    /** The outermost query has `ORDER BY`, so its solutions have a defined order. */
    readonly ordered: boolean;
}

const FORMS: Readonly<Record<string, SparqlQueryForm | 'update'>> = Object.freeze({
    SELECT: 'select',
    ASK: 'ask',
    CONSTRUCT: 'construct',
    DESCRIBE: 'describe',
    INSERT: 'update',
    DELETE: 'update',
    LOAD: 'update',
    CLEAR: 'update',
    CREATE: 'update',
    DROP: 'update',
    COPY: 'update',
    MOVE: 'update',
    ADD: 'update',
    WITH: 'update',
});

function isNameStart(character: string): boolean {
    return /[\p{L}_]/u.test(character);
}

function isNameCharacter(character: string): boolean {
    return /[\p{L}\p{N}_\-·̀-ͯ‿-⁀]/u.test(character);
}

/** IRIREF: `<` then no `<>"{}|^\`\\` and nothing at or below U+0020, then `>`. Otherwise `<` is an operator. */
function iriEnd(text: string, start: number): number | null {
    for (let index = start + 1; index < text.length; index += 1) {
        const character = text[index] as string;
        if (character === '>') {
            return index + 1;
        }
        if (character <= ' ' || '<"{}|^`\\'.includes(character)) {
            return null;
        }
    }
    return null;
}

function stringEnd(text: string, start: number): number {
    const quote = text[start] as string;
    const long = text.startsWith(quote.repeat(3), start);
    const close = long ? quote.repeat(3) : quote;
    for (let index = start + (long ? 3 : 1); index < text.length; index += 1) {
        const character = text[index] as string;
        if (character === '\\') {
            index += 1;
        } else if (text.startsWith(close, index)) {
            return index + close.length;
        } else if (!long && (character === '\n' || character === '\r')) {
            return index;
        }
    }
    return text.length;
}

/** The end of a prefixed name's local part (PN_LOCAL, with `%xx` and `\` escapes), starting after the colon. */
function localEnd(text: string, start: number): number {
    let index = start;
    while (index < text.length) {
        const character = text[index] as string;
        if (character === '\\') {
            index += 2;
        } else if (character === '%') {
            index += 3;
        } else if (isNameCharacter(character) || character === ':') {
            index += 1;
        } else if (character === '.' && index + 1 < text.length && isNameCharacter(text[index + 1] as string)) {
            index += 1;
        } else {
            break;
        }
    }
    return index;
}

export function scanSparqlQuery(text: string): SparqlScan {
    let form: SparqlScan['form'] = null;
    let service = false;
    let ordered = false;
    let depth = 0;
    let previousWord: string | null = null;
    let index = 0;
    while (index < text.length) {
        const character = text[index] as string;
        if (character === '#') {
            while (index < text.length && text[index] !== '\n' && text[index] !== '\r') {
                index += 1;
            }
            continue;
        }
        if (character === '"' || character === "'") {
            index = stringEnd(text, index);
            previousWord = null;
            continue;
        }
        if (character === '<') {
            index = iriEnd(text, index) ?? index + 1;
            previousWord = null;
            continue;
        }
        if (character === '{') {
            depth += 1;
            index += 1;
            previousWord = null;
            continue;
        }
        if (character === '}') {
            depth = Math.max(0, depth - 1);
            index += 1;
            previousWord = null;
            continue;
        }
        if ((character === '?' || character === '$' || character === '@') && index + 1 < text.length) {
            // A variable or a language tag; a lone `?` is a path modifier.
            let end = index + 1;
            while (end < text.length && (isNameCharacter(text[end] as string) || text[end] === '-')) {
                end += 1;
            }
            index = Math.max(end, index + 1);
            previousWord = null;
            continue;
        }
        if (character === '_' && text[index + 1] === ':') {
            index = localEnd(text, index + 2);
            previousWord = null;
            continue;
        }
        if (character === ':') {
            index = localEnd(text, index + 1);
            previousWord = null;
            continue;
        }
        if (isNameStart(character)) {
            let end = index + 1;
            while (end < text.length && (isNameCharacter(text[end] as string) || text[end] === '.')) {
                if (text[end] === '.' && !(end + 1 < text.length && isNameCharacter(text[end + 1] as string))) {
                    break;
                }
                end += 1;
            }
            if (text[end] === ':') {
                index = localEnd(text, end + 1);
                previousWord = null;
                continue;
            }
            const word = text.slice(index, end).toUpperCase();
            if (word === 'SERVICE') {
                service = true;
            }
            if (depth === 0) {
                if (form === null && word in FORMS) {
                    form = FORMS[word] ?? null;
                }
                if (word === 'BY' && previousWord === 'ORDER') {
                    ordered = true;
                }
            }
            previousWord = word;
            index = end;
            continue;
        }
        if (!/\s/u.test(character)) {
            previousWord = null;
        }
        index += 1;
    }
    return Object.freeze({ form, service, ordered });
}
