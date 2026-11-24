import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { writeArchive } from '../../release/lib/archive.mjs';
import { RELEASE_PLATFORMS, archiveName, hostPlatform } from '../../release/lib/platforms.mjs';
import {
    MAIN_PACKAGE,
    REPOSITORY_URL,
    buildNpmPackages,
    distTag,
    mainManifest,
    platformManifest,
    platformPackageName,
} from '../../release/npm-packages.mjs';
import { TRUSTED_PUBLISHER, trustCommands } from '../npm-bootstrap.mjs';

const root = resolve(import.meta.dirname, '../..');
const launcherPath = join(root, 'release/npm/launcher.cjs');
const launcher = createRequire(import.meta.url)(launcherPath);
// npm pack and the archive tools these tests drive are the release workflow's, on Linux and macOS.
const posixOnly = {
    skip: process.platform === 'win32' ? 'the npm packages are built and tested on Linux and macOS' : false,
};

function temporary(context, prefix) {
    const directory = mkdtempSync(join(tmpdir(), `erden-npm-${prefix}-`));
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    return directory;
}

test('@erden-sh/cli names every release platform package, exactly at its own version', () => {
    const manifest = mainManifest('1.2.3');
    assert.equal(manifest.name, MAIN_PACKAGE);
    assert.equal(manifest.version, '1.2.3');
    assert.deepEqual(manifest.bin, { den: 'bin/erden.cjs', erden: 'bin/erden.cjs' });
    assert.deepEqual(
        manifest.optionalDependencies,
        Object.fromEntries(
            Object.keys(RELEASE_PLATFORMS)
                .sort()
                .map((platform) => [`@erden-sh/cli-${platform}`, '1.2.3']),
        ),
    );
    assert.equal(manifest.dependencies, undefined);
    assert.equal(manifest.scripts, undefined, 'no install scripts');
    // npm's provenance and trusted publishing require the repository the workflow runs in.
    assert.equal(manifest.repository.url, REPOSITORY_URL);
    assert.equal(manifest.author, 'Ingenio Ventures Inc');
    assert.equal(manifest.license, 'Apache-2.0');
});

test('each platform package is installable only where its archive runs', () => {
    for (const [platform, { os, cpu, libc }] of Object.entries(RELEASE_PLATFORMS)) {
        const manifest = platformManifest('1.2.3', platform);
        assert.equal(manifest.name, platformPackageName(platform));
        assert.equal(manifest.version, '1.2.3');
        assert.deepEqual(manifest.os, [os]);
        assert.deepEqual(manifest.cpu, [cpu]);
        assert.deepEqual(manifest.libc, os === 'linux' ? [libc ?? 'glibc'] : undefined, platform);
        assert.equal(manifest.bin, undefined, `${platform} adds no command of its own`);
        assert.equal(manifest.scripts, undefined, 'no install scripts');
        assert.equal(manifest.repository.url, REPOSITORY_URL);
    }
    assert.throws(() => platformPackageName('darwin-x64'), /not a release platform/u);
});

test('the launcher knows the release platforms and names them as the archives do', () => {
    assert.deepEqual([...launcher.PLATFORMS].sort(), Object.keys(RELEASE_PLATFORMS).sort());
    assert.equal(launcher.platformName('linux', 'x64', 'musl'), 'linux-x64-musl');
    assert.equal(launcher.platformName('linux', 'arm64', undefined), 'linux-arm64');
    assert.equal(launcher.platformName('win32', 'x64', undefined), 'win32-x64');
    for (const platform of Object.keys(RELEASE_PLATFORMS)) {
        const { os, cpu, libc } = RELEASE_PLATFORMS[platform];
        assert.equal(launcher.platformName(os, cpu, libc), platform);
    }
});

test('a release candidate is published under next, a release under latest', () => {
    assert.equal(distTag('1.2.3'), 'latest');
    assert.equal(distTag('1.2.3-rc.1'), 'next');
});

