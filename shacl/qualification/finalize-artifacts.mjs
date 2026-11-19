// The mint: copies the binaries of one shacl-build workflow run into the six platform packages, byte for byte, and
// writes everything that pins them: each package (its package.json, metadata.json, README and test), the resolver's
// anchors (shacl/distribution/src/artifacts.js), and shacl/qualification/binary-reproducibility.json. Every input is
// checked first: both clean builds of each target identical, the known answer present, the Cargo.lock the qualified
// one, the pinned builder image on Linux (the Alpine one for musl), the source commit's shacl/ tree the one recorded,
// and the binary the one the record names.
//
//   node shacl/qualification/finalize-artifacts.mjs --artifacts <dir with shacl-<target>/ folders> --run-id <id>
//        --determinism <dir with comparison.json>
//   node shacl/qualification/finalize-artifacts.mjs --check
//   node shacl/qualification/finalize-artifacts.mjs --matches-source
//
// `--check` refuses unless the committed packages, anchors and record are exactly what the record describes (a CI
// gate, with no artifacts needed), and unless no binary is committed. A platform added after the engine was minted (the
// record has no build of its target) is committed unpinned: its anchors and metadata must carry null pins, and the
// determinism comparison covers the minted binaries only. `--matches-source` refuses while any platform is unminted,
// so the next release mints all six again. The binaries are never committed (shacl/*/bin/ is ignored): the mint writes
// them into the packages for packing and qualification only. `--check` verifies each binary that is present (built by
// build-from-source.mjs, or installed from a tools release).
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import {
    CARGO_LOCK_SHA256,
    LINUX_BUILDER_IMAGE,
    LINUX_MUSL_BUILDER_IMAGE,
    RUST_TOOLCHAIN,
    builderImageOf,
    executableName,
    rustflagsRecordOf,
} from './verify-binary-reproducible.mjs';

/** The comparison results a mint accepts: `differs-on-native` means only the Windows or macOS answers differ. */
const ACCEPTED_COMPARISONS = new Set(['identical', 'differs-on-native']);

/**
 * Whether a build record holds two clean builds the mint accepts: identical on Linux (the pinned builder image), and on
 * Windows or macOS, whose native builds use the runner image's linker, also two that differ, with the first kept.
 */
function acceptedBuilds(platform, record) {
    if (record.runs?.length !== 2) return false;
    if (record.runs[0].sha256 === record.runs[1].sha256 && record.runs[0].bytes === record.runs[1].bytes) return true;
    return platform.runtime.os !== 'linux' && record.result === 'native-builds-differ';
}

const qualification = import.meta.dirname;
const shacl = resolve(qualification, '..');
const repository = resolve(shacl, '..');
export const PACKAGE_VERSION = '0.1.0+purrdf.3.0.1';

export const PLATFORMS = Object.freeze([
    {
        key: 'linux:x64:glibc',
        directory: 'linux-x64-gnu',
        packageName: '@erden/shacl-linux-x64-gnu',
        description: 'Qualified Erden SHACL engine for Linux x64 (glibc)',
        runtime: { os: 'linux', cpu: 'x64', libc: 'glibc' },
        target: 'x86_64-unknown-linux-gnu',
        runner: 'ubuntu-24.04',
    },
    {
        key: 'linux:arm64:glibc',
        directory: 'linux-arm64-gnu',
        packageName: '@erden/shacl-linux-arm64-gnu',
        description: 'Qualified Erden SHACL engine for Linux arm64 (glibc)',
        runtime: { os: 'linux', cpu: 'arm64', libc: 'glibc' },
        target: 'aarch64-unknown-linux-gnu',
        runner: 'ubuntu-24.04-arm',
    },
    {
        key: 'darwin:arm64',
        directory: 'darwin-arm64',
        packageName: '@erden/shacl-darwin-arm64',
        description: 'Qualified Erden SHACL engine for macOS arm64 (Apple silicon)',
        runtime: { os: 'darwin', cpu: 'arm64' },
        target: 'aarch64-apple-darwin',
        runner: 'macos-15',
    },
    {
        key: 'win32:x64',
        directory: 'win32-x64-msvc',
        packageName: '@erden/shacl-win32-x64-msvc',
        description: 'Qualified Erden SHACL engine for Windows x64 (MSVC)',
        runtime: { os: 'win32', cpu: 'x64' },
        target: 'x86_64-pc-windows-msvc',
        runner: 'windows-2025',
    },
    // The static musl executables, for Alpine and other musl distributions. They come after the glibc packages, so a
    // lookup by operating system and CPU alone (build-from-source.mjs) still finds the glibc one first.
    {
        key: 'linux:x64:musl',
        directory: 'linux-x64-musl',
        packageName: '@erden/shacl-linux-x64-musl',
        description: 'Qualified Erden SHACL engine for Linux x64 (musl)',
        runtime: { os: 'linux', cpu: 'x64', libc: 'musl' },
        target: 'x86_64-unknown-linux-musl',
        runner: 'ubuntu-24.04',
    },
    {
        key: 'linux:arm64:musl',
        directory: 'linux-arm64-musl',
        packageName: '@erden/shacl-linux-arm64-musl',
        description: 'Qualified Erden SHACL engine for Linux arm64 (musl)',
        runtime: { os: 'linux', cpu: 'arm64', libc: 'musl' },
        target: 'aarch64-unknown-linux-musl',
        runner: 'ubuntu-24.04-arm',
    },
]);

