import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';

import { MUSL_BUILD_IMAGE } from '../../release/build-musl-archive.mjs';
import {
    collectEntries,
    gzipBytes,
    tarBytes,
    writeArchive,
    writeArchives,
    zipBytes,
} from '../../release/lib/archive.mjs';
import { SIDECAR_URL_MODULES, sidecarPackages } from '../../release/lib/bundle.mjs';
import { normalizeDeployedWorkspace, prepareLockedDeployment } from '../../release/lib/deploy.mjs';
import { declaredLicense, writeNpmNotices } from '../../release/lib/notices.mjs';
import { RELEASE_PLATFORMS, archiveName, assertPinned, hostPlatform, sha256 } from '../../release/lib/platforms.mjs';
import { pruneDeployedTree } from '../../release/lib/prune.mjs';
import { removeAuthenticodeSignature } from '../../release/lib/sea.mjs';
import { acceptedBuildResult, pinDifferences, pinsOf } from '../../release/pins.mjs';

const root = resolve(import.meta.dirname, '../..');
const YAML = createRequire(join(root, 'packages/contracts/package.json'))('yaml');

function temporary(prefix) {
    return mkdtempSync(join(tmpdir(), `erden-release-${prefix}-`));
}

function deploymentFixture(context, buildPath) {
    const directory = temporary('locked-deploy');
    context.after(() => rmSync(directory, { recursive: true, force: true }));
    const source = join(directory, 'source');
    const lib = join(directory, 'lib');
    function manifest(path, value) {
        mkdirSync(path, { recursive: true });
        writeFileSync(join(path, 'package.json'), JSON.stringify(value));
    }
    mkdirSync(source);
    writeFileSync(join(source, 'pnpm-workspace.yaml'), "packages:\n  - 'apps/*'\n  - 'packages/*'\n");
    const cli = {
        name: '@erden/cli',
        version: '0.1.0',
        license: 'Apache-2.0',
        dependencies: { '@erden/client': 'workspace:0.0.0', effect: '4.0.0-rc.111' },
    };
    const client = { name: '@erden/client', version: '0.0.0', license: 'Apache-2.0' };
    manifest(join(source, 'apps/cli'), cli);
    manifest(join(source, 'packages/client'), client);
    manifest(lib, {
        ...cli,
        dependencies: { '@erden/client': `@erden/client@file://${buildPath}/client`, effect: '4.0.0-rc.111' },
        pnpm: { patchedDependencies: { unused: `${buildPath}/patch` } },
    });
    manifest(join(lib, 'node_modules/@erden/client'), client);
    manifest(join(lib, 'node_modules/effect'), { name: 'effect', version: '4.0.0-rc.111', license: 'MIT' });
    writeFileSync(join(lib, 'pnpm-lock.yaml'), `temporary: ${buildPath}\n`);
    return {
        source,
        lib,
        manifest,
        lockfile: { packages: { 'effect@4.0.0-rc.111': { resolution: { integrity: 'fixture' } } } },
    };
}

test('locked deployment keeps the pnpm environment document and sets injection on the dependency lockfile', (context) => {
    const source = temporary('lockfile-documents');
    context.after(() => rmSync(source, { recursive: true, force: true }));
    mkdirSync(join(source, 'packages/contracts'), { recursive: true });
    writeFileSync(join(source, 'packages/contracts/package.json'), '{}');
    symlinkSync(join(root, 'packages/contracts/node_modules'), join(source, 'packages/contracts/node_modules'), 'dir');
    const environment = [
        '---',
        "lockfileVersion: '9.0'",
        '',
        'importers:',
        '',
        '  .:',
        '    packageManagerDependencies:',
        '      pnpm:',
        '        specifier: 12.21.0',
        '        version: 12.21.0',
        '',
        'packages:',
        '',
        '  pnpm@12.21.0:',
        '    resolution: {integrity: sha512-fixture}',
        '',
        '---',
        '',
    ].join('\n');
    const dependencies = [
        "lockfileVersion: '9.0'",
        '',
        'settings:',
        '  autoInstallPeers: true',
        '',
        'importers:',
        '',
        '  .: {}',
        '',
        'packages:',
        '',
        '  effect@4.0.0-rc.111:',
        '    resolution: {integrity: sha512-effect}',
        '',
    ].join('\n');
    const text = `${environment}${dependencies}`;
    writeFileSync(join(source, 'pnpm-lock.yaml'), text);
    const prepared = prepareLockedDeployment(source);
    assert.equal(prepared.digest, sha256(text));
    assert.deepEqual(Object.keys(prepared.lockfile.packages), ['effect@4.0.0-rc.111']);
    const written = readFileSync(join(source, 'pnpm-lock.yaml'), 'utf8');
    assert.ok(written.startsWith(environment));
    const documents = YAML.parseAllDocuments(written).map((document) => document.toJS());
    assert.equal(documents.length, 2);
    assert.equal(documents[0].packages['pnpm@12.21.0'].resolution.integrity, 'sha512-fixture');
    assert.deepEqual(documents[1].settings, { autoInstallPeers: true, injectWorkspacePackages: true });
});

