import { isAbsolute, posix, relative } from 'node:path';

import { Context, Effect } from 'effect';

import {
    CheckProjectOperationalError,
    CurrentToolchain,
    nodeCurrentToolchainService,
    type LockToolchain,
} from '@erden/contracts';
import {
    LOCAL_QUERY_GRAPHS,
    OntologyService,
    ReasonerProcessError,
    ReasonerService,
    TrustedNegativeReasonerOutcomeError,
    DEFAULT_REASONER_LIMITS,
    localQueryNQuads,
    localQueryNTriples,
    questionGraphQuads,
    questionRegime,
    sourceGraphIri,
    type LoadedCompetencyQuestion,
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
    type AssembledOntology,
    type ByteBackedTurtleSource,
    type ReasonerLimits,
    type UnparsedOntologySource,
} from '@erden/ontology';

import {
    currentToolchainError,
    installError,
    loadDependencyProjects,
    ontologyError,
    ownerFor,
    projectLockError,
    requireAvailableLock,
    sourceLocationsForProject,
    type CheckSourceProject,
    type LoadedDependencyProjects,
} from '../check/operation.js';
import { ManifestService, makeManifestService } from '../manifest/index.js';
import {
    nodeProjectDependencyStateService,
    type ProjectDependencyStateServiceShape,
} from '../project-dependency-state/index.js';
import { nodeInstalledClosureReader, type InstalledClosureReaderShape } from '../store/index.js';

import {
    entailedCacheEntry,
    entailmentCacheKey,
    nodeEntailmentCache,
    type EntailedCacheEntry,
    type EntailmentCachePort,
} from './entailment-cache.js';

/** What a local query answers under: what the files say, or what they imply under Erden's reasoner. */
export type LocalQueryRegime = 'asserted' | 'entailed';

/** One reason an answer is partial. Each names what is missing; none is ever left out of an answer. */
export type LocalQueryCompletenessReason =
    | Readonly<{
          code: 'sources-unparsed';
          sources: ReadonlyArray<
              Readonly<{ file: string; line: number | null; column: number | null; code: string; message: string }>
          >;
      }>
    | Readonly<{ code: 'dependencies-missing'; cause: string }>
    | Readonly<{ code: 'entailment-unavailable'; cause: string }>
    | Readonly<{ code: 'statements-outside-profile'; count: number }>;

export interface LocalQueryEntailment {
    readonly reasoner: Readonly<{ name: string; version: string; calculusDigest: string }>;
    readonly profile: Readonly<{ id: string; digest: string }>;
    readonly inputDigest: string;
    readonly certificateDigest: string;
    /** Whether the inferences came from the entailment cache rather than a reasoning run of this command. */
    readonly cached: boolean;
}

export interface PreparedProjectQuery {
    readonly projectRoot: string;
    readonly canonicalIri: string;
    readonly manifestFile: string;
    /** The regime the dataset answers under. */
    readonly regime: LocalQueryRegime;
    /** Set when the regime is entailed. */
    readonly entailment: LocalQueryEntailment | null;
    /** The caller asked for the entailed regime and it could not be had; the dataset is asserted. */
    readonly entailedUnavailable: boolean;
    readonly reasons: ReadonlyArray<LocalQueryCompletenessReason>;
    readonly dataset: Readonly<{
        nquads: string;
        defaultGraph: ReadonlyArray<string>;
        namedGraphs: ReadonlyArray<string>;
        quadCounts: Readonly<{ declared: number; inferred: number }>;
        /** One named graph per source, `urn:erden:source:<source-id>`, holding what that source asserts. */
        sourceGraphs: ReadonlyArray<string>;
    }>;
    /** The root project's competency questions the caller selected, in id order; empty unless it asked. */
    readonly questions: ReadonlyArray<LoadedCompetencyQuestion>;
    /** Selections that name no root competency question. */
    readonly unknownQuestions: ReadonlyArray<string>;
}

export interface QueryProjectOptions {
    readonly from?: string;
    readonly manifestPath?: string;
    /** Absent: entailed when it can be had, else asserted. Present: that regime, or an answer that says it is not. */
    readonly regime?: LocalQueryRegime;
    readonly reasonerLimits?: ReasonerLimits;
    /**
     * The competency questions to load: `all` of the root project's, or those whose id or absolute file path is
     * listed by id or file. When every one asks for the asserted regime and no regime is given, no reasoning runs.
     */
    readonly questions?: 'all' | ReadonlyArray<QuestionSelection>;
}

/** One selected question: by id, or by its file, the name made absolute. */
export interface QuestionSelection {
    readonly name: string;
    readonly path: string;
}

