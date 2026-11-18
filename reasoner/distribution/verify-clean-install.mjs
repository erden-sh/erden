import assert from 'node:assert/strict';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { QUALIFIED_REASONER_ARTIFACTS, REASONER_TOOL } from './src/index.js';

const expectedRuntime = process.argv[2];
const inactivePolicy = process.argv[3] ?? 'must-be-absent';
// The pins come from this checkout's resolver anchors: the installed packages must carry exactly those binaries.
const platforms = {
    windows: { key: 'win32:x64', executable: false },
    linux: { key: 'linux:x64:glibc', executable: true },
    'linux-arm64': { key: 'linux:arm64:glibc', executable: true },
    'darwin-arm64': { key: 'darwin:arm64', executable: true },
};
if (!Object.hasOwn(platforms, expectedRuntime ?? '')) {
    throw new Error(`Expected one of ${Object.keys(platforms).join(', ')}`);
}
if (inactivePolicy !== 'must-be-absent' && inactivePolicy !== 'may-be-present') {
    throw new Error('Expected inactive package policy');
}

const anchor = QUALIFIED_REASONER_ARTIFACTS[platforms[expectedRuntime].key];
const expected = { name: anchor.packageName, digest: anchor.sha256, executable: platforms[expectedRuntime].executable };
const version = REASONER_TOOL.version;
const nodeModules = resolve('node_modules');
const resolverRoot = resolve(nodeModules, '@erden/reasoner-distribution');
const platformRoot = resolve(nodeModules, expected.name);

assert.equal(process.version, 'v24.17.0');
assert.equal(existsSync(platformRoot), true, `missing compatible package ${expected.name}`);
const otherPlatformPackages = readdirSync(resolve(nodeModules, '@erden')).filter(
    (name) => name.startsWith('reasoner-') && name !== 'reasoner-distribution' && `@erden/${name}` !== expected.name,
);
const incompatiblePlatformPackagePresent = otherPlatformPackages.length > 0;
if (inactivePolicy === 'must-be-absent') {
    assert.deepEqual(otherPlatformPackages, [], 'an incompatible platform package was installed');
}
const resolverManifest = JSON.parse(readFileSync(resolve(resolverRoot, 'package.json'), 'utf8'));
assert.equal(resolverManifest.version, version);
assert.deepEqual(resolverManifest.optionalDependencies, {
    '@erden/reasoner-darwin-arm64': version,
    '@erden/reasoner-linux-arm64-gnu': version,
    '@erden/reasoner-linux-x64-gnu': version,
    '@erden/reasoner-win32-x64-msvc': version,
});
assert.equal(JSON.parse(readFileSync(resolve(platformRoot, 'package.json'), 'utf8')).version, version);

const distribution = await import(pathToFileURL(resolve(resolverRoot, 'src/index.js')).href);
const doctor = distribution.inspectBundledReasoner({ runSelfTest: true });
assert.equal(doctor.availability, 'available');
assert.equal(doctor.actualPlatformPackage, expected.name);
assert.equal(doctor.packageVersion, version);
assert.equal(doctor.toolVersion, version);
assert.equal(doctor.digest, expected.digest);
assert.equal(doctor.selfTest.status, 'passed');
const binaryStat = lstatSync(doctor.path);
assert.equal(binaryStat.isFile(), true);
if (expected.executable) {
    assert.notEqual(binaryStat.mode & 0o111, 0, 'The reasoner binary must be executable after install');
}

process.stdout.write(
    `${JSON.stringify({
        node: process.version,
        platform: process.platform,
        installedPlatformPackage: expected.name,
        inactivePolicy,
        incompatiblePlatformPackagePresent,
        version,
        digest: doctor.digest,
        selfTest: doctor.selfTest.status,
        executable: expected.executable ? true : undefined,
        offline: true,
    })}\n`,
);