test('locked deployment produces portable metadata independent of its temporary build path', (context) => {
    const first = deploymentFixture(context, '/build/a');
    const second = deploymentFixture(context, '/build/b');
    for (const fixture of [first, second]) {
        normalizeDeployedWorkspace(fixture.source, fixture.lib, fixture.lockfile);
        const manifest = JSON.parse(readFileSync(join(fixture.lib, 'package.json'), 'utf8'));
        assert.deepEqual(manifest.dependencies, { '@erden/client': '0.0.0', effect: '4.0.0-rc.111' });
        assert.equal(manifest.pnpm, undefined);
        assert.equal(existsSync(join(fixture.lib, 'pnpm-lock.yaml')), false);
    }
    assert.equal(
        readFileSync(join(first.lib, 'package.json'), 'utf8'),
        readFileSync(join(second.lib, 'package.json'), 'utf8'),
    );
});

test('locked deployment rejects a dependency version absent from the committed graph', (context) => {
    const fixture = deploymentFixture(context, '/build/a');
    fixture.manifest(join(fixture.lib, 'node_modules/effect'), { name: 'effect', version: '5.0.0', license: 'MIT' });
    assert.throws(
        () => normalizeDeployedWorkspace(fixture.source, fixture.lib, fixture.lockfile),
        /effect@5.0.0 outside its source lockfile/u,
    );
});

test('locked deployment refuses proprietary workspace packages before archiving', (context) => {
    const fixture = deploymentFixture(context, '/build/a');
    const application = { name: '@erden/application', version: '0.0.0', license: 'UNLICENSED' };
    fixture.manifest(join(fixture.source, 'packages/application'), application);
    fixture.manifest(join(fixture.lib, 'node_modules/@erden/application'), application);
    assert.throws(
        () => normalizeDeployedWorkspace(fixture.source, fixture.lib, fixture.lockfile),
        /non-open.*@erden\/application/u,
    );
});

function tree() {
    const directory = temporary('tree');
    mkdirSync(join(directory, 'bin'));
    mkdirSync(join(directory, 'lib', 'node_modules', 'deep', 'a'.repeat(60), 'b'.repeat(60)), { recursive: true });
    writeFileSync(join(directory, 'bin', 'erden'), '#!/bin/sh\n');
    chmodSync(join(directory, 'bin', 'erden'), 0o775);
    writeFileSync(join(directory, 'LICENSE'), 'license\n');
    writeFileSync(join(directory, 'lib', 'node_modules', 'deep', 'a'.repeat(60), 'b'.repeat(60), 'index.js'), 'x\n');
    return directory;
}