export interface QueryProjectServiceShape {
    readonly prepare: (
        options?: QueryProjectOptions,
    ) => Effect.Effect<PreparedProjectQuery, CheckProjectOperationalError>;
}

export const QueryProjectService = Context.Service<QueryProjectServiceShape>('@erden/project/QueryProjectService');

function portablePath(projectRoot: string, locator: string): string {
    if (locator.startsWith('dependencies/')) {
        return locator;
    }
    const path = relative(projectRoot, locator).split('\\').join('/');
    return path.length === 0 || path.startsWith('../') || isAbsolute(path) || posix.isAbsolute(path)
        ? locator.split('\\').join('/')
        : path;
}

const EMPTY_DEPENDENCIES: LoadedDependencyProjects = Object.freeze({
    projects: Object.freeze([]),
    dataSources: Object.freeze([]),
    shapeSources: Object.freeze([]),
    competencyQuestions: Object.freeze([]),
});

type Entailment =
    | Readonly<{ kind: 'entailed'; entry: EntailedCacheEntry; cached: boolean }>
    | Readonly<{ kind: 'unavailable'; cause: string }>;

/**
 * Whether a reasoning failure follows from the inputs and limits alone, so the next run would fail the same way: the
 * request ceiling. Refusals Erden's own code decides (normalization) are not kept, so a newer Erden decides again.
 */
function deterministicFailure(cause: unknown): boolean {
    return cause instanceof ReasonerProcessError && cause.code === 'REQUEST_TOO_LARGE';
}

function entail(
    graph: AssembledOntology,
    projectRoot: string,
    toolchain: LockToolchain,
    limits: ReasonerLimits,
    reasonerService: Context.Service.Shape<typeof ReasonerService>,
    cache: EntailmentCachePort,
): Effect.Effect<Entailment> {
    return Effect.gen(function* () {
        if (graph.sources.length === 0) {
            return { kind: 'unavailable' as const, cause: 'no-sources' };
        }
        const key = entailmentCacheKey(toolchain.reasoner, graph);
        const hit = cache.readEntailed(key);
        if (hit !== null) {
            return { kind: 'entailed' as const, entry: hit, cached: true };
        }
        const known = cache.readUnavailable(key, limits);
        if (known !== null) {
            return { kind: 'unavailable' as const, cause: known.cause };
        }
        function unavailable(cause: string, keep: boolean): Entailment {
            if (keep) {
                cache.write(
                    Object.freeze({ schema: 'erden.entailment-cache/v1', key, outcome: 'unavailable', limits, cause }),
                );
            }
            return { kind: 'unavailable', cause };
        }
        return yield* Effect.matchEffect(
            reasonerService.decideAndMaterialize(graph, {
                limits,
                lockedReasoner: {
                    version: toolchain.reasoner.version,
                    calculusDigest: `sha256:${toolchain.reasoner.sha256}`,
                },
            }),
            {
                onFailure: (cause) =>
                    Effect.succeed(
                        cause instanceof TrustedNegativeReasonerOutcomeError
                            ? unavailable(cause.context.reason, cause.context.outcome === 'refused')
                            : unavailable(
                                  ontologyError(cause, 'reasoning', projectRoot).code,
                                  deterministicFailure(cause),
                              ),
                    ),
                onSuccess: ({ decision, reasoned }) => {
                    if (decision.response.result.consistency === 'inconsistent') {
                        return Effect.succeed(unavailable('global-inconsistency', true));
                    }
                    if (
                        reasoned === null ||
                        decision.response.result.diagnostics.some((item) => item.severity === 'error')
                    ) {
                        return Effect.succeed(unavailable('reasoner-error-diagnostic', true));
                    }
                    const entry = entailedCacheEntry(key, reasoned, decision.normalization.partition.excludedKeys.size);
                    cache.write(entry);
                    return Effect.succeed({ kind: 'entailed' as const, entry, cached: false });
                },
            },
        );
    });
}

interface QueryProjectDependencies {
    readonly manifestService: Context.Service.Shape<typeof ManifestService>;
    readonly ontologyService: Context.Service.Shape<typeof OntologyService>;
    readonly reasonerService: Context.Service.Shape<typeof ReasonerService>;
    readonly projectStateService: Pick<ProjectDependencyStateServiceShape, 'inspect' | 'recheck'>;
    readonly currentToolchainService: Context.Service.Shape<typeof CurrentToolchain>;
    readonly installedClosureReader: InstalledClosureReaderShape;
    readonly entailmentCache: EntailmentCachePort;
}