test('the bootstrap trusts release.yml in the npm environment for every package', () => {
    const commands = trustCommands();
    assert.deepEqual(TRUSTED_PUBLISHER, { repository: 'erden-sh/erden', workflow: 'release.yml', environment: 'npm' });
    assert.deepEqual(
        commands.map((args) => args[2]),
        [...Object.keys(RELEASE_PLATFORMS).sort().map(platformPackageName), MAIN_PACKAGE],
    );
    for (const args of commands) {
        assert.deepEqual(args.slice(0, 2), ['trust', 'github']);
        for (const [flag, value] of [
            ['--file', 'release.yml'],
            ['--repo', 'erden-sh/erden'],
            ['--env', 'npm'],
        ]) {
            assert.equal(args[args.indexOf(flag) + 1], value, flag);
        }
        assert.ok(args.includes('--allow-publish'));
    }
});

/** A pinned release of fixture archives under `directory`: release/pins/<version>.json and the archives in assets/. */
function fixtureRelease(directory, version, extra = {}) {
    const assets = join(directory, 'assets');
    mkdirSync(assets, { recursive: true });
    const archives = {};
    for (const platform of Object.keys(RELEASE_PLATFORMS)) {
        const tree = join(directory, 'trees', platform);
        const windows = RELEASE_PLATFORMS[platform].os === 'win32';
        mkdirSync(join(tree, 'bin'), { recursive: true });
        mkdirSync(join(tree, 'lib/node_modules/@erden/reasoner-x/bin'), { recursive: true });
        mkdirSync(join(tree, 'THIRD-PARTY-NOTICES/npm'), { recursive: true });
        writeFileSync(join(tree, 'LICENSE'), 'license\n');
        writeFileSync(join(tree, 'NOTICE'), 'notice\n');
        writeFileSync(join(tree, 'THIRD-PARTY-NOTICES/npm/THIRD-PARTY-NOTICES.md'), 'notices\n');
        writeFileSync(join(tree, 'lib/package.json'), '{"name":"@erden/cli","version":"0.0.0"}\n');
        writeFileSync(join(tree, 'lib/node_modules/@erden/reasoner-x/package.json'), '{"name":"@erden/reasoner-x"}\n');
        writeFileSync(join(tree, 'lib/node_modules/@erden/reasoner-x/bin/erden-reasoner'), `reasoner ${platform}\n`);
        writeFileSync(join(tree, windows ? 'bin/erden.exe' : 'bin/erden'), `erden ${platform}\n`);
        writeFileSync(join(tree, windows ? 'bin/den.cmd' : 'bin/den'), 'den\n');
        for (const [path, contents] of Object.entries(extra)) {
            writeFileSync(join(tree, path), contents);
        }
        if (!windows) {
            chmodSync(join(tree, 'bin/erden'), 0o755);
            chmodSync(join(tree, 'bin/den'), 0o755);
        }
        const file = archiveName(version, platform);
        archives[platform] = {
            file,
            ...writeArchive(tree, `erden-${version}-${platform}`, join(assets, file), 1_700_000_000),
        };
    }
    mkdirSync(join(directory, 'release/pins'), { recursive: true });
    writeFileSync(
        join(directory, 'release/pins', `${version}.json`),
        JSON.stringify({ schema: 'erden.release-pins/v1', version, complete: true, archives }),
    );
    return assets;
}

test('the packages hold their archives byte for byte, and the packed tarballs are checked', posixOnly, (context) => {
    const directory = temporary(context, 'build');
    const assets = fixtureRelease(directory, '9.9.9');
    const packages = buildNpmPackages({
        assets,
        version: '9.9.9',
        out: join(directory, 'out'),
        packInto: join(directory, 'tarballs'),
        pinsRoot: directory,
    });
    assert.deepEqual(
        packages.map((entry) => entry.name),
        [...Object.keys(RELEASE_PLATFORMS).sort().map(platformPackageName), MAIN_PACKAGE],
        'platform packages first',
    );
    for (const entry of packages) {
        // The archive's 8 files (nested node_modules included) and package.json and README.md; the launcher's 5.
        assert.equal(entry.files, entry.name === MAIN_PACKAGE ? 5 : 10, entry.name);
    }
    const linux = join(directory, 'out/cli-linux-x64');
    assert.equal(readFileSync(join(linux, 'bin/erden'), 'utf8'), 'erden linux-x64\n');
    assert.equal(
        readFileSync(join(linux, 'lib/node_modules/@erden/reasoner-x/bin/erden-reasoner'), 'utf8'),
        'reasoner linux-x64\n',
    );
    assert.deepEqual(
        JSON.parse(readFileSync(join(linux, 'package.json'), 'utf8')),
        platformManifest('9.9.9', 'linux-x64'),
    );
    assert.equal(readFileSync(join(directory, 'out/cli/bin/erden.cjs'), 'utf8'), readFileSync(launcherPath, 'utf8'));
});

