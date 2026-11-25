import { isAbsolute } from 'node:path';

import { Result, Schema } from 'effect';
import { valid } from 'semver';

import { LOCKFILE_LIMITS, compareCodePoints, isCanonicalOntologyIri, isScopedAlias } from '@erden/contracts';
import { PACKAGE_CODEC_LIMITS } from '@erden/package-format';

export const PACK_REPORT_VERSION = 'erden.pack-report/v1' as const;
const SHA256 = /^[0-9a-f]{64}$/u;
const ExactVersion = Schema.String.check(
    Schema.isPattern(
        /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u,
    ),
);
const Count = Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0));

/** How many paths a report lists for each ignore note; `count` still tells the full number. */
export const PACK_REPORT_PATH_LIST_LIMIT = 20;
/** The most paths a note can count: every entry the bounded project scan may observe. */
const PATH_NOTE_MAXIMUM_COUNT = PACKAGE_CODEC_LIMITS.maxEntries + 32;
const PathNote = Schema.Struct({ count: Count, paths: Schema.Array(Schema.String) });

export const PackProjectReportSchema = Schema.Struct({
    schema: Schema.Literal(PACK_REPORT_VERSION),
    project: Schema.Struct({ alias: Schema.String, canonicalIri: Schema.String }),
    version: ExactVersion,
    output: Schema.Struct({
        path: Schema.String,
        status: Schema.Literals(['written', 'hit']),
        cleanup: Schema.Literals(['clean', 'cleanup-residue-retained']),
    }),
    archive: Schema.Struct({
        byteSize: Count,
        sha256: Schema.String.check(Schema.isPattern(SHA256)),
        manifestSha256: Schema.String.check(Schema.isPattern(SHA256)),
        fileCount: Count,
        directDependencyCount: Count,
    }),
    /**
     * Data files (RDF, SPARQL, CSV, TSV and JSON) present in the project that a .erdenignore or .gitignore rule left
     * out of the package. Absent when there are none, so older readers see the same report as before.
     */
    ignoredDataFiles: Schema.optionalKey(PathNote),
    /** Files a .gitignore rule matched that the package ships anyway, because the manifest or package needs them. */
    gitIgnoredIncluded: Schema.optionalKey(PathNote),
    outcome: Schema.Literal('packed'),
});
export type PackProjectReport = typeof PackProjectReportSchema.Type;

function freeze<A>(value: A): A {
    if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
        for (const child of Object.values(value)) {
            freeze(child);
        }
        Object.freeze(value);
    }
    return value;
}

function assertPlainInput(input: unknown): void {
    const pending: unknown[] = [input];
    let nodes = 0;
    while (pending.length > 0) {
        const value = pending.pop();
        if (value === null || typeof value !== 'object') {
            continue;
        }
        nodes += 1;
        const array = Array.isArray(value);
        if (
            nodes > 32 ||
            Object.getPrototypeOf(value) !== (array ? Array.prototype : Object.prototype) ||
            Object.getOwnPropertySymbols(value).length !== 0
        ) {
            throw new TypeError('closed report shape');
        }
        for (const name of Object.getOwnPropertyNames(value)) {
            if (array && name === 'length') {
                continue;
            }
            const descriptor = Object.getOwnPropertyDescriptor(value, name);
            if (descriptor === undefined || !('value' in descriptor) || !descriptor.enumerable) {
                throw new TypeError('closed report descriptor');
            }
            pending.push(descriptor.value);
        }
    }
}

export function decodePackProjectReport(input: unknown): PackProjectReport {
    let result;
    try {
        assertPlainInput(input);
        result = Schema.decodeUnknownResult(PackProjectReportSchema, {
            errors: 'all',
            onExcessProperty: 'error',
            reportInput: false,
        })(input);
    } catch (cause) {
        throw new TypeError('The pack report does not match erden.pack-report/v1', { cause });
    }
    if (Result.isFailure(result)) {
        throw new TypeError('The pack report does not match erden.pack-report/v1');
    }
    const report = result.success;
    if (
        !isCanonicalOntologyIri(report.project.canonicalIri) ||
        !isScopedAlias(report.project.alias) ||
        valid(report.version, { loose: false }) === null ||
        !isAbsolute(report.output.path) ||
        !report.output.path.endsWith('.erdenpkg') ||
        report.output.path.includes('\0')
    ) {
        throw new TypeError('The pack report identity is invalid');
    }
    for (const count of [report.archive.byteSize, report.archive.fileCount, report.archive.directDependencyCount]) {
        if (!Number.isSafeInteger(count) || count < 0 || Object.is(count, -0)) {
            throw new TypeError('The pack report count is invalid');
        }
    }
    if (
        report.archive.byteSize > PACKAGE_CODEC_LIMITS.maxCompressedBytes ||
        report.archive.fileCount > PACKAGE_CODEC_LIMITS.maxEntries ||
        report.archive.directDependencyCount > LOCKFILE_LIMITS.maxDirectDependencies ||
        (report.output.status === 'hit' && report.output.cleanup !== 'clean')
    ) {
        throw new TypeError('The pack report violates a closed v1 invariant');
    }
    for (const note of [report.ignoredDataFiles, report.gitIgnoredIncluded]) {
        if (note === undefined) {
            continue;
        }
        if (
            !Number.isSafeInteger(note.count) ||
            note.count < 1 ||
            note.count > PATH_NOTE_MAXIMUM_COUNT ||
            note.paths.length !== Math.min(note.count, PACK_REPORT_PATH_LIST_LIMIT) ||
            note.paths.some(
                (path, index) =>
                    path.length === 0 ||
                    path.includes('\0') ||
                    isAbsolute(path) ||
                    (index > 0 && compareCodePoints(note.paths[index - 1] as string, path) >= 0),
            )
        ) {
            throw new TypeError('The pack report ignore note is invalid');
        }
    }
    return freeze(report);
}

export function encodePackProjectReport(input: PackProjectReport): string {
    const report = decodePackProjectReport(input);
    return `${JSON.stringify({
        archive: {
            byteSize: report.archive.byteSize,
            directDependencyCount: report.archive.directDependencyCount,
            fileCount: report.archive.fileCount,
            manifestSha256: report.archive.manifestSha256,
            sha256: report.archive.sha256,
        },
        ...(report.gitIgnoredIncluded === undefined
            ? {}
            : {
                  gitIgnoredIncluded: {
                      count: report.gitIgnoredIncluded.count,
                      paths: report.gitIgnoredIncluded.paths,
                  },
              }),
        ...(report.ignoredDataFiles === undefined
            ? {}
            : { ignoredDataFiles: { count: report.ignoredDataFiles.count, paths: report.ignoredDataFiles.paths } }),
        outcome: report.outcome,
        output: { cleanup: report.output.cleanup, path: report.output.path, status: report.output.status },
        project: { alias: report.project.alias, canonicalIri: report.project.canonicalIri },
        schema: report.schema,
        version: report.version,
    })}\n`;
}