function prepareProjectQuery(
    options: QueryProjectOptions,
    services: QueryProjectDependencies,
): Effect.Effect<PreparedProjectQuery, CheckProjectOperationalError> {
    const { ontologyService } = services;
    return Effect.gen(function* () {
        const toolchain = yield* services.currentToolchainService
            .inspect()
            .pipe(Effect.mapError(currentToolchainError));
        const state = yield* services.projectStateService
            .inspect({
                ...(options.from === undefined ? {} : { from: options.from }),
                ...(options.manifestPath === undefined ? {} : { explicitPath: options.manifestPath }),
                toolchain,
            })
            .pipe(Effect.mapError(projectLockError));
        const loaded = state.project;
        const projectRoot = loaded.projectRoot;
        const reasons: LocalQueryCompletenessReason[] = [];

        // Dependencies: the installed, locked closure, or the project's own sources alone, labeled.
        let dependencies = EMPTY_DEPENDENCIES;
        const declaresDependencies = Object.keys(loaded.manifest.dependencies).length > 0;
        const lock = yield* Effect.result(requireAvailableLock(state.lockInspection, 'root', toolchain));
        if (lock._tag === 'Failure') {
            if (declaresDependencies) {
                reasons.push({ code: 'dependencies-missing', cause: lock.failure.code });
            }
        } else if (lock.success.packages.length > 0) {
            const resolved = yield* Effect.result(
                services.installedClosureReader.resolve({ projectRoot, lock: lock.success }).pipe(
                    Effect.mapError(installError),
                    Effect.flatMap((closure) =>
                        loadDependencyProjects(
                            lock.success,
                            closure,
                            toolchain,
                            services.manifestService,
                            services.installedClosureReader,
                        ),
                    ),
                ),
            );
            if (resolved._tag === 'Failure') {
                reasons.push({ code: 'dependencies-missing', cause: resolved.failure.code });
            } else {
                dependencies = resolved.success;
            }
        }

        // The project's own sources: every one that can be found, read and parsed; the rest are listed.
        const rootProject: CheckSourceProject = Object.freeze({
            loaded,
            owner: ownerFor(loaded),
            idNamespace: 'root',
            logicalPrefix: null,
        });
        const unparsed: Array<
            Readonly<{ file: string; line: number | null; column: number | null; code: string; message: string }>
        > = [];
        const rootSources: ByteBackedTurtleSource[] = [];
        for (const location of sourceLocationsForProject(rootProject).ontology) {
            const discovered = yield* Effect.result(ontologyService.discoverDataSources([location], false));
            if (discovered._tag === 'Failure') {
                unparsed.push({
                    file: portablePath(projectRoot, location.selector.locator),
                    line: null,
                    column: null,
                    code: discovered.failure.code,
                    message: discovered.failure.message,
                });
                continue;
            }
            for (const descriptor of discovered.success) {
                const captured = yield* Effect.result(ontologyService.captureDataSources([descriptor]));
                if (captured._tag === 'Failure') {
                    unparsed.push({
                        file: portablePath(projectRoot, descriptor.locator),
                        line: null,
                        column: null,
                        code: captured.failure.code,
                        message: captured.failure.message,
                    });
                } else {
                    rootSources.push(...captured.success);
                }
            }
        }
        const assembled = yield* ontologyService
            .assembleByteBackedTolerant([...rootSources, ...dependencies.dataSources])
            .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', projectRoot)));
        const graph = assembled.graph;
        for (const source of assembled.unparsed satisfies ReadonlyArray<UnparsedOntologySource>) {
            unparsed.push({
                file: portablePath(projectRoot, source.locator),
                line: source.line,
                column: source.column,
                code: source.code,
                message: source.message,
            });
        }
        if (unparsed.length > 0) {
            reasons.unshift({ code: 'sources-unparsed', sources: Object.freeze(unparsed) });
        }

        // Competency questions, when asked for: the root project's, as `erden check` loads them.
        let questions: ReadonlyArray<LoadedCompetencyQuestion> = [];
        const unknownQuestions: string[] = [];
        if (options.questions !== undefined) {
            const locations = sourceLocationsForProject(rootProject).competencyQuestions;
            const loadedQuestions = yield* ontologyService
                .discoverCompetencyQuestions(locations, false)
                .pipe(Effect.mapError((cause) => ontologyError(cause, 'sources', projectRoot)));
            const selection = options.questions;
            if (selection === 'all') {
                questions = loadedQuestions;
            } else {
                function matches(item: QuestionSelection, question: LoadedCompetencyQuestion): boolean {
                    return question.id === item.name || question.locator === item.path;
                }
                questions = loadedQuestions.filter((question) => selection.some((item) => matches(item, question)));
                unknownQuestions.push(
                    ...selection
                        .filter((item) => !loadedQuestions.some((question) => matches(item, question)))
                        .map((item) => item.name),
                );
            }
            questions = [...questions].sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
        }
        const onlyAsserted =
            options.questions !== undefined &&
            questions.length > 0 &&
            questions.every((question) => questionRegime(question.metadata) === 'asserted');

        // The regime: entailed when the project's reasoning succeeds (or succeeded for these exact inputs).
        let entailment: Entailment | null = null;
        if (options.regime !== 'asserted' && !(options.regime === undefined && onlyAsserted)) {
            entailment = yield* entail(
                graph,
                projectRoot,
                toolchain,
                options.reasonerLimits ?? DEFAULT_REASONER_LIMITS,
                services.reasonerService,
                services.entailmentCache,
            );
        }
        const entailed = entailment?.kind === 'entailed' ? entailment : null;
        if (entailment?.kind === 'unavailable') {
            reasons.push({ code: 'entailment-unavailable', cause: entailment.cause });
        }
        if (entailed !== null && entailed.entry.outsideProfileStatements > 0) {
            reasons.push({ code: 'statements-outside-profile', count: entailed.entry.outsideProfileStatements });
        }
        const split = questionGraphQuads(graph);
        const sources = [...split.bySource.entries()].sort(([left], [right]) =>
            left < right ? -1 : left > right ? 1 : 0,
        );
        const nquads = localQueryNQuads([
            { graph: LOCAL_QUERY_GRAPHS.declared, ntriples: localQueryNTriples(split.declared) },
            ...sources.map(([sourceId, quads]) => ({
                graph: sourceGraphIri(sourceId),
                ntriples: localQueryNTriples(quads),
            })),
            ...(entailed === null ? [] : [{ graph: LOCAL_QUERY_GRAPHS.inferred, ntriples: entailed.entry.ntriples }]),
        ]);
        const graphs =
            entailed === null
                ? [LOCAL_QUERY_GRAPHS.declared]
                : [LOCAL_QUERY_GRAPHS.declared, LOCAL_QUERY_GRAPHS.inferred];
        const sourceGraphs = sources.map(([sourceId]) => sourceGraphIri(sourceId));
        yield* services.projectStateService
            .recheck({ revision: state.revision })
            .pipe(Effect.mapError(projectLockError));
        return Object.freeze({
            projectRoot,
            canonicalIri: loaded.manifest.canonicalIri,
            manifestFile: portablePath(projectRoot, loaded.filePath),
            regime: entailed === null ? 'asserted' : 'entailed',
            entailment:
                entailed === null
                    ? null
                    : Object.freeze({
                          reasoner: entailed.entry.reasoner,
                          profile: entailed.entry.profile,
                          inputDigest: entailed.entry.inputDigest,
                          certificateDigest: entailed.entry.certificateDigest,
                          cached: entailed.cached,
                      }),
            entailedUnavailable: options.regime === 'entailed' && entailed === null,
            reasons: Object.freeze(reasons),
            dataset: Object.freeze({
                nquads,
                defaultGraph: Object.freeze(graphs),
                namedGraphs: Object.freeze([...graphs, ...sourceGraphs]),
                sourceGraphs: Object.freeze(sourceGraphs),
                quadCounts: Object.freeze({
                    declared: graph.dataset.size,
                    inferred: entailed?.entry.statementCount ?? 0,
                }),
            }),
            questions: Object.freeze(questions),
            unknownQuestions: Object.freeze(unknownQuestions),
        } satisfies PreparedProjectQuery);
    });
}

export function makeQueryProjectService(
    manifestService: Context.Service.Shape<typeof ManifestService>,
    ontologyService: Context.Service.Shape<typeof OntologyService>,
    reasonerService: Context.Service.Shape<typeof ReasonerService>,
    projectStateService: Pick<
        ProjectDependencyStateServiceShape,
        'inspect' | 'recheck'
    > = nodeProjectDependencyStateService,
    currentToolchainService: Context.Service.Shape<typeof CurrentToolchain> = nodeCurrentToolchainService,
    installedClosureReader: InstalledClosureReaderShape = nodeInstalledClosureReader,
    entailmentCache: EntailmentCachePort = nodeEntailmentCache(),
): QueryProjectServiceShape {
    const services: QueryProjectDependencies = Object.freeze({
        manifestService,
        ontologyService,
        reasonerService,
        projectStateService,
        currentToolchainService,
        installedClosureReader,
        entailmentCache,
    });
    return Object.freeze({ prepare: (options = {}) => prepareProjectQuery(options, services) });
}

export const nodeQueryProjectService = makeQueryProjectService(
    makeManifestService(),
    makeOntologyService(makeNodeOntologyPorts()),
    nodeReasonerService,
);
