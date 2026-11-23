import { createHash } from 'node:crypto';
import { TextDecoder } from 'node:util';

import { Effect } from 'effect';
import { DataFactory, Parser, Store, type Quad, type Term } from 'n3';

import { quadKey } from './assembly.js';
import {
    RequiredStageUnavailableError,
    ShaclEngineError,
    ShaclEngineUnavailableError,
    ShaclLimitsError,
    ShaclRefusedError,
    TurtleSourceParseError,
    UnsupportedSemanticFormatError,
} from './errors.js';
import {
    RDF,
    RDFS,
    SHACL,
    SHAPE_EXTENSIONS,
    type AssembledOntology,
    type LoadedShapeSource,
    type ProjectSourceOwner,
    type ShaclFinding,
    type ShaclValidation,
    type ShapeSelfTestResult,
    type ShapeSourceDescriptor,
    type ShapeSummary,
    type UnsupportedShaclConstruct,
} from './model.js';
import { compareCodePoints } from './order.js';
import type { TextResourcePort } from './ports.js';
import { shaclFindingMessage, shaclPathText, shaclTermText } from './shacl-engine/messages.js';
import { nodeShaclEnginePort, type ShaclEnginePort } from './shacl-engine/port.js';
import type { ShaclProcessError } from './shacl-engine/process.js';
import {
    encodeShaclRequest,
    prepareShaclShapes,
    ShaclAnswerUntrustedError,
    ShaclRequestEncodingError,
    type ShaclAnswerReport,
    type ShaclAnswerResult,
    type ShaclRefusal,
} from './shacl-engine/protocol.js';
import { indexShaclShapes, shaclReportQuads, shaclSourceConstraint } from './shacl-engine/report.js';
import {
    captureShaclEvidence,
    captureShaclSelfTests,
    type ShaclSelfTestEvidence,
    type ShaclEvidence,
} from './shacl-evidence/index.js';
import { findUnsupportedShaclConstructs } from './shacl-support.js';
import { locateTurtleText } from './source-formats/positions.js';

function namedNode(value: string) {
    return DataFactory.namedNode(value);
}
const RDF_TYPE = namedNode(`${RDF}type`);
const RDFS_SUBCLASS = namedNode(`${RDFS}subClassOf`);
const SH_NODE_SHAPE = namedNode(`${SHACL}NodeShape`);
const SH_PROPERTY_SHAPE = namedNode(`${SHACL}PropertyShape`);
const SH_PROPERTY = namedNode(`${SHACL}property`);
const SELFTEST_FIXTURE = namedNode(`${SHAPE_EXTENSIONS}selftestFixture`);

interface RdfTermLike {
    readonly termType: string;
    readonly value: string;
}

function termKey(term: RdfTermLike): string {
    return `${term.termType}:${term.value}`;
}

