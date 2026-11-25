import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, posix, win32 } from 'node:path';

import {
    inferredDeltaQuads,
    localQueryNTriples,
    type AssembledOntology,
    type ReasonedOntology,
    type ReasonerLimits,
} from '@erden/ontology';

/**
 * The last inferences of a project, keyed by a digest of everything reasoning reads: the reasoner and the exact
 * sources. `erden check` and `erden query` write an entry whenever reasoning succeeds, and `erden query` reuses it
 * while the sources are unchanged, so an entailed answer does not cost a full reasoning run each time. An entry
 * holds only proof-checked inferences, exactly as the run that wrote it materialized them.
 *
 * A refused or failed reasoning run is kept too, keyed by the same digest and the reasoner limits, when its outcome
 * follows from the inputs and the reasoner alone (a limit, an inconsistency), so a query on a project the
 * reasoner refuses does not try again each time. Failures of the machine (a crash, a timeout) are never kept.
 */

export const ENTAILMENT_CACHE_SCHEMA = 'erden.entailment-cache/v1' as const;
/** The most entries kept; the oldest beyond it are removed after each write. */
export const ENTAILMENT_CACHE_ENTRIES = 32;

export interface EntailedCacheEntry {
    readonly schema: typeof ENTAILMENT_CACHE_SCHEMA;
    readonly key: string;
    readonly outcome: 'entailed';
    readonly reasoner: Readonly<{ name: string; version: string; calculusDigest: string }>;
    readonly profile: Readonly<{ id: string; digest: string }>;
    /** The reasoner request's digest and the checked certificate's, as the check report names them. */
    readonly inputDigest: string;
    readonly certificateDigest: string;
    /** Statements outside the reasoner's profile that the project's `report` policy left out of reasoning. */
    readonly outsideProfileStatements: number;
    /** The inferred statements that are not also asserted, as N-Triples, one per line. */
    readonly ntriples: string;
    readonly ntriplesSha256: string;
    readonly statementCount: number;
}

export interface UnavailableCacheEntry {
    readonly schema: typeof ENTAILMENT_CACHE_SCHEMA;
    readonly key: string;
    readonly outcome: 'unavailable';
    readonly limits: ReasonerLimits;
    /** The failure code `erden check` reports for the same inputs. */
    readonly cause: string;
}

export type EntailmentCacheEntry = EntailedCacheEntry | UnavailableCacheEntry;

export interface EntailmentCachePort {
    readonly readEntailed: (key: string) => EntailedCacheEntry | null;
    readonly readUnavailable: (key: string, limits: ReasonerLimits) => UnavailableCacheEntry | null;
    /** Never throws: a cache that cannot be written is a cache miss next time. */
    readonly write: (entry: EntailmentCacheEntry) => void;
}

export const disabledEntailmentCache: EntailmentCachePort = Object.freeze({
    readEntailed: () => null,
    readUnavailable: () => null,
    write: () => undefined,
});

