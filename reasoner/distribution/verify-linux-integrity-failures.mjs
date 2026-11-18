import assert from 'node:assert/strict';
import { chmodSync, cpSync, mkdirSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { QUALIFIED_REASONER_ARTIFACTS, REASONER_TOOL } from './src/index.js';

assert.equal(process.platform, 'linux');
const resolverRoot = realpathSync(resolve('node_modules/@erden/reasoner-distribution'));
const sourcePackage = realpathSync(resolve('node_modules/@erden/reasoner-linux-x64-gnu'));
const distribution = await import(pathToFileURL(resolve(resolverRoot, 'src/index.js')).href);
const runtime = { platform: 'linux', arch: 'x64', libc: 'glibc' };
// This checkout's pins for the package under test.
const anchor = QUALIFIED_REASONER_ARTIFACTS['linux:x64:glibc'];

function expectCode(directory, code) {
    assert.throws(
        () => distribution.resolveBundledReasoner({ runtime, locatePackage: () => directory }),
        (error) => error instanceof distribution.BundledReasonerError && error.code === code,
    );
}

async function expectFixtureCode(directory) {
    const mutated = await import(`${pathToFileURL(resolve(directory, 'src/index.js')).href}?mutation=${Date.now()}`);
    const options = { runtime, locatePackage: () => sourcePackage };
    assert.throws(
        () => mutated.runBundledReasonerKnownAnswer(options),
        (error) => error instanceof mutated.BundledReasonerError && error.code === 'SELF_TEST_FAILED',
    );
    assert.doesNotThrow(() => mutated.inspectBundledReasoner({ ...options, runSelfTest: true }));
    assert.deepEqual(mutated.inspectBundledReasoner({ ...options, runSelfTest: true }), {
        availability: 'unavailable',
        expectedPlatformPackage: '@erden/reasoner-linux-x64-gnu',
        actualPlatformPackage: '@erden/reasoner-linux-x64-gnu',
        packageVersion: REASONER_TOOL.version,
        toolVersion: REASONER_TOOL.version,
        path: undefined,
        size: anchor.bytes,
        digest: anchor.sha256,
        target: 'x86_64-unknown-linux-gnu',
        requiredTool: undefined,
        failureCode: 'SELF_TEST_FAILED',
        supportedPlatforms: undefined,
        selfTest: { status: 'failed', failureCode: 'SELF_TEST_FAILED' },
    });
}

const mutations = resolve('linux-integrity-mutations');
mkdirSync(mutations);
try {
    const nonExecutable = resolve(mutations, 'non-executable');
    cpSync(sourcePackage, nonExecutable, { recursive: true });
    chmodSync(resolve(nonExecutable, 'bin/erden-reasoner'), 0o644);
    expectCode(nonExecutable, 'BINARY_NOT_EXECUTABLE');

    const symlinked = resolve(mutations, 'symlinked');
    cpSync(sourcePackage, symlinked, { recursive: true });
    rmSync(resolve(symlinked, 'bin/erden-reasoner'));
    symlinkSync('/bin/true', resolve(symlinked, 'bin/erden-reasoner'));
    expectCode(symlinked, 'SYMLINK_DISALLOWED');

    const fixtureNonRegular = resolve(mutations, 'fixture-non-regular');
    cpSync(resolverRoot, fixtureNonRegular, { recursive: true });
    rmSync(resolve(fixtureNonRegular, 'fixtures/known-answer.request.json'));
    mkdirSync(resolve(fixtureNonRegular, 'fixtures/known-answer.request.json'));
    await expectFixtureCode(fixtureNonRegular);

    const fixtureSymlinked = resolve(mutations, 'fixture-symlinked');
    cpSync(resolverRoot, fixtureSymlinked, { recursive: true });
    rmSync(resolve(fixtureSymlinked, 'fixtures/known-answer.request.json'));
    symlinkSync(
        resolve(resolverRoot, 'fixtures/known-answer.request.json'),
        resolve(fixtureSymlinked, 'fixtures/known-answer.request.json'),
    );
    await expectFixtureCode(fixtureSymlinked);

    process.stdout.write(
        `${JSON.stringify({
            fixtureNonRegularFailure: 'passed',
            fixtureSymlinkFailure: 'passed',
            linuxPermissionFailure: 'passed',
            linuxSymlinkFailure: 'passed',
        })}\n`,
    );
} finally {
    rmSync(mutations, { recursive: true, force: true });
}
