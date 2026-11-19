// The differential fixtures' check outcomes against the bytes `main` gives. Every fixture is checked as
// `erden check --json` checks it (the bundled engine, the CLI's services) and the SHA-256 of what the check ends with
// is compared with `fixtures/check-main-reports.json`, recorded by this same file on `main`. A refusal counts by its
// code, stage, message and diagnostics.
//
// To record on another commit, copy this file and `support/differential-fixtures.ts` into a checkout of it and run
//   ERDEN_CHECK_MAIN_REPORTS_RECORD=<file> pnpm exec vitest run packages/project/test/check-main-reports.test.ts
// It uses only the check service, so it runs on commits that predate the fused path and the comparator.
//
// ERDEN_CHECK_MAIN_REPORTS_DUMP=<dir> also writes each fixture's outcome bytes to <dir>/<fixture>.txt, so two commits'
// outcomes can be compared field by field rather than only by hash.
//
// The engines' executable digests are the values a build changes without changing an answer: the reasoner's and every
// other `executableDigest` (erden-shacl's) are replaced by EXECUTABLE_PLACEHOLDER before hashing, so a new engine build
// with the same answers gives the recorded bytes too.
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { Effect } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { encodeCheckProjectReport } from '@erden/contracts';
import {
    inspectNodeBundledReasoner,
    makeNodeOntologyPorts,
    makeOntologyService,
    nodeReasonerService,
} from '@erden/ontology';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import { makeCheckProjectService, makeManifestService } from '../src/index.js';

import { buildDifferentialFixtures, type DifferentialFixture } from './support/differential-fixtures.js';

const RECORDED = new URL('./fixtures/check-main-reports.json', import.meta.url);
const EXECUTABLE_PLACEHOLDER = `sha256:${'e'.repeat(64)}`;

let root: string;
let fixtures: ReadonlyArray<DifferentialFixture>;

beforeAll(async () => {
    root = makeTestTempRoot('erden-check-main-reports-');
    fixtures = await buildDifferentialFixtures(root);
}, 180_000);

// Removing the fixture tree checks every entry's ownership and mount on the way: about 12 s on a busy host, so it gets
// the setup's budget, not the 10 s default.
afterAll(() => {
    cleanupTestTempRoot(root);
}, 180_000);

/** What one check ends with, as bytes: the report `erden check --json` prints, or the refusal's fields. */
async function outcomeBytes(fixture: DifferentialFixture): Promise<string> {
    const service = makeCheckProjectService(
        makeManifestService(),
        makeOntologyService(makeNodeOntologyPorts()),
        nodeReasonerService,
    );
    const result = await Effect.runPromise(
        Effect.result(service.check({ from: fixture.from, offline: true, ...fixture.options })),
    );
    const executable = inspectNodeBundledReasoner().digest ?? EXECUTABLE_PLACEHOLDER;
    function normalized(text: string): string {
        return text
            .replaceAll(executable, EXECUTABLE_PLACEHOLDER)
            .replaceAll(/"executableDigest":"sha256:[0-9a-f]{64}"/gu, `"executableDigest":"${EXECUTABLE_PLACEHOLDER}"`);
    }
    if (result._tag === 'Success') {
        return normalized(encodeCheckProjectReport(result.success));
    }
    const { name, code, stage, message, diagnostics } = result.failure as unknown as Record<string, unknown>;
    return normalized(`${JSON.stringify({ name, code, stage, message, diagnostics })}\n`);
}

// The reports were recorded on Linux x64; the reasoner-build workflow compares the platforms' answers instead.
const RECORDED_PLATFORM = process.platform === 'linux' && process.arch === 'x64';

describe('check outcomes against main', () => {
    it.skipIf(!RECORDED_PLATFORM)(
        'gives the bytes main gives on every differential fixture, refusals and inconsistencies included',
        async () => {
            const reports: Record<string, string> = {};
            const dump = process.env.ERDEN_CHECK_MAIN_REPORTS_DUMP;
            if (dump !== undefined && dump !== '') {
                mkdirSync(dump, { recursive: true });
            }
            for (const fixture of fixtures) {
                const bytes = await outcomeBytes(fixture);
                if (dump !== undefined && dump !== '') {
                    writeFileSync(join(dump, `${fixture.name}.txt`), bytes);
                }
                reports[fixture.name] = createHash('sha256').update(bytes).digest('hex');
            }
            const record = process.env.ERDEN_CHECK_MAIN_REPORTS_RECORD;
            if (record !== undefined && record !== '') {
                writeFileSync(record, `${JSON.stringify({ reports }, null, 4)}\n`);
                return;
            }
            const recorded = JSON.parse(readFileSync(RECORDED, 'utf8')) as { readonly reports: Record<string, string> };
            expect(reports).toEqual(recorded.reports);
        },
        300_000,
    );
});