function sha256(text: string): string {
    return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * The cache key: the reasoner's identity and, for every source in assembly order, its id, file, owner, format, base
 * IRI, outside-profile policy and content digest. Equal keys mean byte-identical reasoner input.
 */
export function entailmentCacheKey(
    reasoner: Readonly<{ version: string; sha256: string }>,
    graph: AssembledOntology,
): string {
    const sources = graph.sources.map(({ descriptor, contentDigest }) => [
        descriptor.id,
        descriptor.locator,
        descriptor.owner.canonicalIri,
        descriptor.owner.role,
        [...descriptor.owner.ownedIriPrefixes],
        descriptor.mediaType,
        descriptor.baseIri,
        descriptor.outsideProfile ?? 'refuse',
        contentDigest,
    ]);
    return `sha256:${sha256(JSON.stringify([ENTAILMENT_CACHE_SCHEMA, reasoner.version, reasoner.sha256, sources]))}`;
}

function limitsKey(limits: ReasonerLimits): string {
    return sha256(
        JSON.stringify([limits.maxWallTimeMs, limits.maxInputAxioms, limits.maxInferences, limits.maxRequestBytes]),
    ).slice(0, 16);
}

function fileName(entry: Readonly<{ key: string }>, limits?: ReasonerLimits): string {
    const hex = entry.key.slice('sha256:'.length);
    return limits === undefined ? `${hex}.json` : `${hex}.unavailable-${limitsKey(limits)}.json`;
}

function isText(value: unknown): value is string {
    return typeof value === 'string' && value.length > 0;
}

function decodeEntailed(value: unknown, key: string): EntailedCacheEntry | null {
    const entry = value as Partial<Record<keyof EntailedCacheEntry, unknown>> | null;
    if (
        entry === null ||
        typeof entry !== 'object' ||
        entry.schema !== ENTAILMENT_CACHE_SCHEMA ||
        entry.key !== key ||
        entry.outcome !== 'entailed' ||
        typeof entry.ntriples !== 'string' ||
        entry.ntriplesSha256 !== sha256(entry.ntriples) ||
        !Number.isSafeInteger(entry.statementCount) ||
        !Number.isSafeInteger(entry.outsideProfileStatements) ||
        !isText(entry.inputDigest) ||
        !isText(entry.certificateDigest)
    ) {
        return null;
    }
    const reasoner = entry.reasoner as Partial<Record<string, unknown>> | null | undefined;
    const profile = entry.profile as Partial<Record<string, unknown>> | null | undefined;
    if (
        typeof reasoner !== 'object' ||
        reasoner === null ||
        !isText(reasoner.name) ||
        !isText(reasoner.version) ||
        !isText(reasoner.calculusDigest) ||
        typeof profile !== 'object' ||
        profile === null ||
        !isText(profile.id) ||
        !isText(profile.digest)
    ) {
        return null;
    }
    return Object.freeze({
        schema: ENTAILMENT_CACHE_SCHEMA,
        key,
        outcome: 'entailed',
        reasoner: Object.freeze({
            name: reasoner.name,
            version: reasoner.version,
            calculusDigest: reasoner.calculusDigest,
        }),
        profile: Object.freeze({ id: profile.id, digest: profile.digest }),
        inputDigest: entry.inputDigest,
        certificateDigest: entry.certificateDigest,
        outsideProfileStatements: entry.outsideProfileStatements as number,
        ntriples: entry.ntriples,
        ntriplesSha256: entry.ntriplesSha256,
        statementCount: entry.statementCount as number,
    });
}

function decodeUnavailable(value: unknown, key: string, limits: ReasonerLimits): UnavailableCacheEntry | null {
    const entry = value as Partial<Record<keyof UnavailableCacheEntry, unknown>> | null;
    const stored = entry?.limits as Partial<Record<keyof ReasonerLimits, unknown>> | null | undefined;
    if (
        entry === null ||
        typeof entry !== 'object' ||
        entry.schema !== ENTAILMENT_CACHE_SCHEMA ||
        entry.key !== key ||
        entry.outcome !== 'unavailable' ||
        !isText(entry.cause) ||
        typeof stored !== 'object' ||
        stored === null ||
        stored.maxWallTimeMs !== limits.maxWallTimeMs ||
        stored.maxInputAxioms !== limits.maxInputAxioms ||
        stored.maxInferences !== limits.maxInferences ||
        stored.maxRequestBytes !== limits.maxRequestBytes
    ) {
        return null;
    }
    return Object.freeze({ schema: ENTAILMENT_CACHE_SCHEMA, key, outcome: 'unavailable', limits, cause: entry.cause });
}

/**
 * The cache directory: `$XDG_CACHE_HOME/erden/entailments/v1` or `~/.cache/erden/entailments/v1`, and
 * `%LOCALAPPDATA%\Erden\cache\entailments\v1` on Windows. Undefined when the environment names no home.
 */
export function defaultEntailmentCacheDirectory(
    environment: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
    home: string | undefined,
): string | undefined {
    if (platform === 'win32') {
        const local = environment.LOCALAPPDATA;
        return local !== undefined && local.length > 0 && win32.isAbsolute(local)
            ? win32.join(local, 'Erden', 'cache', 'entailments', 'v1')
            : undefined;
    }
    const xdg = environment.XDG_CACHE_HOME;
    if (xdg !== undefined && xdg.length > 0 && posix.isAbsolute(xdg)) {
        return posix.join(xdg, 'erden', 'entailments', 'v1');
    }
    return home !== undefined && home.length > 0 && posix.isAbsolute(home)
        ? posix.join(home, '.cache', 'erden', 'entailments', 'v1')
        : undefined;
}

function readJson(path: string): unknown {
    try {
        return JSON.parse(readFileSync(path, 'utf8')) as unknown;
    } catch {
        return null;
    }
}

function prune(directory: string): void {
    const entries = readdirSync(directory)
        .filter((name) => name.endsWith('.json'))
        .map((name) => {
            const path = join(directory, name);
            return { path, modified: statSync(path).mtimeMs };
        })
        .sort((left, right) => right.modified - left.modified);
    for (const stale of entries.slice(ENTAILMENT_CACHE_ENTRIES)) {
        rmSync(stale.path, { force: true });
    }
}

/** The cache in `directory`, created on first write; a directory that is not absolute disables it. */
export function makeNodeEntailmentCache(directory: string | undefined): EntailmentCachePort {
    if (directory === undefined || !isAbsolute(directory)) {
        return disabledEntailmentCache;
    }
    return Object.freeze({
        readEntailed: (key: string) => decodeEntailed(readJson(join(directory, fileName({ key }))), key),
        readUnavailable: (key: string, limits: ReasonerLimits) =>
            decodeUnavailable(readJson(join(directory, fileName({ key }, limits))), key, limits),
        write: (entry: EntailmentCacheEntry) => {
            try {
                mkdirSync(directory, { recursive: true, mode: 0o700 });
                const target = join(
                    directory,
                    fileName(entry, entry.outcome === 'unavailable' ? entry.limits : undefined),
                );
                const temporary = join(directory, `.${randomBytes(8).toString('hex')}.tmp`);
                writeFileSync(temporary, JSON.stringify(entry), { mode: 0o600 });
                renameSync(temporary, target);
                prune(directory);
            } catch {
                // A read-only or full disk only costs the next query a reasoning run.
            }
        },
    });
}

export function nodeEntailmentCache(): EntailmentCachePort {
    return makeNodeEntailmentCache(defaultEntailmentCacheDirectory(process.env, process.platform, homedir()));
}

/** The entry a successful reasoning run leaves in the entailment cache. */
export function entailedCacheEntry(
    key: string,
    reasoned: ReasonedOntology,
    outsideProfileStatements: number,
): EntailedCacheEntry {
    const ntriples = localQueryNTriples(inferredDeltaQuads(reasoned));
    const reasoning = reasoned.reasoning;
    return Object.freeze({
        schema: 'erden.entailment-cache/v1',
        key,
        outcome: 'entailed',
        reasoner: Object.freeze({
            name: reasoning.tool.name,
            version: reasoning.tool.version,
            calculusDigest: reasoning.tool.calculusDigest,
        }),
        profile: Object.freeze({ id: reasoning.profileId, digest: reasoning.profileDigest }),
        inputDigest: reasoning.inputDigest,
        certificateDigest: reasoning.certificate.certificateDigest,
        outsideProfileStatements,
        ntriples,
        ntriplesSha256: sha256(ntriples),
        statementCount: ntriples.length === 0 ? 0 : ntriples.split('\n').length - 1,
    });
}