function localName(value: string): string {
    return value.replace(/^.*[#/]/u, '');
}

function parseLocation(
    locator: string,
    cause: unknown,
): {
    readonly file: string;
    readonly line: number;
    readonly column: number;
} {
    const context =
        cause !== null && typeof cause === 'object' && 'context' in cause
            ? (
                  cause as {
                      readonly context?: {
                          readonly line?: unknown;
                          readonly token?: {
                              readonly start?: unknown;
                          };
                      };
                  }
              ).context
            : undefined;
    return {
        file: locator,
        line: typeof context?.line === 'number' ? context.line : 1,
        column: (typeof context?.token?.start === 'number' ? context.token.start : 0) + 1,
    };
}

function prefixesFrom(text: string): ReadonlyMap<string, string> {
    const prefixes = new Map<string, string>();
    for (const match of text.matchAll(/(?:@prefix|PREFIX)\s+([A-Za-z][\w-]*|):\s*<([^>]*)>\s*\.?/giu)) {
        const name = match[1];
        const iri = match[2];
        if (name !== undefined && iri !== undefined && !prefixes.has(name)) {
            prefixes.set(name, iri);
        }
    }
    return prefixes;
}

interface ParsedShapeSource {
    readonly descriptor: ShapeSourceDescriptor;
    readonly text: string;
    readonly quads: ReadonlyArray<Quad>;
    readonly prefixes: ReadonlyMap<string, string>;
    readonly contentDigest: string;
}

interface ParsedShapes {
    readonly dataset: Store;
    readonly quads: ReadonlyArray<Quad>;
    readonly sources: ReadonlyArray<ParsedShapeSource>;
    readonly sourceByShape: ReadonlyMap<string, ReadonlyArray<ShapeSourceDescriptor>>;
    readonly ownerByPropertyShape: ReadonlyMap<string, Term>;
}

function addUniqueSource(
    map: Map<string, ShapeSourceDescriptor[]>,
    key: string,
    descriptor: ShapeSourceDescriptor,
): void {
    const sources = map.get(key) ?? [];
    if (!sources.some((source) => source.id === descriptor.id)) {
        sources.push(descriptor);
    }
    map.set(key, sources);
}

function isLoadedShapeSource(source: ShapeSourceDescriptor): source is LoadedShapeSource {
    return 'bytes' in source && 'contentDigest' in source && 'text' in source;
}

function loadShapes(
    resources: TextResourcePort,
    descriptors: ReadonlyArray<ShapeSourceDescriptor>,
    required: boolean,
): Effect.Effect<
    ParsedShapes | null,
    RequiredStageUnavailableError | TurtleSourceParseError | UnsupportedSemanticFormatError
> {
    return Effect.gen(function* () {
        if (descriptors.length === 0) {
            if (required) {
                return yield* Effect.fail(
                    new RequiredStageUnavailableError('shacl', null, 'no shape source descriptors were supplied'),
                );
            }
            return null;
        }
        const parsedSources: ParsedShapeSource[] = [];
        const allQuads: Quad[] = [];
        const dataset = new Store();
        const sourceByShape = new Map<string, ShapeSourceDescriptor[]>();
        const ownerByPropertyShape = new Map<string, Term>();
        for (let index = 0; index < descriptors.length; index += 1) {
            const descriptor = descriptors[index];
            if (descriptor === undefined) {
                continue;
            }
            if (!descriptor.locator.toLowerCase().endsWith('.ttl')) {
                return yield* Effect.fail(new UnsupportedSemanticFormatError('shacl', descriptor.locator, '.ttl'));
            }
            const bytes = isLoadedShapeSource(descriptor)
                ? Uint8Array.from(descriptor.bytes)
                : yield* resources
                      .readBytes(descriptor.locator)
                      .pipe(
                          Effect.mapError(
                              (cause) => new RequiredStageUnavailableError('shacl', descriptor.locator, cause),
                          ),
                      );
            let text: string;
            try {
                text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                return yield* Effect.fail(
                    new RequiredStageUnavailableError(
                        'shacl',
                        descriptor.locator,
                        'the SHACL source is not valid UTF-8',
                    ),
                );
            }
            const contentDigest = `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
            if (
                isLoadedShapeSource(descriptor) &&
                (descriptor.contentDigest !== contentDigest || descriptor.text !== text)
            ) {
                return yield* Effect.fail(
                    new RequiredStageUnavailableError(
                        'shacl',
                        descriptor.locator,
                        'the loaded SHACL source no longer matches its exact byte snapshot',
                    ),
                );
            }
            let quads: ReadonlyArray<Quad>;
            try {
                quads = new Parser({
                    baseIRI: descriptor.baseIri,
                    blankNodePrefix: shapeBlankNodePrefix(index),
                    format: 'text/turtle',
                    factory: DataFactory,
                }).parse(text);
            } catch (cause) {
                return yield* Effect.fail(
                    new TurtleSourceParseError(descriptor.id, parseLocation(descriptor.locator, cause), cause),
                );
            }
            parsedSources.push({
                descriptor,
                text,
                quads,
                prefixes: prefixesFrom(text),
                contentDigest,
            });
            allQuads.push(...quads);
            dataset.addQuads([...quads]);
            for (const quad of quads) {
                if (
                    quad.predicate.equals(RDF_TYPE) &&
                    (quad.object.equals(SH_NODE_SHAPE) || quad.object.equals(SH_PROPERTY_SHAPE))
                ) {
                    addUniqueSource(sourceByShape, termKey(quad.subject), descriptor);
                }
            }
        }
        for (const quad of dataset.getQuads(null, SH_PROPERTY, null, null)) {
            ownerByPropertyShape.set(termKey(quad.object), quad.subject);
            for (const source of sourceByShape.get(termKey(quad.subject)) ?? []) {
                addUniqueSource(sourceByShape, termKey(quad.object), source);
            }
        }
        return {
            dataset,
            quads: allQuads,
            sources: parsedSources,
            sourceByShape,
            ownerByPropertyShape,
        };
    });
}

interface Target {
    readonly kind: ShapeSummary['targetKind'];
    readonly term: Term | null;
}

function targetFor(shapes: Store, shape: Term): Target {
    const candidates = [
        ['targetClass', `${SHACL}targetClass`],
        ['targetSubjectsOf', `${SHACL}targetSubjectsOf`],
        ['targetObjectsOf', `${SHACL}targetObjectsOf`],
    ] as const;
    for (const [kind, predicate] of candidates) {
        const term = shapes.getQuads(shape, namedNode(predicate), null, null)[0]?.object;
        if (term !== undefined) {
            return { kind, term };
        }
    }
    return { kind: 'none', term: null };
}

function descendantClasses(data: Store, shapes: Store, root: Term): ReadonlyArray<Term> {
    const found = new Map<string, Term>([[termKey(root), root]]);
    const pending = [root];
    while (pending.length > 0) {
        const parent = pending.shift();
        if (parent === undefined) {
            continue;
        }
        for (const store of [data, shapes]) {
            for (const quad of store.getQuads(null, RDFS_SUBCLASS, parent, null)) {
                const key = termKey(quad.subject);
                if (!found.has(key)) {
                    found.set(key, quad.subject);
                    pending.push(quad.subject);
                }
            }
        }
    }
    return [...found.values()];
}

function targetCount(data: Store, shapes: Store, target: Target): number {
    if (target.term === null) {
        return 0;
    }
    if (target.kind === 'targetClass') {
        const nodes = new Set<string>();
        for (const type of descendantClasses(data, shapes, target.term)) {
            for (const quad of data.getQuads(null, RDF_TYPE, type, null)) {
                nodes.add(termKey(quad.subject));
            }
        }
        return nodes.size;
    }
    if (target.kind === 'targetSubjectsOf') {
        return new Set(data.getQuads(null, target.term, null, null).map((quad) => termKey(quad.subject))).size;
    }
    if (target.kind === 'targetObjectsOf') {
        return new Set(data.getQuads(null, target.term, null, null).map((quad) => termKey(quad.object))).size;
    }
    return 0;
}

function distinctOwners(sources: ReadonlyArray<ShapeSourceDescriptor>): ReadonlyArray<ProjectSourceOwner> {
    const owners = new Map<string, ProjectSourceOwner>();
    for (const source of sources) {
        owners.set(`${source.owner.role}:${source.owner.canonicalIri}`, source.owner);
    }
    return [...owners.values()].sort(
        (left, right) =>
            compareCodePoints(left.role, right.role) || compareCodePoints(left.canonicalIri, right.canonicalIri),
    );
}

/**
 * The shape a result is reported under: the outermost shape that holds its source shape through a chain of
 * `sh:property`, or the source shape itself, so a finding never names a property shape held inside another shape.
 */
function sourceShapeOwner(parsed: ParsedShapes, sourceShape: RdfTermLike): RdfTermLike {
    let owner = sourceShape;
    const seen = new Set<string>([termKey(owner)]);
    let next = parsed.ownerByPropertyShape.get(termKey(owner));
    while (next !== undefined && !seen.has(termKey(next))) {
        seen.add(termKey(next));
        owner = next;
        next = parsed.ownerByPropertyShape.get(termKey(owner));
    }
    return owner;
}

function descriptorsForShape(parsed: ParsedShapes, shape: RdfTermLike): ReadonlyArray<ShapeSourceDescriptor> {
    return parsed.sourceByShape.get(termKey(shape)) ?? [];
}

function severityName(value: string): string {
    return localName(value);
}

function prefixHeader(sources: ReadonlyArray<ParsedShapeSource>): string {
    const prefixes = new Map<string, string>();
    for (const source of sources) {
        for (const [name, iri] of source.prefixes) {
            if (!prefixes.has(name)) {
                prefixes.set(name, iri);
            }
        }
    }
    return [...prefixes]
        .sort(([left], [right]) => compareCodePoints(left, right))
        .map(([name, iri]) => `@prefix ${name}: <${iri}> .`)
        .join('\n');
}

function declaredShapeTerms(shapes: Store): ReadonlyArray<Term> {
    const declared = new Map<string, Term>();
    for (const shapeType of [SH_NODE_SHAPE, SH_PROPERTY_SHAPE]) {
        for (const quad of shapes.getQuads(null, RDF_TYPE, shapeType, null)) {
            declared.set(termKey(quad.subject), quad.subject);
        }
    }
    return [...declared.values()].sort((left, right) => compareCodePoints(termKey(left), termKey(right)));
}

const RDF_FIRST = namedNode(`${RDF}first`);
const RDF_REST = namedNode(`${RDF}rest`);
const RDF_NIL = `${RDF}nil`;
const SH_PARAMETER = namedNode(`${SHACL}parameter`);
const SH_PATH = namedNode(`${SHACL}path`);
/** The SHACL Core targets (section 2.1.3) and the SHACL-SPARQL custom target. */
const TARGET_PREDICATES = ['targetClass', 'targetNode', 'targetSubjectsOf', 'targetObjectsOf', 'target'].map((name) =>
    namedNode(`${SHACL}${name}`),
);
/** Parameters whose value is one shape that the declaring shape validates value nodes against. */
const SHAPE_REFERENCE_PREDICATES = ['property', 'node', 'not', 'qualifiedValueShape'].map((name) =>
    namedNode(`${SHACL}${name}`),
);
/** Parameters whose value is a SHACL list of shapes. */
const SHAPE_LIST_PREDICATES = ['and', 'or', 'xone'].map((name) => namedNode(`${SHACL}${name}`));
/**
 * Every parameter of the SHACL Core constraint components (section 4), plus `sh:sparql`, `sh:js` and `sh:expression`.
 * A shape declares a constraint only through these or through a parameter the shapes graph itself declares with
 * `sh:parameter` (section 2.1.1); targets, messages, severities and annotations declare none.
 */
const CORE_CONSTRAINT_PARAMETERS = new Set(
    [
        'class',
        'datatype',
        'nodeKind',
        'minCount',
        'maxCount',
        'minExclusive',
        'minInclusive',
        'maxExclusive',
        'maxInclusive',
        'minLength',
        'maxLength',
        'pattern',
        'flags',
        'languageIn',
        'uniqueLang',
        'equals',
        'disjoint',
        'lessThan',
        'lessThanOrEquals',
        'not',
        'and',
        'or',
        'xone',
        'node',
        'property',
        'qualifiedValueShape',
        'qualifiedMinCount',
        'qualifiedMaxCount',
        'qualifiedValueShapesDisjoint',
        'closed',
        'ignoredProperties',
        'hasValue',
        'in',
        'sparql',
        'js',
        'expression',
    ].map((name) => `${SHACL}${name}`),
);

function listMembers(shapes: Store, head: Term): ReadonlyArray<Term> {
    const members: Term[] = [];
    const seen = new Set<string>();
    let node: Term | undefined = head;
    while (node !== undefined && node.value !== RDF_NIL && !seen.has(termKey(node))) {
        seen.add(termKey(node));
        const first = shapes.getQuads(node, RDF_FIRST, null, null)[0]?.object;
        if (first !== undefined) {
            members.push(first);
        }
        node = shapes.getQuads(node, RDF_REST, null, null)[0]?.object;
    }
    return members;
}

/** Shapes another shape refers to, so they report through that shape and are covered by its self-test. */
function referencedShapeKeys(shapes: Store): ReadonlySet<string> {
    const referenced = new Set<string>();
    for (const predicate of SHAPE_REFERENCE_PREDICATES) {
        for (const quad of shapes.getQuads(null, predicate, null, null)) {
            referenced.add(termKey(quad.object));
        }
    }
    for (const predicate of SHAPE_LIST_PREDICATES) {
        for (const quad of shapes.getQuads(null, predicate, null, null)) {
            for (const member of listMembers(shapes, quad.object)) {
                referenced.add(termKey(member));
            }
        }
    }
    return referenced;
}

function hasTarget(shapes: Store, shape: Term): boolean {
    return TARGET_PREDICATES.some((predicate) => shapes.getQuads(shape, predicate, null, null).length > 0);
}

/**
 * Whether a shape declares a constraint, on itself or on a property shape it holds through `sh:property`. A shape
 * that declares none can report no validation result for any data, so a self-test of it could never fire.
 */
function declaresConstraint(
    shapes: Store,
    shape: Term,
    declaredParameters: ReadonlySet<string>,
    seen: Set<string> = new Set(),
): boolean {
    const key = termKey(shape);
    if (seen.has(key)) {
        return false;
    }
    seen.add(key);
    for (const quad of shapes.getQuads(shape, null, null, null)) {
        const predicate = quad.predicate.value;
        if (quad.predicate.equals(SH_PROPERTY)) {
            if (declaresConstraint(shapes, quad.object, declaredParameters, seen)) {
                return true;
            }
            continue;
        }
        if (CORE_CONSTRAINT_PARAMETERS.has(predicate) || declaredParameters.has(predicate)) {
            return true;
        }
    }
    return false;
}

/**
 * The declared shapes Erden reports on: each gets a shape summary and a self-test. A shape reports results only for
 * the focus nodes of its own targets, so the self-test proves each shape can fail at its targets. Two kinds of
 * declared shape are left out, as untyped property shapes always were, because no fixture could make them report and
 * their behavior is already covered or empty:
 *
 * - a shape with no target that another shape refers to (`sh:property`, `sh:node`, `sh:not`, `sh:qualifiedValueShape`
 *   or a member of `sh:and`, `sh:or`, `sh:xone`): it reports through that shape, whose self-test covers it. Typing it
 *   `sh:PropertyShape` or `sh:NodeShape` changes nothing in SHACL, so it changes nothing here either;
 * - a shape with a target that declares no constraint, such as an OWL class punned as a node shape with only
 *   `sh:targetClass`: it can report nothing for any data, so nothing it checks can go unchecked.
 *
 * A shape with no target that nothing refers to still gets a self-test, and fails it closed: it is inert.
 */
function reportedShapeTerms(shapes: Store): ReadonlyArray<Term> {
    const referenced = referencedShapeKeys(shapes);
    // Parameters of the constraint components the shapes graph declares itself (SHACL-SPARQL, section 6.2.1).
    const declaredParameters = new Set(
        shapes
            .getQuads(null, SH_PARAMETER, null, null)
            .flatMap((quad) => shapes.getQuads(quad.object, SH_PATH, null, null).map((path) => path.object.value)),
    );
    return declaredShapeTerms(shapes).filter((shape) => {
        if (!hasTarget(shapes, shape)) {
            return !referenced.has(termKey(shape));
        }
        return declaresConstraint(shapes, shape, declaredParameters);
    });
}

/** A result's source shape and every shape that holds it through a chain of `sh:property`, as term keys. */
function sourceShapeChain(parsed: ParsedShapes, sourceShape: RdfTermLike): ReadonlySet<string> {
    const chain = new Set<string>();
    let shape: RdfTermLike | undefined = sourceShape;
    while (shape !== undefined && !chain.has(termKey(shape))) {
        chain.add(termKey(shape));
        shape = parsed.ownerByPropertyShape.get(termKey(shape));
    }
    return chain;
}

function fixtureSourcesForShape(parsed: ParsedShapes, shape: Term): ReadonlyArray<ParsedShapeSource> {
    const attributedIds = new Set(descriptorsForShape(parsed, shape).map((descriptor) => descriptor.id));
    if (attributedIds.size === 0) {
        return parsed.sources;
    }
    return parsed.sources.filter((source) => attributedIds.has(source.descriptor.id));
}

type SelfTestFixture =
    | Readonly<{ kind: 'fixture'; shape: Term; quads: ReadonlyArray<Quad> }>
    | Readonly<{ kind: 'decided'; shape: Term; reason: string }>;

/** Each declared shape's self-test: a fixture graph to validate, or the reason it has none. */
function selfTestFixtures(parsed: ParsedShapes): ReadonlyArray<SelfTestFixture> {
    const shapes = reportedShapeTerms(parsed.dataset);
    const fixtures: SelfTestFixture[] = [];
    for (let index = 0; index < shapes.length; index += 1) {
        const shape = shapes[index];
        if (shape === undefined) {
            continue;
        }
        const target = targetFor(parsed.dataset, shape);
        const shapeSource = descriptorsForShape(parsed, shape)[0];
        const header = prefixHeader(fixtureSourcesForShape(parsed, shape));
        const selfTestNamespace = shapeSource?.owner.ownedIriPrefixes[0];
        // A prefix that already ends in a fragment (`…#`) cannot take a second `#`: an IRI has one fragment, and the
        // engine's parser refuses another. Such a prefix gets `selftest-` instead.
        const testBase =
            selfTestNamespace === undefined
                ? `urn:erden:selftest:${String(index)}:`
                : selfTestNamespace.includes('#')
                  ? `${selfTestNamespace}selftest-`
                  : `${selfTestNamespace}selftest#`;
        const badIri = `${testBase}bad`;
        const otherIri = `${testBase}other`;
        let base = '';
        if (target.term !== null && target.term.termType === 'NamedNode') {
            if (target.kind === 'targetClass') {
                base = `<${badIri}> a <${target.term.value}> .`;
            }
            if (target.kind === 'targetSubjectsOf') {
                base = `<${badIri}> <${target.term.value}> "selftest" .`;
            }
            if (target.kind === 'targetObjectsOf') {
                base = `<${otherIri}> <${target.term.value}> <${badIri}> .`;
            }
        }
        const extra = parsed.dataset
            .getQuads(shape, SELFTEST_FIXTURE, null, null)
            .map((quad) => quad.object.value)
            .join('\n');
        if (base.length === 0 && extra.length === 0) {
            fixtures.push({ kind: 'decided', shape, reason: 'no SHACL Core target and no self-test fixture' });
            continue;
        }
        try {
            const quads = new Parser({
                blankNodePrefix: `erden_selftest_${String(index).padStart(8, '0')}_`,
                format: 'text/turtle',
                factory: DataFactory,
            }).parse(`${header}\n@prefix t: <${testBase}> .\n${base}\n${extra}`);
            fixtures.push({ kind: 'fixture', shape, quads });
        } catch (cause) {
            fixtures.push({
                kind: 'decided',
                shape,
                reason: `self-test fixture did not parse: ${cause instanceof Error ? cause.message : String(cause)}`,
            });
        }
    }
    return fixtures;
}

function selfTestGraphId(index: number): string {
    return `selftest-${String(index)}`;
}

/** Whether each self-test fixture made its shape report a result, read from the same answer as the data's report. */
function selfTestResults(
    parsed: ParsedShapes,
    fixtures: ReadonlyArray<SelfTestFixture>,
    reports: ReadonlyMap<string, ShaclAnswerReport>,
): ReadonlyArray<ShapeSelfTestResult & { readonly term: Term }> {
    return fixtures.map((fixture, index) => {
        if (fixture.kind === 'decided') {
            return { shape: fixture.shape.value, term: fixture.shape, fired: false, reason: fixture.reason };
        }
        const report = reports.get(selfTestGraphId(index));
        const fired =
            report?.results.some((result) =>
                sourceShapeChain(parsed, result.sourceShape).has(termKey(fixture.shape)),
            ) ?? false;
        return {
            shape: fixture.shape.value,
            term: fixture.shape,
            fired,
            reason: fired
                ? null
                : 'the generated fixture does not trigger this shape; add an sx:selftestFixture literal',
        };
    });
}

function shapeBlankNodePrefix(index: number): string {
    return `erden_shape_${String(index).padStart(8, '0')}_`;
}

/**
 * Every construct of the selected shapes the bundled engine cannot run, located. Only a graph with one pays for the
 * second parse that finds positions; the scan then runs on that parse, so each statement it names has a position.
 */
function unsupportedConstructs(parsed: ParsedShapes): ReadonlyArray<UnsupportedShaclConstruct> {
    if (findUnsupportedShaclConstructs(parsed.dataset).length === 0) {
        return [];
    }
    const sources = parsed.sources.map((source, index) => {
        const located = locateTurtleText(source.text, {
            baseIri: source.descriptor.baseIri,
            blankNodePrefix: shapeBlankNodePrefix(index),
            expectedCount: source.quads.length,
        });
        const quads = located?.quads ?? source.quads;
        return {
            sourceId: source.descriptor.id,
            quads,
            keys: new Set(quads.map(quadKey)),
            positions: located?.positions ?? new Map<string, { line: number; column: number }>(),
        };
    });
    const store = new Store();
    for (const source of sources) {
        store.addQuads([...source.quads]);
    }
    const order = new Map(sources.map((source, index) => [source.sourceId, index]));
    return findUnsupportedShaclConstructs(store)
        .map((item): UnsupportedShaclConstruct => {
            const statementKey = quadKey(item.statement);
            const source = sources.find((candidate) => candidate.keys.has(statementKey)) ?? sources[0];
            const position = source?.positions.get(statementKey);
            return {
                kind: item.kind,
                shape: item.shape,
                construct: item.construct,
                message: item.message,
                sourceId: source?.sourceId ?? '',
                position: position === undefined ? null : { line: position.line, column: position.column },
            };
        })
        .sort(
            (left, right) =>
                (order.get(left.sourceId) ?? 0) - (order.get(right.sourceId) ?? 0) ||
                (left.position?.line ?? 0) - (right.position?.line ?? 0) ||
                (left.position?.column ?? 0) - (right.position?.column ?? 0) ||
                compareCodePoints(left.kind, right.kind) ||
                compareCodePoints(left.shape ?? '', right.shape ?? '') ||
                compareCodePoints(left.construct, right.construct) ||
                compareCodePoints(left.message, right.message),
        );
}

/** The whole step refused: no shape ran, so there are no findings, summaries or self-tests to report. */
function refusedValidation(
    parsed: ParsedShapes,
    unsupported: ReadonlyArray<UnsupportedShaclConstruct>,
): ShaclValidation {
    return {
        conforms: false,
        findings: [],
        shapes: [],
        selfTest: [],
        counts: { violation: 0, warning: 0, info: 0 },
        sourceDigests: sourceDigests(parsed),
        unsupported,
    };
}

function sourceDigests(parsed: ParsedShapes): ShaclValidation['sourceDigests'] {
    return parsed.sources
        .map((source) => ({
            sourceId: source.descriptor.id,
            contentDigest: source.contentDigest,
        }))
        .sort((left, right) => compareCodePoints(left.sourceId, right.sourceId));
}

export type ShaclValidationError =
    | RequiredStageUnavailableError
    | ShaclAnswerUntrustedError
    | ShaclEngineError
    | ShaclEngineUnavailableError
    | ShaclLimitsError
    | ShaclProcessError
    | ShaclRefusedError
    | ShaclRequestEncodingError
    | TurtleSourceParseError
    | UnsupportedSemanticFormatError;

/** One request carries at most this many results; a check with more fails closed (`SHACL_REFUSED`, result-limit). */
export const SHACL_MAX_RESULTS = 100_000;

/** The blank-node prefix of the report graph Erden writes from the answer; no source or fixture label uses it. */
const REPORT_BLANK_NODE_PREFIX = 'erden_report_';

/** The declared shape a refusal names, and its source file: the first `<iri>` in the diagnostic that is a shape. */
function refusalShape(parsed: ParsedShapes, message: string): { shape: string | null; locator: string | null } {
    for (const match of message.matchAll(/<([^<>\s]+)>/gu)) {
        const iri = match[1] ?? '';
        const sources = parsed.sourceByShape.get(`NamedNode:${iri}`);
        if (sources !== undefined && sources.length > 0) {
            return { shape: iri, locator: sources[0]?.locator ?? null };
        }
    }
    return { shape: null, locator: null };
}

function refusedError(
    parsed: ParsedShapes,
    refusal: ShaclRefusal,
    fixtures: ReadonlyArray<SelfTestFixture>,
): ShaclRefusedError {
    const named = refusalShape(parsed, refusal.message);
    const fixture = refusal.graph?.startsWith('selftest-')
        ? fixtures[Number(refusal.graph.slice('selftest-'.length))]
        : undefined;
    const graph =
        refusal.graph === null ? null : refusal.graph === 'data' ? 'the validated data' : 'a self-test fixture';
    const shape = named.shape ?? fixture?.shape.value ?? null;
    const locator =
        named.locator ??
        (fixture === undefined ? null : (descriptorsForShape(parsed, fixture.shape)[0]?.locator ?? null));
    return new ShaclRefusedError(
        refusal.code,
        graph === null ? refusal.message : `${refusal.message} (in ${graph})`,
        refusal.graph,
        shape,
        locator,
    );
}

function findingOf(
    parsed: ParsedShapes,
    result: ShaclAnswerResult,
    index: ReturnType<typeof indexShaclShapes>,
): ShaclFinding {
    const ownerShape = sourceShapeOwner(parsed, result.sourceShape);
    const descriptors = descriptorsForShape(parsed, ownerShape);
    const constraint = shaclSourceConstraint(result, index);
    return {
        focus: result.focusNode.value,
        path: shaclPathText(result.resultPath),
        severity: severityName(result.resultSeverity),
        message: shaclFindingMessage(result, parsed.dataset),
        shape: ownerShape.value,
        shapeSourceIds: descriptors.map((descriptor) => descriptor.id).sort(compareCodePoints),
        shapeOwners: distinctOwners(descriptors),
        value: result.value === null ? null : shaclTermText(result.value),
        component: result.sourceConstraintComponent,
        sourceShape: result.sourceShape.value,
        ...(constraint === null ? {} : { sourceConstraint: constraint.value }),
    };
}

function validateShaclInternal(
    resources: TextResourcePort,
    graph: AssembledOntology,
    descriptors: ReadonlyArray<ShapeSourceDescriptor>,
    required: boolean,
    captureEvidence: boolean,
    engine: ShaclEnginePort,
): Effect.Effect<ShaclValidationCapture, ShaclValidationError> {
    return Effect.gen(function* () {
        const parsed = yield* loadShapes(resources, descriptors, required);
        if (parsed === null) {
            return Object.freeze({ validation: null, evidence: null, selfTestEvidence: null });
        }
        const unsupported = unsupportedConstructs(parsed);
        if (unsupported.length > 0) {
            return Object.freeze({
                validation: refusedValidation(parsed, unsupported),
                evidence: null,
                selfTestEvidence: null,
            });
        }
        const evidenceSources = captureEvidence
            ? parsed.sources.map((source) => ({
                  descriptor: {
                      id: source.descriptor.id,
                      owner: { role: source.descriptor.owner.role, canonicalIri: source.descriptor.owner.canonicalIri },
                  },
                  contentDigest: source.contentDigest,
                  quads: source.quads,
              }))
            : [];
        const fixtures = selfTestFixtures(parsed);
        const handle = yield* engine.resolve();
        const data = graph.dataset.getQuads(null, null, null, null);
        const request = yield* Effect.try({
            try: () =>
                encodeShaclRequest({
                    requestId: 'erden-check',
                    tool: handle.tool,
                    shapes: prepareShaclShapes(parsed.quads),
                    graphs: [
                        { id: 'data', quads: data },
                        ...fixtures.flatMap((fixture, index) =>
                            fixture.kind === 'fixture' ? [{ id: selfTestGraphId(index), quads: fixture.quads }] : [],
                        ),
                    ],
                    maxResults: SHACL_MAX_RESULTS,
                }),
            catch: (cause) => (cause instanceof ShaclRequestEncodingError ? cause : new ShaclEngineError(cause)),
        });
        const answer = yield* handle.run(request);
        if (answer.outcome === 'refused') {
            return yield* Effect.fail(refusedError(parsed, answer, fixtures));
        }
        const reports = new Map(answer.reports.map((report) => [report.id, report]));
        const report = reports.get('data');
        if (report === undefined) {
            return yield* Effect.fail(new ShaclAnswerUntrustedError('the answer has no report for the validated data'));
        }
        const index = indexShaclShapes(parsed.quads);
        const evidence = captureEvidence
            ? yield* Effect.try({
                  try: () =>
                      captureShaclEvidence({
                          data,
                          shapes: evidenceSources,
                          report: {
                              term: DataFactory.blankNode(`${REPORT_BLANK_NODE_PREFIX}report`),
                              dataset: shaclReportQuads(report, index, REPORT_BLANK_NODE_PREFIX),
                          },
                      }),
                  catch: (cause) => new ShaclEngineError(cause),
              })
            : null;
        const findings: ShaclFinding[] = report.results
            .map((result) => findingOf(parsed, result, index))
            .sort(
                (left, right) =>
                    compareCodePoints(left.severity, right.severity) ||
                    compareCodePoints(left.shape ?? '', right.shape ?? '') ||
                    compareCodePoints(left.focus ?? '', right.focus ?? '') ||
                    compareCodePoints(left.path ?? '', right.path ?? '') ||
                    compareCodePoints(left.message, right.message) ||
                    compareCodePoints(left.value ?? '', right.value ?? '') ||
                    compareCodePoints(left.component ?? '', right.component ?? '') ||
                    compareCodePoints(left.sourceShape ?? '', right.sourceShape ?? ''),
            );
        const shapeTerms = reportedShapeTerms(parsed.dataset);
        const summaries: ShapeSummary[] = shapeTerms.map((shape) => {
            const target = targetFor(parsed.dataset, shape);
            const descriptors = descriptorsForShape(parsed, shape);
            return {
                shape: shape.value,
                targetKind: target.kind,
                targetTerm: target.term?.value ?? null,
                targetCount: targetCount(graph.dataset, parsed.dataset, target),
                resultCount: findings.filter((finding) => finding.shape === shape.value).length,
                sourceIds: descriptors.map((descriptor) => descriptor.id).sort(compareCodePoints),
                owners: distinctOwners(descriptors),
            };
        });
        const selfTest = selfTestResults(parsed, fixtures, reports);
        const counts = {
            violation: findings.filter((finding) => finding.severity === 'Violation').length,
            warning: findings.filter((finding) => finding.severity === 'Warning').length,
            info: findings.filter((finding) => finding.severity === 'Info').length,
        };
        const validation: ShaclValidation = {
            conforms: counts.violation === 0 && selfTest.every((result) => result.fired),
            findings,
            shapes: summaries,
            selfTest: selfTest.map(({ shape, fired, reason }) => ({ shape, fired, reason })),
            counts,
            sourceDigests: sourceDigests(parsed),
            engine: {
                name: answer.tool.name,
                version: answer.tool.version,
                engineDigest: answer.tool.engineDigest,
                executableDigest: answer.tool.executableDigest,
            },
        };
        const selfTestEvidence = captureEvidence
            ? yield* Effect.try({
                  try: () => captureShaclSelfTests(selfTest),
                  catch: (cause) => new ShaclEngineError(cause),
              })
            : null;
        return Object.freeze({ validation, evidence, selfTestEvidence });
    });
}

export interface ShaclValidationCapture {
    readonly validation: ShaclValidation | null;
    readonly evidence: ShaclEvidence | null;
    readonly selfTestEvidence: ShaclSelfTestEvidence | null;
}

export function validateShacl(
    resources: TextResourcePort,
    graph: AssembledOntology,
    descriptors: ReadonlyArray<ShapeSourceDescriptor>,
    required: boolean,
    engine: ShaclEnginePort = nodeShaclEnginePort,
): Effect.Effect<ShaclValidation | null, ShaclValidationError> {
    return validateShaclInternal(resources, graph, descriptors, required, false, engine).pipe(
        Effect.map((result) => result.validation),
    );
}

export function validateShaclWithEvidence(
    resources: TextResourcePort,
    graph: AssembledOntology,
    descriptors: ReadonlyArray<ShapeSourceDescriptor>,
    required: boolean,
    engine: ShaclEnginePort = nodeShaclEnginePort,
): Effect.Effect<ShaclValidationCapture, ShaclValidationError> {
    return validateShaclInternal(resources, graph, descriptors, required, true, engine);
}
