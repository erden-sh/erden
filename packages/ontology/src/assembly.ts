import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { Effect } from 'effect';
import { Store, type Quad, type Term } from 'n3';

import {
    OntologyAssemblyLimitError,
    OntologySourceParseError,
    OntologySourceRefusedError,
    RequiredStageUnavailableError,
    TurtleSourceEncodingError,
    TurtleSourceParseError,
    UnsupportedSemanticFormatError,
} from './errors.js';
import type {
    AssembledOntology,
    LoadedTurtleSource,
    QuadContributor,
    QuadProvenance,
    TurtleSourceDescriptor,
} from './model.js';
import { compareCodePoints } from './order.js';
import type { TextResourcePort } from './ports.js';
import { parseOntologySourceText } from './source-formats/parse.js';

function termKey(term: Term): string {
    switch (term.termType) {
        case 'NamedNode':
            return `N${String(term.value.length)}:${term.value}`;
        case 'BlankNode':
            return `B${String(term.value.length)}:${term.value}`;
        case 'Variable':
            return `V${String(term.value.length)}:${term.value}`;
        case 'DefaultGraph':
            return 'D';
        case 'Literal':
            return `L${JSON.stringify([
                term.value,
                term.language,
                term.datatype.value,
                'direction' in term ? term.direction : '',
            ])}`;
    }
}

export function quadKey(quad: Quad): string {
    return [termKey(quad.subject), termKey(quad.predicate), termKey(quad.object), termKey(quad.graph)].join('|');
}

/**
 * Parses one Turtle source exactly as Erden always has. Multi-format callers use `parseOntologySourceText`,
 * which routes `.ttl` through this same n3 path.
 */
export function parseTurtleSource(
    descriptor: TurtleSourceDescriptor,
    text: string,
    maximumQuads?: number,
): ReadonlyArray<Quad> {
    if (maximumQuads !== undefined && (!Number.isSafeInteger(maximumQuads) || maximumQuads < 0)) {
        throw new OntologyAssemblyLimitError('statements');
    }
    if (!descriptor.locator.toLowerCase().endsWith('.ttl')) {
        throw new UnsupportedSemanticFormatError('source', descriptor.locator, '.ttl');
    }
    return parseOntologySourceText(descriptor, text, maximumQuads);
}

interface MutableQuadProvenance {
    readonly quad: Quad;
    readonly asserted: Array<
        QuadContributor & { readonly provenance: { readonly _tag: 'Asserted'; readonly revision?: string } }
    >;
    readonly inferred: Array<
        QuadContributor & {
            readonly provenance: {
                readonly _tag: 'Inferred';
                readonly reasoner: string;
                readonly operation: string;
                readonly premises: ReadonlyArray<string>;
            };
        }
    >;
}

export type AssembleOntologyError =
    | OntologyAssemblyLimitError
    | OntologySourceParseError
    | OntologySourceRefusedError
    | RequiredStageUnavailableError
    | TurtleSourceEncodingError
    | TurtleSourceParseError
    | UnsupportedSemanticFormatError;

export interface OntologyAssemblyLimits {
    readonly maximumSourceBytes: number;
    readonly maximumStatements: number;
}

export function assembleOntology(
    resources: TextResourcePort,
    descriptors: ReadonlyArray<TurtleSourceDescriptor>,
    limits?: OntologyAssemblyLimits,
): Effect.Effect<AssembledOntology, AssembleOntologyError> {
    return assembleOntologyWith(resources, descriptors, limits, null).pipe(Effect.map(({ graph }) => graph));
}

/** A source a tolerant assembly left out because it could not be decoded or parsed. */
export interface UnparsedOntologySource {
    readonly sourceId: string;
    readonly locator: string;
    /** Where the error is, when the parser reports it. */
    readonly line: number | null;
    readonly column: number | null;
    readonly code: string;
    readonly message: string;
}

export type UnparsableSourceError =
    | OntologySourceParseError
    | OntologySourceRefusedError
    | TurtleSourceEncodingError
    | TurtleSourceParseError
    | UnsupportedSemanticFormatError;

function unparsedSource(descriptor: TurtleSourceDescriptor, cause: UnparsableSourceError): UnparsedOntologySource {
    const location = 'location' in cause ? cause.location : undefined;
    const line = typeof location?.line === 'number' ? location.line : null;
    const column = typeof location?.column === 'number' ? location.column : null;
    // The parser's message starts with the file and position, which the fields already hold.
    const prefix = `${descriptor.locator}${line === null ? '' : `:${String(line)}`}${column === null ? '' : `:${String(column)}`} `;
    return Object.freeze({
        sourceId: descriptor.id,
        locator: descriptor.locator,
        line,
        column,
        code: cause.code,
        message: cause.message.startsWith(prefix) ? cause.message.slice(prefix.length) : cause.message,
    });
}

/**
 * Assembles every source that decodes and parses, and lists the others instead of failing: what a query over a
 * broken project answers from. The assembled graph is the one `assembleOntology` would give for the parsed sources
 * alone, in their order; no source is required.
 */
export function assembleOntologyTolerant(
    resources: TextResourcePort,
    descriptors: ReadonlyArray<TurtleSourceDescriptor>,
    limits?: OntologyAssemblyLimits,
): Effect.Effect<
    Readonly<{ graph: AssembledOntology; unparsed: ReadonlyArray<UnparsedOntologySource> }>,
    AssembleOntologyError
> {
    const unparsed: UnparsedOntologySource[] = [];
    return assembleOntologyWith(resources, descriptors, limits, (descriptor, cause) => {
        unparsed.push(unparsedSource(descriptor, cause));
    }).pipe(Effect.map(({ graph }) => Object.freeze({ graph, unparsed: Object.freeze(unparsed) })));
}