test('archives of the same tree are byte-identical, sorted, with fixed owners, modes and times', () => {
    const directory = tree();
    const out = temporary('out');
    try {
        const first = writeArchive(directory, 'erden-1.0.0-linux-x64', join(out, 'a.tar.gz'), 1_700_000_000);
        chmodSync(join(directory, 'LICENSE'), 0o600);
        const second = writeArchive(directory, 'erden-1.0.0-linux-x64', join(out, 'b.tar.gz'), 1_700_000_000);
        assert.deepEqual(first, second);
        const listing = spawnSync('tar', ['-tvzf', join(out, 'a.tar.gz')], { encoding: 'utf8' });
        assert.equal(listing.status, 0, listing.stderr);
        const lines = listing.stdout.trim().split(/\r?\n/u);
        // GNU tar lists owner and group as `0/0`; bsdtar, on macOS and Windows, as link count, owner and group columns.
        const rootOwned = String.raw`\s+(?:0\/0|\d+\s+0\s+0)\s`;
        assert.match(
            lines.find((line) => line.endsWith('bin/erden')),
            // Windows has no executable bit to read, and it ships the zip, whose modes nothing there uses.
            new RegExp(`^${process.platform === 'win32' ? '-rw-r--r--' : '-rwxr-xr-x'}${rootOwned}`, 'u'),
        );
        assert.match(
            lines.find((line) => line.endsWith('/LICENSE')),
            new RegExp(`^-rw-r--r--${rootOwned}`, 'u'),
        );
        assert.ok(
            lines.some((line) => line.endsWith(`${'b'.repeat(60)}/index.js`)),
            'a long path survives as a pax record',
        );
        const gzip = readFileSync(join(out, 'a.tar.gz'));
        assert.deepEqual([...gzip.subarray(4, 10)], [0, 0, 0, 0, 2, 255]);
        const zip = zipBytes(collectEntries(directory, 'erden-1.0.0-win32-x64'), 1_700_000_000);
        assert.deepEqual(zip, zipBytes(collectEntries(directory, 'erden-1.0.0-win32-x64'), 1_700_000_000));
        assert.equal(zip.readUInt32LE(zip.length - 22), 0x06054b50);
        assert.equal(
            gzipBytes(tarBytes(collectEntries(directory, 'p'), 1)).equals(
                gzipBytes(tarBytes(collectEntries(directory, 'p'), 2)),
            ),
            false,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
        rmSync(out, { recursive: true, force: true });
    }
});

const HAS_XZ = spawnSync('xz', ['--version']).status === 0;

test(
    'a .tar.xz holds the same tar as the .tar.gz and is byte-identical on every run',
    { skip: !HAS_XZ && 'no xz' },
    () => {
        const directory = tree();
        const out = temporary('xz');
        try {
            const outputs = ['a.tar.gz', 'a.tar.xz', 'b.tar.xz'].map((name) => join(out, name));
            const [, first, second] = writeArchives(directory, 'erden-1.0.0-linux-x64', outputs, 1_700_000_000);
            assert.deepEqual(first, second);
            const xz = spawnSync('xz', ['-dc', outputs[1]]);
            const gz = spawnSync('gzip', ['-dc', outputs[0]]);
            assert.equal(xz.status, 0);
            assert.ok(xz.stdout.equals(gz.stdout), 'both archives hold the same tar');
            const list = spawnSync('xz', ['--list', '--robot', outputs[1]], { encoding: 'utf8' });
            assert.match(list.stdout, /^file\t1\t1\t/mu, 'one stream, one block: written on one thread');
            assert.match(list.stdout, /\tCRC64\t/u);
        } finally {
            rmSync(directory, { recursive: true, force: true });
            rmSync(out, { recursive: true, force: true });
        }
    },
);

test('the archive leaves out what the CLI never loads and keeps what it does', () => {
    const lib = temporary('prune');
    try {
        const files = {
            'package.json': '{}',
            'dist/main.js': '',
            'src/main.ts': '',
            'node_modules/effect/src/Effect.ts': '',
            'node_modules/effect/dist/Effect.js': '',
            'node_modules/effect/dist/Effect.d.ts': '',
            'node_modules/effect/dist/Effect.js.map': '',
            'node_modules/effect/dist/Effect.d.cts': '',
            'node_modules/oxigraph/node.js': '',
            'node_modules/oxigraph/node_bg.wasm': '',
            'node_modules/oxigraph/web.js': '',
            'node_modules/oxigraph/web_bg.wasm': '',
            'node_modules/oxigraph/LICENSE': '',
            'node_modules/@erden/reasoner-distribution/src/index.js': '',
            'node_modules/@erden/reasoner-linux-x64-gnu/bin/erden-reasoner': '',
            'node_modules/@erden/reasoner-linux-arm64-gnu/metadata.json': '',
            'node_modules/@erden/shacl-win32-x64-msvc/metadata.json': '',
            'node_modules/@erden/shacl-linux-x64-gnu/metadata.json': '',
        };
        for (const [path, text] of Object.entries(files)) {
            mkdirSync(join(lib, path, '..'), { recursive: true });
            writeFileSync(join(lib, path), text);
        }
        const removed = pruneDeployedTree(lib, [
            'node_modules/@erden/reasoner-linux-x64-gnu',
            'node_modules/@erden/shacl-linux-x64-gnu',
        ]);
        assert.deepEqual(removed, [
            'node_modules/@erden/reasoner-linux-arm64-gnu/',
            'node_modules/@erden/shacl-win32-x64-msvc/',
            'node_modules/effect/dist/Effect.d.cts',
            'node_modules/effect/dist/Effect.d.ts',
            'node_modules/effect/dist/Effect.js.map',
            'node_modules/effect/src/Effect.ts',
            'node_modules/oxigraph/web.js',
            'node_modules/oxigraph/web_bg.wasm',
            'src/main.ts',
        ]);
        const kept = collectEntries(lib, 'lib')
            .filter((entry) => !entry.directory)
            .map((entry) => entry.name.slice('lib/'.length));
        assert.deepEqual(kept, [
            'dist/main.js',
            'node_modules/@erden/reasoner-distribution/src/index.js',
            'node_modules/@erden/reasoner-linux-x64-gnu/bin/erden-reasoner',
            'node_modules/@erden/shacl-linux-x64-gnu/metadata.json',
            'node_modules/effect/dist/Effect.js',
            'node_modules/oxigraph/LICENSE',
            'node_modules/oxigraph/node.js',
            'node_modules/oxigraph/node_bg.wasm',
            'package.json',
        ]);
        assert.equal(existsSync(join(lib, 'src')), false, 'an emptied directory goes too');
    } finally {
        rmSync(lib, { recursive: true, force: true });
    }
});

test('a Windows executable loses its Authenticode signature before the CLI is injected', () => {
    const directory = temporary('pe');
    try {
        // A minimal PE32+ header: 'MZ', e_lfanew at 0x3c, 'PE\0\0', a file header and the optional header magic.
        const pe = 0x80;
        const directories = pe + 24 + 112;
        const body = Buffer.alloc(directories + 16 * 8 + 64);
        body.write('MZ', 0, 'latin1');
        body.writeUInt32LE(pe, 0x3c);
        body.writeUInt32LE(0x00004550, pe);
        body.writeUInt16LE(0x20b, pe + 24);
        const signature = Buffer.alloc(40, 7);
        body.writeUInt32LE(body.length, directories + 4 * 8);
        body.writeUInt32LE(signature.length, directories + 4 * 8 + 4);
        const path = join(directory, 'node.exe');
        writeFileSync(path, Buffer.concat([body, signature]));
        assert.equal(removeAuthenticodeSignature(path), 40);
        const unsigned = readFileSync(path);
        assert.equal(unsigned.length, body.length);
        assert.equal(unsigned.readUInt32LE(directories + 4 * 8), 0);
        assert.equal(unsigned.readUInt32LE(directories + 4 * 8 + 4), 0);
        assert.equal(removeAuthenticodeSignature(path), 0, 'an unsigned file is left as it is');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the sidecar holds the engines, n3 and rdf-canonize with what they import, and nothing else', () => {
    const lib = temporary('sidecar');
    try {
        const manifests = {
            n3: { dependencies: { 'readable-stream': '1' } },
            'readable-stream': { dependencies: { buffer: '1' } },
            buffer: {},
            'rdf-canonize': { dependencies: { setimmediate: '1' } },
            setimmediate: {},
            effect: {},
        };
        for (const [name, manifest] of Object.entries(manifests)) {
            mkdirSync(join(lib, 'node_modules', name), { recursive: true });
            writeFileSync(join(lib, 'node_modules', name, 'package.json'), JSON.stringify({ name, ...manifest }));
        }
        assert.deepEqual(sidecarPackages(lib, ['@erden/shacl-linux-x64-gnu']), [
            '@erden/reasoner-distribution',
            '@erden/shacl-distribution',
            '@erden/shacl-linux-x64-gnu',
            'buffer',
            'n3',
            'rdf-canonize',
            'readable-stream',
            'setimmediate',
        ]);
        assert.ok(SIDECAR_URL_MODULES.includes('dist/installation.js'));
    } finally {
        rmSync(lib, { recursive: true, force: true });
    }
});

test('an archive refuses symbolic links', () => {
    const directory = tree();
    try {
        symlinkSync('LICENSE', join(directory, 'link'));
        assert.throws(() => collectEntries(directory, 'p'), /symbolic link/u);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('a pinned input is refused when one byte or its size differs', () => {
    const directory = temporary('pin');
    try {
        const path = join(directory, 'node.tar.xz');
        writeFileSync(path, 'runtime');
        const pin = { bytes: 7, sha256: sha256(Buffer.from('runtime')) };
        assertPinned(path, pin, 'Node.js');
        writeFileSync(path, 'runtimf');
        assert.throws(() => assertPinned(path, pin, 'Node.js'), /Node\.js is not the pinned file/u);
        writeFileSync(path, 'runtime!');
        assert.throws(() => assertPinned(path, pin, 'Node.js'), /is not the pinned file/u);
        assert.throws(() => assertPinned(path, { bytes: null, sha256: null }, 'The reasoner'), /has no pin/u);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('the Node.js runtime pins name the Node.js archive of each release platform', () => {
    const runtime = JSON.parse(readFileSync(join(root, 'release/node-runtime.json'), 'utf8'));
    assert.equal(runtime.version, readFileSync(join(root, '.node-version'), 'utf8').trim());
    assert.deepEqual(Object.keys(runtime.platforms).sort(), Object.keys(RELEASE_PLATFORMS).sort());
    for (const [platform, pin] of Object.entries(runtime.platforms)) {
        assert.match(pin.sha256, /^sha256:[0-9a-f]{64}$/u, platform);
        assert.ok(Number.isSafeInteger(pin.bytes) && pin.bytes > 0, platform);
        assert.ok(pin.file.startsWith(`node-v${runtime.version}`), platform);
    }
    assert.equal(hostPlatform({ platform: 'linux', arch: 'x64' }), 'linux-x64');
    assert.equal(hostPlatform({ platform: 'linux', arch: 'x64', libc: 'musl' }), 'linux-x64-musl');
    assert.equal(hostPlatform({ platform: 'linux', arch: 'arm64', libc: 'musl' }), 'linux-arm64-musl');
    assert.equal(hostPlatform({ platform: 'darwin', arch: 'x64' }), undefined);
    // nodejs.org publishes no musl build: linux-x64-musl ships the Node.js project's unofficial build. linux-arm64-musl
    // ships the Node.js of the pinned musl build image, as postject cannot inject into the unofficial non-PIE build,
    // with the LICENSE of the official source tarball, its pinned file.
    for (const [platform, pin] of Object.entries(runtime.platforms)) {
        if (platform === 'linux-arm64-musl') {
            assert.equal(pin.baseUrl, undefined);
            assert.equal(pin.file, `node-v${runtime.version}.tar.xz`);
            assert.equal(pin.executable, undefined);
            assert.deepEqual(Object.keys(pin.imageExecutable).sort(), ['bytes', 'image', 'path', 'sha256']);
            assert.equal(pin.imageExecutable.image, MUSL_BUILD_IMAGE);
            assert.equal(pin.imageExecutable.path, '/usr/local/bin/node');
            assert.match(pin.imageExecutable.sha256, /^sha256:[0-9a-f]{64}$/u);
            assert.ok(Number.isSafeInteger(pin.imageExecutable.bytes) && pin.imageExecutable.bytes > 0);
            continue;
        }
        const musl = RELEASE_PLATFORMS[platform].libc === 'musl';
        assert.equal(pin.imageExecutable, undefined, platform);
        assert.equal(
            pin.baseUrl,
            musl ? `https://unofficial-builds.nodejs.org/download/release/v${runtime.version}/` : undefined,
        );
        assert.equal(pin.file.includes('-musl.'), musl, platform);
    }
    assert.equal(archiveName('1.0.0', 'win32-x64'), 'erden-1.0.0-win32-x64.zip');
});

function record(platform, digest = 'a') {
    return {
        version: '1.0.0',
        platform,
        sourceCommit: 'c'.repeat(40),
        sourceDateEpoch: 1_700_000_000,
        node: {
            version: '24.17.0',
            file: `node-v24.17.0-${platform}`,
            sha256: `sha256:${platform.length.toString(16).repeat(64)}`,
        },
        archive: { file: archiveName('1.0.0', platform), bytes: 10, sha256: `sha256:${digest.repeat(64)}` },
        ...(RELEASE_PLATFORMS[platform].xz
            ? {
                  xzArchive: {
                      file: archiveName('1.0.0', platform, 'tar.xz'),
                      bytes: 8,
                      sha256: `sha256:${digest.repeat(64)}`,
                  },
              }
            : {}),
        engines: { reasoner: { sha256: `sha256:${'1'.repeat(64)}` }, shacl: { sha256: `sha256:${'2'.repeat(64)}` } },
    };
}

test('a release accepts only the pinned archives and engines, on every release platform', () => {
    const records = Object.fromEntries(Object.keys(RELEASE_PLATFORMS).map((platform) => [platform, record(platform)]));
    const pins = pinsOf(records, { mintRunId: 123 });
    assert.equal(pins.complete, true);
    assert.equal(pins.mintRunId, 123);
    assert.deepEqual(pinDifferences(pins, records, { release: true }), []);
    assert.match(
        pinDifferences(pinsOf(records), records, { release: true }).join('\n'),
        /name no mint run/u,
        'a release publishes the archives of the mint run its pins name',
    );
    const changed = { ...records, 'linux-x64': record('linux-x64', 'b') };
    assert.match(
        pinDifferences(pins, changed, { release: true })[0],
        /^linux-x64: erden-1\.0\.0-linux-x64\.tar\.gz is sha256:b+ /u,
    );
    assert.deepEqual(Object.keys(pins.xzArchives).sort(), [
        'darwin-arm64',
        'linux-arm64',
        'linux-arm64-musl',
        'linux-x64',
        'linux-x64-musl',
    ]);
    assert.equal(pins.xzArchives['linux-x64'].file, 'erden-1.0.0-linux-x64.tar.xz');
    const xzChanged = {
        ...records,
        'linux-arm64': {
            ...records['linux-arm64'],
            xzArchive: { ...records['linux-arm64'].xzArchive, bytes: 9 },
        },
    };
    assert.match(
        pinDifferences(pins, xzChanged, { release: true }).join('\n'),
        /^linux-arm64: erden-1\.0\.0-linux-arm64\.tar\.xz is sha256:a+ \(9 bytes\)/mu,
    );
    const { xzArchive: _xz, ...noXz } = records['darwin-arm64'];
    assert.match(
        pinDifferences(pins, { ...records, 'darwin-arm64': noXz }, { release: true }).join('\n'),
        /darwin-arm64: erden-1\.0\.0-darwin-arm64\.tar\.xz pinned but not built/u,
    );
    const { xzArchives: _pinned, ...gzOnly } = pins;
    assert.match(
        pinDifferences(gzOnly, records, { release: true }).join('\n'),
        /linux-x64: no \.tar\.xz archive pinned/u,
        'a release ships a .tar.xz on every platform that has one',
    );
    assert.equal(archiveName('1.0.0', 'linux-x64', 'tar.xz'), 'erden-1.0.0-linux-x64.tar.xz');
    assert.throws(() => archiveName('1.0.0', 'win32-x64', 'tar.xz'), /ships no \.tar\.xz/u);
    const engine = {
        ...records,
        'darwin-arm64': {
            ...record('darwin-arm64'),
            engines: { ...record('darwin-arm64').engines, shacl: { sha256: `sha256:${'3'.repeat(64)}` } },
        },
    };
    assert.match(pinDifferences(pins, engine, { release: true }).join('\n'), /darwin-arm64: the shacl is/u);
    const { 'win32-x64': _, ...three } = records;
    assert.match(pinDifferences(pins, three, { release: true }).join('\n'), /win32-x64: not built/u);
    assert.throws(() => pinsOf(three), /No build for win32-x64/u);
    const partial = pinsOf({ 'linux-x64': records['linux-x64'] }, { allowPartial: true });
    assert.deepEqual(pinDifferences(partial, { 'linux-x64': records['linux-x64'] }), []);
    assert.match(
        pinDifferences(partial, { 'linux-x64': records['linux-x64'] }, { release: true }).join('\n'),
        /fewer than every release platform/u,
    );
    assert.throws(
        () => pinsOf({ ...records, 'linux-x64': { ...records['linux-x64'], sourceDateEpoch: 1 } }),
        /disagree on sourceDateEpoch/u,
    );
    assert.equal(pins.node, '24.17.0');
    assert.throws(
        () =>
            pinsOf({
                ...records,
                'linux-x64': { ...records['linux-x64'], node: { ...records['linux-x64'].node, version: '24.18.0' } },
            }),
        /disagree on node/u,
    );
});

test('third-party notices list every package with its license files and refuse unknown licenses', () => {
    const directory = temporary('notices');
    const policy = JSON.parse(readFileSync(join(root, 'release/license-policy.json'), 'utf8'));
    try {
        const modules = join(directory, 'node_modules');
        mkdirSync(join(modules, 'left', 'node_modules', 'nested'), { recursive: true });
        mkdirSync(join(modules, '@erden', 'cli'), { recursive: true });
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'MIT' }),
        );
        writeFileSync(join(modules, 'left', 'LICENSE'), 'MIT text\n');
        writeFileSync(
            join(modules, 'left', 'node_modules', 'nested', 'package.json'),
            JSON.stringify({ name: 'nested', version: '2.0.0', license: { type: 'ISC' } }),
        );
        writeFileSync(join(modules, 'left', 'node_modules', 'nested', 'LICENCE.md'), 'ISC text\n');
        writeFileSync(
            join(modules, '@erden', 'cli', 'package.json'),
            JSON.stringify({ name: '@erden/cli', version: '0.0.0', license: 'Apache-2.0' }),
        );
        assert.equal(writeNpmNotices(modules, join(directory, 'out'), policy), 2);
        const notices = readFileSync(join(directory, 'out', 'npm', 'THIRD-PARTY-NOTICES.md'), 'utf8');
        assert.match(
            notices,
            /- left 1\.0\.0: declared `MIT`; selected `MIT`; licenses\/[0-9a-f]{64}\.txt \(LICENSE, /u,
        );
        assert.match(notices, /- nested 2\.0\.0: declared `ISC`/u);
        assert.doesNotMatch(notices, /@erden/u);
        assert.equal(declaredLicense({ licenses: [{ type: 'MIT' }, 'Apache-2.0'] }), 'MIT OR Apache-2.0');
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'SSPL-1.0' }),
        );
        assert.throws(
            () => writeNpmNotices(modules, join(directory, 'out2'), policy),
            /Denied license SSPL-1\.0: left 1\.0\.0/u,
        );
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'WTFPL' }),
        );
        assert.throws(() => writeNpmNotices(modules, join(directory, 'out3'), policy), /Unknown license WTFPL/u);
        writeFileSync(
            join(modules, 'left', 'package.json'),
            JSON.stringify({ name: 'left', version: '1.0.0', license: 'MIT' }),
        );
        rmSync(join(modules, 'left', 'LICENSE'));
        assert.throws(
            () => writeNpmNotices(modules, join(directory, 'out4'), policy),
            /No license file in left 1\.0\.0/u,
        );
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

/**
 * Evaluates a workflow `if:` that is a conjunction of `github.<path> == <literal>` terms (the only form the publish
 * guard uses) against a `github` context; anything else is refused, so the guard cannot grow untested.
 */
function evaluateGuard(expression, github) {
    const body = expression
        .trim()
        .replace(/^\$\{\{/u, '')
        .replace(/\}\}$/u, '');
    return body.split('&&').every((term) => {
        const match = /^\s*github\.([\w.]+) == ('[^']*'|true|false)\s*$/u.exec(term);
        if (match === null) {
            throw new Error(`Unsupported guard term: ${term}`);
        }
        const actual = match[1].split('.').reduce((value, key) => value?.[key], github);
        const expected = match[2].startsWith("'") ? match[2].slice(1, -1) : match[2] === 'true';
        return actual === expected;
    });
}

test('a tag builds nothing: it publishes the archives of the mint run its pins name, checked against the pins', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
    function onTag(job) {
        return !/github\.event_name == 'workflow_dispatch'/u.test(job.if ?? '');
    }
    const tagJobs = Object.entries(workflow.jobs)
        .filter(([, job]) => onTag(job))
        .map(([name]) => name)
        .sort();
    assert.deepEqual(tagJobs, ['packages', 'publish', 'published-archives', 'verify']);
    // The package managers are updated only from a verified release, from the committed pins, with no build.
    assert.deepEqual(workflow.jobs.packages.needs, 'verify');
    assert.ok(workflow.jobs.packages.steps.some((step) => step.run?.includes('release/write-package-manifests.mjs')));
    assert.ok(!workflow.jobs.packages.steps.some((step) => step.run?.includes('build-cli-archive.mjs')));
    for (const name of ['published-archives', 'publish']) {
        const steps = workflow.jobs[name].steps;
        const download = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
        assert.notEqual(download, -1, name);
        assert.equal(steps[download].with['run-id'] !== undefined && steps[download].with.pattern, 'archive-*', name);
        const verify = steps.findIndex((step) =>
            step.run?.includes('release/pins.mjs verify --artifacts release-build --release --tag'),
        );
        assert.ok(verify > download, `${name} checks the fetched archives against the pins`);
        assert.ok(!steps.some((step) => step.run?.includes('build-cli-archive.mjs')), `${name} builds no archive`);
    }
    const publishSteps = workflow.jobs.publish.steps;
    const verifyAt = publishSteps.findIndex((step) => step.run?.includes('release/pins.mjs verify'));
    const createAt = publishSteps.findIndex((step) => step.run?.includes('gh release create'));
    assert.ok(verifyAt < createAt, 'the pins are checked before anything is published');
});

test('a native (Windows, macOS) archive whose two builds differed is accepted with its first build; Linux is not', () => {
    for (const platform of ['win32-x64', 'darwin-arm64']) {
        assert.equal(acceptedBuildResult(platform, { result: 'native-builds-differ' }), true, platform);
    }
    for (const platform of ['linux-x64', 'linux-arm64']) {
        assert.equal(acceptedBuildResult(platform, { result: 'native-builds-differ' }), false, platform);
        assert.equal(acceptedBuildResult(platform, { result: 'byte-identical' }), true, platform);
    }
});

test('the release workflow pins every action, and only its publish job and the jobs that fetch a mint, can write or read actions', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.on).sort(), ['push', 'workflow_dispatch']);
    // A release candidate tag is a canary: release-canary.yml publishes it, never this workflow.
    assert.deepEqual(workflow.on.push.tags, ['v*', '!v*-rc.*']);
    for (const [name, job] of Object.entries(workflow.jobs)) {
        if (name === 'publish') {
            // actions: read fetches the mint run's archive artifacts; id-token and attestations sign their provenance.
            assert.deepEqual(job.permissions, {
                contents: 'write',
                actions: 'read',
                'id-token': 'write',
                attestations: 'write',
            });
            const publishes = evaluateGuard.bind(undefined, job.if);
            const tag = {
                event_name: 'push',
                repository: 'erden-sh/erden',
                event: { repository: { private: false } },
            };
            assert.equal(publishes(tag), true);
            assert.equal(
                publishes({ ...tag, event: { repository: { private: true } } }),
                false,
                'the private repository',
            );
            assert.equal(publishes({ ...tag, repository: 'someone/erden' }), false, 'a fork');
            assert.equal(publishes({ ...tag, event_name: 'workflow_dispatch' }), false, 'a mint');
        } else if (name === 'archive') {
            // It fetches the engine mint's binaries and attests the provenance of the archive it builds.
            assert.deepEqual(
                job.permissions,
                { contents: 'read', actions: 'read', 'id-token': 'write', attestations: 'write' },
                name,
            );
        } else if (name === 'published-archives') {
            // It fetches the mint's archives; nothing more.
            assert.deepEqual(job.permissions, { contents: 'read', actions: 'read' }, name);
        } else {
            assert.equal(job.permissions, undefined, `${name} must not raise permissions`);
        }
        if (typeof job.uses === 'string') {
            assert.match(job.uses, /^\.\/\.github\/workflows\/[a-z-]+\.yml$/u, name);
        }
        for (const step of job.steps ?? []) {
            if (step.uses !== undefined) {
                assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, `${name}: ${step.uses}`);
            }
        }
    }
    for (const engine of ['reasoner-build.yml', 'shacl-build.yml']) {
        const called = YAML.parse(readFileSync(join(root, '.github/workflows', engine), 'utf8'));
        assert.equal(called.on.workflow_call.inputs.commit.type, 'string', engine);
    }
});