test('an archive that is not the pinned one is refused', posixOnly, (context) => {
    const directory = temporary(context, 'tampered');
    const assets = fixtureRelease(directory, '9.9.9');
    const file = join(assets, archiveName('9.9.9', 'linux-arm64'));
    const bytes = readFileSync(file);
    bytes[bytes.length - 1] ^= 1;
    writeFileSync(file, bytes);
    assert.throws(
        () => buildNpmPackages({ assets, version: '9.9.9', out: join(directory, 'out'), pinsRoot: directory }),
        /linux-arm64 archive .* is not the pinned file/u,
    );
});

test("a tarball that npm packed without some of the archive's files is refused", posixOnly, (context) => {
    const directory = temporary(context, 'ignored');
    // npm pack reads a nested .gitignore as its ignore rules: it would leave out the engine and the file itself.
    const assets = fixtureRelease(directory, '9.9.9', { 'lib/node_modules/@erden/reasoner-x/.gitignore': 'bin\n' });
    assert.throws(
        () =>
            buildNpmPackages({
                assets,
                version: '9.9.9',
                out: join(directory, 'out'),
                packInto: join(directory, 'tarballs'),
                pinsRoot: directory,
            }),
        /does not hold the package's files: missing .*erden-reasoner/u,
    );
});

/** An installed @erden-sh/cli whose platform package for this host has `executable` as bin/erden. */
function installedLauncher(context, executable) {
    const directory = temporary(context, 'launcher');
    const modules = join(directory, 'node_modules/@erden-sh');
    mkdirSync(join(modules, 'cli/bin'), { recursive: true });
    copyFileSync(launcherPath, join(modules, 'cli/bin/erden.cjs'));
    if (executable !== undefined) {
        const host = join(modules, `cli-${hostPlatform()}`);
        mkdirSync(join(host, 'bin'), { recursive: true });
        writeFileSync(join(host, 'package.json'), '{"name":"fixture"}\n');
        writeFileSync(join(host, 'bin/erden'), executable);
        chmodSync(join(host, 'bin/erden'), 0o755);
    }
    return join(modules, 'cli/bin/erden.cjs');
}

const hostOnly = {
    skip:
        process.platform === 'win32' || hostPlatform() === undefined
            ? 'runs a POSIX shell script as the platform executable'
            : false,
};

test('the launcher runs its platform package with the arguments, and ends as it does', hostOnly, (context) => {
    const bin = installedLauncher(context, '#!/bin/sh\nprintf "%s|" "$@"\n[ "$1" = kill ] && kill -TERM $$\nexit 7\n');
    const passed = spawnSync(process.execPath, [bin, 'check', '--json', 'a b'], { encoding: 'utf8' });
    assert.equal(passed.stdout, 'check|--json|a b|');
    assert.equal(passed.status, 7);
    const killed = spawnSync(process.execPath, [bin, 'kill'], { encoding: 'utf8' });
    assert.equal(killed.signal, 'SIGTERM');
});

test('the launcher names the missing platform package and the other ways to install', hostOnly, (context) => {
    const bin = installedLauncher(context, undefined);
    const refused = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8' });
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, new RegExp(`@erden-sh/cli-${hostPlatform()}, which is not installed`, 'u'));
    assert.match(refused.stderr, /https:\/\/erden\.sh\/install/u);
});
