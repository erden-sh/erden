// Builds one platform's CLI archive twice, each from its own `git archive` export of the commit, and refuses unless
// the two are byte-identical. Each build installs the export offline from the lockfile, builds the runtime packages,
// deploys `@erden/cli` with its locked production dependencies (`pnpm deploy --prod`, hoisted, so the tree has no links),
// drops pnpm's install-time state files, and puts both engine binaries at their platform packages' `bin/` paths. From
// that deployment it writes the archive tree (lib/sea.mjs): `bin/erden`, the pinned Node.js as a single executable
// application with the CLI bundled in, `bin/den`, and the `lib/` files the CLI still reads from disk (lib/bundle.mjs),
// with LICENSE, NOTICE and THIRD-PARTY-NOTICES/ for everything the deployment holds. The Node.js archive and the
// engine binaries are checked against their pins first. The first build's tree is then run as a user would
// (smoke.mjs) before it is archived, so a run that wrote into the tree would differ from the second build. Linux and
// macOS get a .tar.xz beside the .tar.gz; Windows gets a .zip.
//
// Usage: node release/build-cli-archive.mjs --node <official archive> --reasoner <binary> --shacl <binary>
//            --out <directory> [--commit <sha>] [--source-date-epoch <seconds>]
//        node release/build-cli-archive.mjs --tree <directory> (--node <official archive> | --node-executable <node>)
//            --reasoner <binary> --shacl <binary> [--commit <sha>]
//
// --tree builds the archive tree once, runs it (smoke.mjs) and leaves it in <directory>, unarchived: the distribution
// test of the archive layout (scripts/test-cli-archive.mjs). Only there may Node.js come from an executable of the
// pinned version, such as the one running the test, instead of the pinned archive; that tree has no Node.js notice.
import { execFileSync, spawnSync } from 'node:child_process';
import {
    chmodSync,
    copyFileSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { warnInJobSummary } from '../scripts/lib/ci-warning.mjs';

import { writeArchives, xzVersion } from './lib/archive.mjs';
import { normalizeDeployedWorkspace, prepareLockedDeployment } from './lib/deploy.mjs';
import { copyEngineNotices, writeNpmNotices } from './lib/notices.mjs';
import { RELEASE_PLATFORMS, archiveName, assertPinned, hostPlatform } from './lib/platforms.mjs';
import { writeSeaTree } from './lib/sea.mjs';
import { smokeTest } from './lib/smoke.mjs';

const release = import.meta.dirname;
const repository = resolve(release, '..');
const windows = process.platform === 'win32';
// The system tar for the Node.js archive: on Windows its own bsdtar, which reads the zip Node.js ships there. A Git Bash
// step puts Git's GNU tar, which reads no zip, ahead of it on the PATH.
const SYSTEM_TAR = windows ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar';

function run(command, args, options = {}) {
    const child = windows
        ? spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', [command, ...args].join(' ')], {
              encoding: 'utf8',
              windowsHide: true,
              maxBuffer: 1 << 28,
              ...options,
          })
        : spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 28, ...options });
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}): ${child.stderr}${child.stdout}`,
        );
    }
    return child.stdout;
}

/**
 * The store the workspace's install filled, as a `--store-dir` argument. pnpm keeps a store per drive or filesystem, so
 * an export in a temporary directory elsewhere (C: on a Windows runner whose checkout and store are on D:) would
 * otherwise look in an empty store and fail offline. On Windows `run` passes its command line through cmd unquoted,
 * so a store path with spaces is not supported there.
 */
function workspaceStoreArguments() {
    const store = dirname(run('pnpm', ['store', 'path'], { cwd: repository }).trim());
    return ['--store-dir', store];
}

function git(...args) {
    return execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-C', repository, ...args], {
        encoding: 'utf8',
        windowsHide: true,
    }).trim();
}

/** The commit's tree as `git archive` writes it, extracted into `directory`. */
function exportSource(commit, directory) {
    mkdirSync(directory, { recursive: true });
    const archive = join(directory, '..', `${basename(directory)}.tar`);
    git('archive', '--format=tar', `--output=${archive}`, commit);
    run('tar', ['-xf', basename(archive), '-C', basename(directory)], { cwd: dirname(directory) });
    rmSync(archive);
}

/** pnpm's files that record when or how the install ran, and the link farm a launcher never uses. */
function dropInstallState(nodeModules) {
    for (const name of readdirSync(nodeModules)) {
        if (
            name === '.bin' ||
            name === '.modules.yaml' ||
            name === '.pnpm' ||
            name.startsWith('.pnpm-workspace-state')
        ) {
            rmSync(join(nodeModules, name), { recursive: true, force: true });
        }
    }
    for (const entry of readdirSync(nodeModules, { withFileTypes: true, recursive: true })) {
        if (entry.isDirectory() && entry.name === '.bin') {
            rmSync(join(entry.parentPath, entry.name), { recursive: true, force: true });
        }
    }
}

/** The Node.js executable and its LICENSE from the official archive, extracted with the system tar. */
function extractNode(nodeArchive, runtime, directory) {
    mkdirSync(directory, { recursive: true });
    copyFileSync(nodeArchive, join(directory, basename(nodeArchive)));
    run(SYSTEM_TAR, ['-xf', basename(nodeArchive)], { cwd: directory });
    const top = join(directory, runtime.file.replace(/\.(?:tar\.(?:gz|xz)|zip)$/u, ''));
    return { executable: join(top, runtime.executable), license: join(top, 'LICENSE') };
}

/** One build of the archive tree from an export, at `stage`. */
async function buildStage(source, stage, inputs) {
    run('pnpm', ['install', '--frozen-lockfile', '--offline', '--ignore-scripts', ...inputs.store], { cwd: source });
    run('pnpm', ['run', 'build:runtime'], { cwd: source });
    // The full deployment, which the bundle is built from and the notices are written from; the archive holds only
    // its sidecar files.
    const lib = join(dirname(stage), 'deployed');
    const deployment = prepareLockedDeployment(source);
    // Project the shared lockfile instead of legacy deploy's unlocked resolution. Only this temporary export's
    // injection setting changes; the dependency graph stays fixed. Unused workspace patches do not apply here.
    const deploy = [
        'deploy',
        '--prod',
        '--offline',
        '--ignore-scripts',
        ...inputs.store,
        '--config.node-linker=hoisted',
        '--config.inject-workspace-packages=true',
    ];
    run('pnpm', ['--filter', '@erden/cli', ...deploy, '--config.allow-unused-patches=true', lib], { cwd: source });
    const nodeModules = join(lib, 'node_modules');
    dropInstallState(nodeModules);
    normalizeDeployedWorkspace(source, lib, deployment.lockfile);
    for (const engine of inputs.engines) {
        const packageRoot = join(nodeModules, ...engine.packageName.split('/'));
        const metadata = JSON.parse(readFileSync(join(packageRoot, 'metadata.json'), 'utf8'));
        if (metadata.binary?.sha256 !== engine.pin.sha256 || metadata.binary?.bytes !== engine.pin.bytes) {
            throw new Error(`${engine.packageName}/metadata.json does not pin the binary its resolver pins`);
        }
        const destination = join(packageRoot, engine.pin.binaryPath);
        mkdirSync(dirname(destination), { recursive: true });
        copyFileSync(engine.binary, destination);
        chmodSync(destination, 0o755);
    }
    const node =
        inputs.nodeExecutable === undefined
            ? extractNode(inputs.nodeArchive, inputs.nodeRuntime, join(dirname(stage), 'node-runtime'))
            : { executable: inputs.nodeExecutable, license: undefined };
    const sea = await writeSeaTree({
        deployed: lib,
        node: node.executable,
        os: inputs.platform.os,
        enginePackages: inputs.engines.map((engine) => engine.packageName),
        stage,
        work: join(dirname(stage), 'sea'),
    });
    copyFileSync(join(source, 'LICENSE'), join(stage, 'LICENSE'));
    copyFileSync(join(source, 'NOTICE'), join(stage, 'NOTICE'));
    const notices = join(stage, 'THIRD-PARTY-NOTICES');
    const policy = JSON.parse(readFileSync(join(source, 'release/license-policy.json'), 'utf8'));
    // Every package of the deployment: the bundle holds the code of each, and the sidecar some files of each.
    const packages = writeNpmNotices(nodeModules, notices, policy);
    if (node.license !== undefined) {
        mkdirSync(join(notices, 'node.js'));
        copyFileSync(node.license, join(notices, 'node.js', 'LICENSE'));
    }
    copyEngineNotices(join(source, 'reasoner/qualification'), notices, 'erden-reasoner');
    copyEngineNotices(join(source, 'shacl/qualification'), notices, 'erden-shacl');
    return { packages, dependencyLockDigest: deployment.digest, sea };
}

/** The engine pins of the exported tree for a platform; refuses a platform an engine has no pins for. */
async function enginePins(source, platform) {
    const reasoner = await import(pathToFileURL(join(source, 'reasoner/distribution/src/artifacts.js')).href);
    const shacl = await import(pathToFileURL(join(source, 'shacl/distribution/src/artifacts.js')).href);
    const pins = {
        reasoner: reasoner.QUALIFIED_REASONER_ARTIFACTS[platform.engineKey],
        shacl: shacl.QUALIFIED_ARTIFACTS[platform.engineKey],
    };
    for (const [name, pin] of Object.entries(pins)) {
        if (pin?.sha256 === null || pin?.sha256 === undefined) {
            throw new Error(`The ${name} has no pins for ${platform.engineKey}; mint the engine first`);
        }
    }
    return pins;
}

async function main() {
    const { values } = parseArgs({
        options: {
            node: { type: 'string' },
            reasoner: { type: 'string' },
            shacl: { type: 'string' },
            out: { type: 'string' },
            tree: { type: 'string' },
            'node-executable': { type: 'string' },
            commit: { type: 'string', default: 'HEAD' },
            'source-date-epoch': { type: 'string' },
        },
    });
    const tree = values.tree === undefined ? undefined : resolve(values.tree);
    for (const name of ['reasoner', 'shacl', ...(tree === undefined ? ['node', 'out'] : [])]) {
        if (values[name] === undefined) {
            throw new Error(`--${name} is required`);
        }
    }
    if (tree !== undefined && (values.node === undefined) === (values['node-executable'] === undefined)) {
        throw new Error('--tree needs one of --node and --node-executable');
    }
    if (tree === undefined && values['node-executable'] !== undefined) {
        throw new Error('--node-executable is only for --tree; an archive ships the pinned Node.js archive');
    }
    const platformName = hostPlatform();
    if (platformName === undefined) {
        throw new Error(`No release platform for ${process.platform} ${process.arch}`);
    }
    const platform = RELEASE_PLATFORMS[platformName];
    const commit = git('rev-parse', '--verify', `${values.commit}^{commit}`);
    const epoch = Number(
        values['source-date-epoch'] ?? process.env.SOURCE_DATE_EPOCH ?? git('show', '-s', '--format=%ct', commit),
    );
    if (!Number.isSafeInteger(epoch) || epoch < 315532800) {
        throw new Error('The source date epoch must be 1980 or later');
    }
    const version = JSON.parse(git('show', `${commit}:apps/cli/package.json`)).version;
    const nodeRuntimes = JSON.parse(git('show', `${commit}:release/node-runtime.json`));
    const nodeRuntime = nodeRuntimes.platforms[platformName];
    const nodeExecutable = values['node-executable'] === undefined ? undefined : resolve(values['node-executable']);
    if (nodeExecutable === undefined) {
        assertPinned(values.node, nodeRuntime, `Node.js ${nodeRuntimes.version} for ${platformName}`);
    } else {
        const reported = execFileSync(nodeExecutable, ['--version'], { encoding: 'utf8' }).trim();
        if (reported !== `v${nodeRuntimes.version}`) {
            throw new Error(`${nodeExecutable} is Node.js ${reported}, not the pinned ${nodeRuntimes.version}`);
        }
    }
    const out = tree === undefined ? resolve(values.out) : undefined;
    if (out !== undefined) {
        mkdirSync(out, { recursive: true });
    }
    const name = archiveName(version, platformName);
    const names = platform.xz ? [name, archiveName(version, platformName, 'tar.xz')] : [name];
    const prefix = name.replace(/\.(?:tar\.gz|zip)$/u, '');
    const store = workspaceStoreArguments();
    // The native real path expands a Windows 8.3 short name, so the smoke run's tree has no aliased parent.
    const temporary = mkdtempSync(join(realpathSync.native(tmpdir()), 'erden-cli-archive-'));
    try {
        const runs = [];
        let smoke;
        let pins;
        for (const label of tree === undefined ? ['a', 'b'] : ['a']) {
            const source = join(temporary, label, 'source');
            exportSource(commit, source);
            pins ??= await enginePins(source, platform);
            const engines = [
                { packageName: pins.reasoner.packageName, pin: pins.reasoner, binary: values.reasoner },
                { packageName: pins.shacl.packageName, pin: pins.shacl, binary: values.shacl },
            ];
            for (const engine of engines) {
                assertPinned(engine.binary, engine.pin, engine.packageName);
            }
            const stage = join(temporary, label, prefix);
            const { packages, dependencyLockDigest, sea } = await buildStage(source, stage, {
                engines,
                nodeArchive: values.node === undefined ? undefined : resolve(values.node),
                nodeExecutable,
                nodeRuntime,
                platform,
                store,
            });
            if (label === 'a') {
                smoke = smokeTest(stage, join(source, 'examples/erden-demo'));
            }
            if (tree !== undefined) {
                rmSync(tree, { recursive: true, force: true });
                cpSync(stage, tree, { recursive: true });
                process.stdout.write(`${JSON.stringify({ tree, smoke, singleExecutable: sea })}\n`);
                return;
            }
            const archives = writeArchives(
                stage,
                prefix,
                names.map((file) => join(temporary, label, file)),
                epoch,
            ).map((archive, index) => ({ file: names[index], ...archive }));
            runs.push({ label, packages, dependencyLockDigest, sea, archives });
        }
        const reproducible = runs[0].archives.every(
            (archive, index) =>
                archive.sha256 === runs[1].archives[index].sha256 && archive.bytes === runs[1].archives[index].bytes,
        );
        // On Linux a difference fails the build. On Windows and macOS, whose runner images no pin covers, it is a
        // warning and the first build is kept: the pins name its bytes, and the tag publishes exactly those.
        function digests(build) {
            return build.archives.map((archive) => archive.sha256).join(', ');
        }
        if (!reproducible && process.platform === 'linux') {
            throw new Error(`${name} is not reproducible: ${digests(runs[0])} vs ${digests(runs[1])}`);
        }
        if (!reproducible) {
            warnInJobSummary(
                `${name}: the two builds differ (${digests(runs[0])} vs ${digests(runs[1])}); the first is kept`,
            );
        }
        for (const file of names) {
            copyFileSync(join(temporary, 'a', file), join(out, file));
        }
        const [primary, xz] = runs[0].archives;
        const record = {
            schema: 'erden.cli-archive-build/v1',
            version,
            platform: platformName,
            sourceCommit: commit,
            sourceDateEpoch: epoch,
            archive: primary,
            ...(xz === undefined ? {} : { xzArchive: { ...xz, xz: xzVersion() } }),
            node: {
                version: nodeRuntimes.version,
                file: nodeRuntime.file,
                sha256: nodeRuntime.sha256,
            },
            singleExecutable: runs[0].sea,
            dependencyLockDigest: runs[0].dependencyLockDigest,
            engines: {
                reasoner: { packageName: pins.reasoner.packageName, sha256: pins.reasoner.sha256 },
                shacl: { packageName: pins.shacl.packageName, sha256: pins.shacl.sha256 },
            },
            npmPackages: runs[0].packages,
            runs: runs.map(({ label, archives }) => ({ label, archives })),
            smoke,
            result: reproducible ? 'byte-identical' : 'native-builds-differ',
        };
        writeFileSync(join(out, `${platformName}.json`), `${JSON.stringify(record, null, 2)}\n`);
        for (const archive of runs[0].archives) {
            process.stdout.write(
                `${archive.file}: ${archive.sha256} (${String(archive.bytes)} bytes); ${reproducible ? 'both builds match' : 'the first build kept'}\n`,
            );
        }
    } finally {
        if (existsSync(temporary)) {
            rmSync(temporary, { recursive: true, force: true, maxRetries: 5 });
        }
    }
}

if (import.meta.main) {
    await main();
}