test('a canary tag publishes the pinned mint archives as a prerelease that is never the latest release', () => {
    const workflow = YAML.parse(readFileSync(join(root, '.github/workflows/release-canary.yml'), 'utf8'));
    const stable = YAML.parse(readFileSync(join(root, '.github/workflows/release.yml'), 'utf8'));
    assert.deepEqual(workflow.permissions, { contents: 'read' });
    assert.deepEqual(Object.keys(workflow.on), ['push']);
    assert.deepEqual(workflow.on.push.tags, ['v*-rc.*']);
    assert.deepEqual(Object.keys(workflow.jobs).sort(), ['publish', 'published-archives', 'verify']);
    // The canary's fetch-and-check steps are the stable release's, step for step, after its tag check.
    for (const name of ['published-archives', 'publish']) {
        const steps = workflow.jobs[name].steps;
        const download = steps.findIndex((step) => step.uses?.startsWith('actions/download-artifact@'));
        assert.notEqual(download, -1, name);
        assert.equal(steps[download].with.pattern, 'archive-*', name);
        assert.ok(steps[download].with['run-id'] !== undefined, name);
        const verify = steps.findIndex((step) =>
            step.run?.includes('release/pins.mjs verify --artifacts release-build --release --tag'),
        );
        assert.ok(verify > download, `${name} checks the fetched archives against the pins`);
        assert.ok(!steps.some((step) => step.run?.includes('build-cli-archive.mjs')), `${name} builds no archive`);
        const stableSteps = stable.jobs[name].steps.filter((step) => step.uses !== undefined).map((step) => step.uses);
        const canarySteps = steps.filter((step) => step.uses !== undefined).map((step) => step.uses);
        assert.deepEqual(canarySteps, stableSteps, `${name} pins the same actions as the stable release`);
    }
    assert.match(workflow.jobs['published-archives'].steps[0].run, /\^v\[0-9\]\+/u);
    // The stable release refuses any tag but v<x.y.z>, whatever its trigger lets through.
    assert.match(stable.jobs['published-archives'].steps[0].run, /=~ \^v\[0-9\]\+\\\.\[0-9\]\+\\\.\[0-9\]\+\$ \]\]/u);
    const publish = workflow.jobs.publish;
    assert.deepEqual(publish.permissions, {
        contents: 'write',
        actions: 'read',
        'id-token': 'write',
        attestations: 'write',
    });
    assert.deepEqual(workflow.jobs['published-archives'].permissions, { contents: 'read', actions: 'read' });
    const publishes = evaluateGuard.bind(undefined, publish.if);
    const tag = { event_name: 'push', repository: 'erden-sh/erden', event: { repository: { private: false } } };
    assert.equal(publishes(tag), true);
    assert.equal(publishes({ ...tag, event: { repository: { private: true } } }), false, 'the private repository');
    assert.equal(publishes({ ...tag, repository: 'someone/erden' }), false, 'a fork');
    const create = publish.steps.find((step) => step.run?.includes('gh release create'));
    assert.match(create.run, /gh release create "\$GITHUB_REF_NAME" --draft --prerelease --latest=false --verify-tag/u);
    assert.match(create.run, /gh release edit "\$GITHUB_REF_NAME" --draft=false --prerelease --latest=false/u);
    const verifyAt = publish.steps.findIndex((step) => step.run?.includes('release/pins.mjs verify'));
    assert.ok(verifyAt < publish.steps.indexOf(create), 'the pins are checked before anything is published');
    assert.equal(workflow.jobs.verify.uses, './.github/workflows/verify-release.yml');
    for (const job of Object.values(workflow.jobs)) {
        for (const step of job.steps ?? []) {
            if (step.uses !== undefined) {
                assert.match(step.uses, /^[\w.-]+\/[\w.-]+@[0-9a-f]{40}$/u, step.uses);
            }
        }
    }
});