function assembleOntologyWith(
    resources: TextResourcePort,
    descriptors: ReadonlyArray<TurtleSourceDescriptor>,
    limits: OntologyAssemblyLimits | undefined,
    skip: ((descriptor: TurtleSourceDescriptor, cause: UnparsableSourceError) => void) | null,
): Effect.Effect<Readonly<{ graph: AssembledOntology }>, AssembleOntologyError> {
    const maximumSourceBytes = limits?.maximumSourceBytes;
    const maximumStatements = limits?.maximumStatements;
    return Effect.gen(function* () {
        if (
            limits !== undefined &&
            (!Number.isSafeInteger(maximumSourceBytes) ||
                (maximumSourceBytes ?? -1) < 0 ||
                !Number.isSafeInteger(maximumStatements) ||
                (maximumStatements ?? -1) < 0)
        ) {
            return yield* Effect.fail(new OntologyAssemblyLimitError('bytes'));
        }
        if (descriptors.length === 0 && skip === null) {
            return yield* Effect.fail(
                new RequiredStageUnavailableError(
                    'source',
                    null,
                    'at least one ordered Turtle source descriptor is required',
                ),
            );
        }
        const dataset = new Store();
        const loaded: LoadedTurtleSource[] = [];
        const byQuad = new Map<string, MutableQuadProvenance>();
        let sourceBytes = 0;
        let statements = 0;
        for (let descriptorIndex = 0; descriptorIndex < descriptors.length; descriptorIndex += 1) {
            const descriptor = descriptors[descriptorIndex];
            // The index among assembled sources: a source a tolerant assembly leaves out takes none.
            const sourceIndex = loaded.length;
            if (descriptor === undefined) {
                continue;
            }
            const bytes = yield* resources
                .readBytes(descriptor.locator)
                .pipe(
                    Effect.mapError((cause) => new RequiredStageUnavailableError('source', descriptor.locator, cause)),
                );
            const decoded = yield* Effect.result(
                Effect.try({
                    try: () => {
                        sourceBytes += bytes.byteLength;
                        if (maximumSourceBytes !== undefined && sourceBytes > maximumSourceBytes) {
                            throw new OntologyAssemblyLimitError('bytes');
                        }
                        return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes);
                    },
                    catch: (cause) =>
                        cause instanceof OntologyAssemblyLimitError
                            ? cause
                            : new TurtleSourceEncodingError(descriptor.id, descriptor.locator, cause),
                }),
            );
            if (decoded._tag === 'Failure') {
                if (skip !== null && decoded.failure instanceof TurtleSourceEncodingError) {
                    skip(descriptor, decoded.failure);
                    continue;
                }
                return yield* Effect.fail(decoded.failure);
            }
            const text = decoded.success;
            const parsed = yield* Effect.result(
                Effect.try({
                    try: () =>
                        parseOntologySourceText(
                            descriptor,
                            text,
                            maximumStatements === undefined ? undefined : maximumStatements - statements,
                        ),
                    catch: (
                        cause,
                    ):
                        | TurtleSourceParseError
                        | OntologySourceParseError
                        | OntologySourceRefusedError
                        | UnsupportedSemanticFormatError
                        | OntologyAssemblyLimitError => {
                        if (
                            cause instanceof TurtleSourceParseError ||
                            cause instanceof OntologySourceParseError ||
                            cause instanceof OntologySourceRefusedError ||
                            cause instanceof UnsupportedSemanticFormatError ||
                            cause instanceof OntologyAssemblyLimitError
                        ) {
                            return cause;
                        }
                        return new TurtleSourceParseError(
                            descriptor.id,
                            { file: descriptor.locator, line: 1, column: 1 },
                            cause,
                        );
                    },
                }),
            );
            if (parsed._tag === 'Failure') {
                if (skip !== null && !(parsed.failure instanceof OntologyAssemblyLimitError)) {
                    skip(descriptor, parsed.failure);
                    continue;
                }
                return yield* Effect.fail(parsed.failure);
            }
            const quads = parsed.success;
            statements += quads.length;
            loaded.push({
                descriptor,
                sourceIndex,
                tripleCount: quads.length,
                contentDigest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                bytes: Uint8Array.from(bytes),
                text,
            });
            const contributor: QuadContributor = {
                sourceId: descriptor.id,
                sourceIndex,
                owner: descriptor.owner,
                locator: descriptor.locator,
                provenance: descriptor.provenance,
            };
            for (const quad of quads) {
                dataset.addQuad(quad);
                const key = quadKey(quad);
                let provenance = byQuad.get(key);
                if (provenance === undefined) {
                    provenance = { quad, asserted: [], inferred: [] };
                    byQuad.set(key, provenance);
                }
                if (descriptor.provenance._tag === 'Asserted') {
                    if (!provenance.asserted.some((entry) => entry.sourceIndex === sourceIndex)) {
                        provenance.asserted.push({ ...contributor, provenance: descriptor.provenance });
                    }
                } else {
                    if (!provenance.inferred.some((entry) => entry.sourceIndex === sourceIndex)) {
                        provenance.inferred.push({ ...contributor, provenance: descriptor.provenance });
                    }
                }
            }
        }
        const provenance: QuadProvenance[] = [...byQuad]
            .sort(([left], [right]) => compareCodePoints(left, right))
            .map(([key, value]) => ({
                key,
                quad: value.quad,
                asserted: value.asserted,
                inferred: value.inferred,
            }));
        return { graph: { dataset, sources: loaded, provenance } };
    });
}