function sha256(bytes) {
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
function git(...args) {
    return execFileSync('git', args, { cwd: repository, encoding: 'utf8', windowsHide: true }).trim();
}
function fail(message) {
    throw new Error(`erden-shacl mint refused: ${message}`);
}

export function anchorsModule(entries, engine, fixtureDigest) {
    const lines = [
        '// Written by shacl/qualification/finalize-artifacts.mjs from the shacl-build run recorded in',
        '// shacl/qualification/binary-reproducibility.json. Do not edit by hand. A platform whose pins are null has no',
        '// released binary.',
        `export const PACKAGE_VERSION = '${PACKAGE_VERSION}';`,
        `export const ENGINE_DIGEST = '${engine}';`,
        `export const KNOWN_ANSWER_FIXTURE_DIGEST = '${fixtureDigest}';`,
        'export const QUALIFIED_ARTIFACTS = Object.freeze({',
    ];
    for (const entry of entries) {
        lines.push(
            `    '${entry.key}': Object.freeze({`,
            `        packageName: '${entry.packageName}',`,
            `        description: '${entry.description}',`,
            `        runtime: Object.freeze(${JSON.stringify(entry.runtime).replaceAll('"', "'").replaceAll(',', ', ').replaceAll(':', ': ').replace('{', '{ ').replace(/\}$/u, ' }')}),`,
            `        target: '${entry.target}',`,
            `        binaryPath: 'bin/${executableName(entry.target)}',`,
            `        bytes: ${entry.bytes === null ? 'null' : String(entry.bytes)},`,
            `        sha256: ${entry.sha256 === null ? 'null' : `'${entry.sha256}'`},`,
            `        responseBytes: ${entry.responseBytes === null ? 'null' : String(entry.responseBytes)},`,
            `        responseSha256: ${entry.responseSha256 === null ? 'null' : `'${entry.responseSha256}'`},`,
            '    }),',
        );
    }
    lines.push('});', '');
    return lines.join('\n');
}

/** A platform package's qualification metadata. */
export function metadataOf(entry, engine) {
    return `${JSON.stringify(
        {
            schemaVersion: 1,
            packageName: entry.packageName,
            packageVersion: PACKAGE_VERSION,
            tool: { name: 'erden-shacl', version: PACKAGE_VERSION, engineDigest: engine },
            runtime: entry.runtime,
            target: entry.target,
            binary: { path: `bin/${executableName(entry.target)}`, bytes: entry.bytes, sha256: entry.sha256 },
            knownAnswer: { fixture: 'core-and-sparql', responseBytes: entry.responseBytes, responseSha256: entry.responseSha256 },
        },
        null,
        2,
    )}\n`;
}

/** A platform package's manifest, in the shape the resolver accepts. */
export function manifestOf(entry) {
    return `${JSON.stringify(
        {
            name: entry.packageName,
            version: PACKAGE_VERSION,
            description: entry.description,
            license: 'Apache-2.0',
            bin: { 'erden-shacl': `bin/${executableName(entry.target)}` },
            files: ['bin', 'metadata.json', 'README.md', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES.md'],
            os: [entry.runtime.os],
            cpu: [entry.runtime.cpu],
            ...(entry.runtime.libc === undefined ? {} : { libc: [entry.runtime.libc] }),
            type: 'module',
            engines: { node: '^24' },
        },
        null,
        4,
    )}\n`;
}

/** The platform as a README names it: `Linux x64 with glibc`, `macOS arm64 (Apple silicon)`. */
function readmePlatform(entry) {
    const platform = entry.description.replace(/^Qualified Erden SHACL engine for /u, '');
    return platform.replace(/^(Linux \S+) \((glibc|musl)\)$/u, '$1 with $2');
}

/** Writes a complete platform package except its binary (the mint copies that in; it is never committed). */
export function writePlatformPackage(entry, engine, outputShacl = shacl) {
    const directory = join(outputShacl, entry.directory);
    mkdirSync(join(directory, 'test'), { recursive: true });
    writeFileSync(join(directory, 'package.json'), manifestOf(entry));
    writeFileSync(join(directory, 'metadata.json'), metadataOf(entry, engine));
    writeFileSync(
        join(directory, 'README.md'),
        `# \`${entry.packageName}\`\n\nQualified \`erden-shacl\` executable (PurRDF \`purrdf-shapes\` 3.0.1, protocol \`erden.shacl/v1\`) for ` +
            `${readmePlatform(entry)}. This package is installed optionally by \`@erden/shacl-distribution\`; applications resolve ` +
            'it through that package so every integrity check runs before execution. The binary is the one the `shacl-build` ' +
            'workflow built twice, byte-identically, from the recorded source (`shacl/qualification/binary-reproducibility.json`).\n',
    );
    copyFileSync(join(repository, 'reasoner/qualification/ERDEN-LICENSE-APACHE-2.0.txt'), join(directory, 'LICENSE'));
    copyFileSync(join(repository, 'NOTICE'), join(directory, 'NOTICE'));
    copyFileSync(join(qualification, 'THIRD-PARTY-NOTICES.md'), join(directory, 'THIRD-PARTY-NOTICES.md'));
    writeFileSync(
        join(directory, 'test/index.test.ts'),
        "import { testPlatformPackage } from '../../distribution/test/platform.js';\n\ntestPlatformPackage(new URL('../', import.meta.url));\n",
    );
}

/** The resolver's manifest with optional dependencies on every platform package, minted or not. */
export function distributionManifestOf(current) {
    const manifest = { ...current };
    delete manifest.optionalDependencies;
    const ordered = {};
    for (const [key, value] of Object.entries(manifest)) {
        ordered[key] = value;
        if (key === 'exports') {
            ordered.optionalDependencies = Object.fromEntries(
                PLATFORMS.map((platform) => platform.packageName)
                    .sort()
                    .map((name) => [name, `workspace:${PACKAGE_VERSION}`]),
            );
        }
    }
    return `${JSON.stringify(ordered, null, 4)}\n`;
}

/** Each platform with the pins of its build in `targets` (a record's), or null pins when it has none. */
export function entriesOf(targets) {
    return PLATFORMS.map((platform) => {
        const built = targets?.[platform.target];
        return {
            ...platform,
            bytes: built?.runs[0].bytes ?? null,
            sha256: built?.runs[0].sha256 ?? null,
            responseBytes: built?.knownAnswer.responseBytes ?? null,
            responseSha256: built?.knownAnswer.responseSha256 ?? null,
        };
    });
}

function main() {
    const { values } = parseArgs({ options: { artifacts: { type: 'string' }, 'run-id': { type: 'string' }, check: { type: 'boolean', default: false }, 'matches-source': { type: 'boolean', default: false }, determinism: { type: 'string' } } });
    if (values['matches-source']) {
        // Whether the committed pins are this checkout's build, so a release can reuse the minted binaries: the crate,
        // the lock and every target's flags (which live in the qualification scripts, not the crate) are the minted ones.
        const record = JSON.parse(readFileSync(join(qualification, 'binary-reproducibility.json'), 'utf8'));
        if (git('rev-parse', 'HEAD:shacl/erden-shacl') !== record.crateSourceTree || sha256(readFileSync(join(shacl, 'Cargo.lock'))) !== record.cargoLockDigest) {
            fail('the committed crate or lock is not the minted source; mint the engine again (release.yml) and commit its pins with the change');
        }
        // A platform added since the last mint is minted together with the others, from one run.
        const unminted = PLATFORMS.filter((platform) => record.targets?.[platform.target] === undefined);
        if (unminted.length > 0) {
            fail(`${unminted.map((platform) => platform.target).join(', ')} not minted yet; the next mint builds all ${String(PLATFORMS.length)} targets`);
        }
        for (const platform of PLATFORMS) {
            if (record.targets[platform.target]?.rustflags !== rustflagsRecordOf(platform.target)) {
                fail(`${platform.target}: minted with other flags than this checkout builds with`);
            }
        }
        console.log(`erden-shacl pins are this checkout's build (run ${String(record.workflowRunId)})`);
        return;
    }
    const fixture = readFileSync(join(shacl, 'distribution/fixtures/known-answer.request.json'), 'utf8');
    const engine = JSON.parse(fixture).requiredTool.engineDigest;
    if (values.check) {
        const record = JSON.parse(readFileSync(join(qualification, 'binary-reproducibility.json'), 'utf8'));
        const known = new Set(PLATFORMS.map((platform) => platform.target));
        const stray = Object.keys(record.targets ?? {}).filter((target) => !known.has(target));
        if (stray.length > 0) fail(`the record has builds of targets no platform package ships: ${stray.join(', ')}`);
        // A platform with no build in the record was added after the mint: its entry carries null pins (entriesOf).
        const entries = entriesOf(record.targets);
        for (const entry of entries) {
            const built = record.targets?.[entry.target];
            if (built !== undefined && !acceptedBuilds(entry, built)) {
                fail(`${entry.target}: the record does not hold two identical clean builds`);
            }
            // A binary is present only when built from source (build-from-source.mjs) or installed from a release.
            const binary = join(shacl, entry.directory, 'bin', executableName(entry.target));
            if (existsSync(binary)) {
                const bytes = readFileSync(binary);
                if (sha256(bytes) !== entry.sha256 || bytes.length !== entry.bytes) fail(`${entry.directory} binary is not the minted one`);
            }
        }
        if (readFileSync(join(shacl, 'distribution/src/artifacts.js'), 'utf8') !== anchorsModule(entries, engine, sha256(fixture))) fail('the resolver anchors differ from the record');
        for (const entry of entries) {
            if (readFileSync(join(shacl, entry.directory, 'metadata.json'), 'utf8') !== metadataOf(entry, engine)) fail(`${entry.directory}/metadata.json differs from the record`);
            if (readFileSync(join(shacl, entry.directory, 'package.json'), 'utf8') !== manifestOf(entry)) fail(`${entry.directory}/package.json differs from the record`);
        }
        const distribution = readFileSync(join(shacl, 'distribution/package.json'), 'utf8');
        if (distribution !== distributionManifestOf(JSON.parse(distribution))) fail('the resolver does not depend on exactly the six platform packages');
        const minted = entries.filter((entry) => entry.sha256 !== null);
        if (minted.length === 0) fail('the record holds no build');
        const determinism = record.crossPlatformDeterminism;
        if (
            !ACCEPTED_COMPARISONS.has(determinism?.result) ||
            JSON.stringify(Object.keys(determinism.executables).sort()) !== JSON.stringify(minted.map((entry) => entry.target).sort()) ||
            JSON.stringify(Object.values(determinism.executables).sort()) !== JSON.stringify(minted.map((entry) => entry.sha256).sort())
        ) {
            fail('the record lacks an identical cross-platform determinism comparison of the minted binaries');
        }
        if (git('rev-parse', 'HEAD:shacl/erden-shacl') !== record.crateSourceTree || sha256(readFileSync(join(shacl, 'Cargo.lock'))) !== record.cargoLockDigest) {
            fail('the committed crate or lock is not the minted source; mint the engine again (release.yml) and commit its pins with the change');
        }
        const committed = PLATFORMS.map((platform) => `shacl/${platform.directory}/bin`);
        if (git('ls-files', '--', ...committed) !== '') fail('a binary is committed; the packages carry only their pins');
        const unminted = entries.filter((entry) => entry.sha256 === null).map((entry) => entry.directory);
        if (unminted.length > 0) {
            console.log(`erden-shacl packages, anchors and record agree with the mint; not minted yet, so unpinned: ${unminted.join(', ')}`);
            return;
        }
        console.log('erden-shacl packages, anchors and record agree with the mint');
        return;
    }
    if (values.artifacts === undefined || values['run-id'] === undefined || values.determinism === undefined) {
        throw new Error('Usage: finalize-artifacts.mjs --artifacts <dir> --run-id <id> --determinism <dir> | --check | --matches-source');
    }
    const comparison = JSON.parse(readFileSync(join(resolve(values.determinism), 'comparison.json'), 'utf8'));
    if (!ACCEPTED_COMPARISONS.has(comparison.result) || comparison.platforms.length !== PLATFORMS.length) {
        fail(`the cross-platform determinism comparison is not identical on all ${String(PLATFORMS.length)} platforms (or not on the Linux ones)`);
    }
    const targets = {};
    const entries = PLATFORMS.map((platform) => {
        const folder = join(resolve(values.artifacts), `shacl-${platform.target}`);
        if (!existsSync(join(folder, `${platform.target}.json`))) fail(`${platform.target}: no build; a mint covers all ${String(PLATFORMS.length)} targets`);
        const record = JSON.parse(readFileSync(join(folder, `${platform.target}.json`), 'utf8'));
        const binary = join(folder, platform.target, executableName(platform.target));
        const bytes = readFileSync(binary);
        if (!acceptedBuilds(platform, record)) fail(`${platform.target}: the two clean builds differ`);
        if (record.rustflags !== rustflagsRecordOf(platform.target)) fail(`${platform.target}: built with other flags than this checkout's`);
        if (sha256(bytes) !== record.runs[0].sha256) fail(`${platform.target}: the uploaded binary is not the built one`);
        if (record.cargoLockDigest !== CARGO_LOCK_SHA256 || JSON.stringify(record.toolchain) !== JSON.stringify(RUST_TOOLCHAIN)) fail(`${platform.target}: not the qualified lock or toolchain`);
        if (platform.runtime.os === 'linux' && record.builderImage !== builderImageOf(platform.target)) fail(`${platform.target}: not the pinned builder image`);
        // The source commit is GitHub's pull-request merge commit; its crate tree must be this checkout's.
        if (record.crateSourceTree !== git('rev-parse', 'HEAD:shacl/erden-shacl')) {
            fail(`${platform.target}: built from a crate other than this checkout's`);
        }
        const destination = join(shacl, platform.directory, 'bin', executableName(platform.target));
        mkdirSync(join(shacl, platform.directory, 'bin'), { recursive: true });
        copyFileSync(binary, destination);
        // Every binary is committed as 100755, Windows's too: pnpm marks package bins executable on install, so any
        // other mode would leave the checkout modified after `pnpm install`.
        chmodSync(destination, 0o755);
        targets[platform.target] = { ...record, runner: platform.runner, workflowRunId: Number(values['run-id']), package: `shacl/${platform.directory}/bin/${executableName(platform.target)}` };
        return { ...platform, bytes: statSync(destination).size, sha256: record.runs[0].sha256, responseBytes: record.knownAnswer.responseBytes, responseSha256: record.knownAnswer.responseSha256 };
    });
    const commits = new Set(Object.values(targets).map((record) => record.sourceCommit));
    if (commits.size !== 1) fail(`the ${String(PLATFORMS.length)} targets were built from different commits`);
    for (const entry of entries) writePlatformPackage(entry, engine);
    const distributionManifest = join(shacl, 'distribution/package.json');
    writeFileSync(distributionManifest, distributionManifestOf(JSON.parse(readFileSync(distributionManifest, 'utf8'))));
    writeFileSync(join(shacl, 'distribution/src/artifacts.js'), anchorsModule(entries, engine, sha256(fixture)));
    const [sourceCommit] = commits;
    const minted = new Set(entries.map((entry) => entry.sha256));
    const compared = new Set(comparison.platforms.map((platform) => platform.executableDigest));
    if (compared.size !== minted.size || ![...compared].every((digest) => minted.has(digest))) {
        fail('the determinism comparison ran binaries other than the minted ones');
    }
    writeFileSync(
        join(qualification, 'binary-reproducibility.json'),
        `${JSON.stringify(
            {
                schemaVersion: 1,
                tool: { name: 'erden-shacl', version: PACKAGE_VERSION, engineDigest: engine },
                workflow: '.github/workflows/shacl-build.yml',
                workflowRunId: Number(values['run-id']),
                sourceCommit,
                sourceCommitNote: 'pull request merge commit on GitHub; its shacl/ tree is the recorded one',
                crateSourceTree: targets['x86_64-unknown-linux-gnu'].crateSourceTree,
                cargoLockDigest: CARGO_LOCK_SHA256,
                toolchain: RUST_TOOLCHAIN,
                linuxBuilderImage: LINUX_BUILDER_IMAGE,
                linuxMuslBuilderImage: LINUX_MUSL_BUILDER_IMAGE,
                targets,
                crossPlatformDeterminism: {
                    result: comparison.result,
                    nativeDifferences: comparison.nativeDifferences,
                    requests: comparison.requests,
                    excludedFields: ['tool.executableDigest'],
                    executables: Object.fromEntries(entries.map((entry) => [entry.target, entry.sha256])),
                },
            },
            null,
            2,
        )}\n`,
    );
    if (!existsSync(join(shacl, 'distribution/src/artifacts.js'))) fail('anchors not written');
    console.log(entries.map((entry) => `${entry.directory}: ${entry.sha256} (${String(entry.bytes)} bytes)`).join('\n'));
}

if (import.meta.main) main();