test('the Homebrew formula and the Scoop manifest name the pinned archives', async () => {
    const { homebrewFormula, scoopManifest } = await import('../../release/write-package-manifests.mjs');
    const records = Object.fromEntries(Object.keys(RELEASE_PLATFORMS).map((platform) => [platform, record(platform)]));
    const pins = pinsOf(records, { mintRunId: 1 });
    const formula = homebrewFormula(pins);
    for (const platform of ['darwin-arm64', 'linux-arm64', 'linux-x64']) {
        // The .tar.xz, which Homebrew extracts (with xz, which it installs where it is missing).
        const pin = pins.xzArchives[platform];
        assert.ok(pin.file.endsWith('.tar.xz'), platform);
        assert.ok(
            formula.includes(
                `url "https://github.com/erden-sh/erden/releases/download/v1.0.0/${pin.file}"\n      sha256 "${pin.sha256.slice(7)}"`,
            ),
            platform,
        );
    }
    assert.doesNotMatch(formula, /musl|win32/u);
    assert.doesNotMatch(formula, /^  version /mu, 'Homebrew reads the version from the URL');
    assert.match(formula, /generate_completions_from_executable\(bin\/"erden", "completions"/u);
    const manifest = JSON.parse(scoopManifest(pins));
    assert.equal(manifest.version, '1.0.0');
    assert.deepEqual(manifest.architecture['64bit'], {
        url: 'https://github.com/erden-sh/erden/releases/download/v1.0.0/erden-1.0.0-win32-x64.zip',
        hash: pins.archives['win32-x64'].sha256.slice(7),
        extract_dir: 'erden-1.0.0-win32-x64',
    });
    assert.deepEqual(manifest.bin, ['bin\\erden.cmd', 'bin\\den.cmd'], 'an archive from before the single executable');
    assert.equal(pins.layout, undefined);
    const single = pinsOf(
        Object.fromEntries(
            Object.entries(records).map(([platform, value]) => [platform, { ...value, singleExecutable: {} }]),
        ),
        { mintRunId: 1 },
    );
    assert.equal(single.layout, 'single-executable');
    assert.deepEqual(JSON.parse(scoopManifest(single)).bin, ['bin\\erden.exe', 'bin\\den.cmd']);
    assert.throws(
        () => pinsOf({ ...records, 'linux-x64': { ...records['linux-x64'], singleExecutable: {} } }),
        /disagree on the archive layout/u,
    );
    const { xzArchives: _xz, ...gzOnly } = pins;
    assert.match(homebrewFormula(gzOnly), /linux-x64\.tar\.gz"/u, 'a release without .tar.xz archives keeps .tar.gz');
    assert.equal(manifest.autoupdate.architecture['64bit'].hash.url, '$baseurl/SHA256SUMS');
    const { 'linux-arm64': _, ...partial } = pins.archives;
    assert.throws(() => homebrewFormula({ ...pins, archives: partial }), /has no linux-arm64 archive/u);
});
