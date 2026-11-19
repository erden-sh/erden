// The distribution test of the release archive layout: builds this checkout's committed HEAD into the archive tree
// once (release/build-cli-archive.mjs --tree: bin/erden as a Node.js single executable, bin/den, the sidecar lib/),
// which runs den help, doctor, init, check and pack from it, then checks what a single executable must do besides:
// - `--version` prints the CLI's version, and Node.js's own options are the CLI's arguments, not Node's;
// - the background job mode (sea.ts) runs and exits quietly, so telemetry and update checks work from the archive;
// - the bundled CLI reads nothing from outside the tree: the workspace is not on any path it reports.
//
// The engines are the pinned ones this workspace holds (shacl/<platform>/bin or ERDEN_TEST_SHACL_BIN, and
// reasoner/<platform>/bin, else ERDEN_REASONER_BIN), and Node.js is the one running this script, which must be the pinned version (CI's setup-node
// is), or ERDEN_TEST_NODE.
//
// Usage: node scripts/test-cli-archive.mjs
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { BACKGROUND_JOB_ARGUMENT } from '../apps/cli/dist/session.js';
import { RELEASE_PLATFORMS, hostPlatform } from '../release/lib/platforms.mjs';

const root = resolve(import.meta.dirname, '..');
const windows = process.platform === 'win32';
const platformName = hostPlatform();
if (platformName === undefined) {
    throw new Error(`No release platform for ${process.platform} ${process.arch}`);
}
const directory = {
    'linux-x64': 'linux-x64-gnu',
    'linux-arm64': 'linux-arm64-gnu',
    'linux-x64-musl': 'linux-x64-musl',
    'linux-arm64-musl': 'linux-arm64-musl',
    'darwin-arm64': 'darwin-arm64',
    'win32-x64': 'win32-x64-msvc',
}[platformName];
const exe = windows ? '.exe' : '';
const shacl = process.env.ERDEN_TEST_SHACL_BIN || join(root, 'shacl', directory, 'bin', `erden-shacl${exe}`);
// The platform package's binary first: where the runner's own build differs from the pin (Windows, macOS), CI installs
// the minted one there, while ERDEN_REASONER_BIN names the runner's build.
const installedReasoner = join(root, 'reasoner', directory, 'bin', `erden-reasoner${exe}`);
const reasoner = existsSync(installedReasoner)
    ? installedReasoner
    : process.env.ERDEN_REASONER_BIN || installedReasoner;
for (const binary of [shacl, reasoner]) {
    if (!existsSync(binary)) {
        throw new Error(`${binary} is missing: build the pinned engines first`);
    }
}
const node = process.env.ERDEN_TEST_NODE || process.execPath;

function run(command, args, options = {}) {
    const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options });
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}):\n${child.stderr}${child.stdout}`,
        );
    }
    return child;
}

const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'erden-cli-archive-test-'));
try {
    const tree = join(work, 'tree');
    const built = run(process.execPath, [
        join(root, 'release', 'build-cli-archive.mjs'),
        '--tree',
        tree,
        '--node-executable',
        node,
        '--reasoner',
        reasoner,
        '--shacl',
        shacl,
    ]);
    const report = JSON.parse(built.stdout.trim().split('\n').at(-1));
    const erden = join(tree, 'bin', `erden${exe}`);
    const env = {
        ...process.env,
        HOME: join(work, 'home'),
        USERPROFILE: join(work, 'home'),
        ERDEN_TELEMETRY_DISABLED: '1',
    };
    delete env.ERDEN_REASONER_BIN;
    const version = run(erden, ['--version'], { env }).stdout.trim();
    const expected = JSON.parse(run('git', ['-C', root, 'show', 'HEAD:apps/cli/package.json']).stdout).version;
    if (version !== expected) {
        throw new Error(`erden --version printed ${version}, not ${expected}`);
    }
    // A single executable takes every argument as the CLI's: Node.js's --version would print v24.
    const nodeOption = spawnSync(erden, ['--eval', 'process.stdout.write("node")'], { encoding: 'utf8', env });
    if (nodeOption.status === 0 || nodeOption.stdout.includes('node')) {
        throw new Error('The single executable ran a Node.js option instead of refusing it as a CLI argument');
    }
    const job = Buffer.from(JSON.stringify({ schema: 'erden.background-job/v2', userAgent: 'erden/0.0.0 (test)' }));
    const background = run(erden, [BACKGROUND_JOB_ARGUMENT, job.toString('base64url')], { env });
    if (background.stdout !== '' || background.stderr !== '') {
        throw new Error(`The background job mode printed output: ${background.stderr}${background.stdout}`);
    }
    const doctor = run(erden, ['doctor', '--json'], { env, cwd: work }).stdout;
    if (doctor.includes(root)) {
        throw new Error('erden doctor from the archive tree named a workspace path');
    }
    // The RDF comparison Worker imports n3 and rdf-canonize by path from lib/ (bundle.mjs): both load from the tree's
    // copies alone, with every package they need beside them.
    for (const name of ['n3', 'rdf-canonize']) {
        const modules = join(tree, 'lib', 'node_modules');
        const manifest = JSON.parse(readFileSync(join(modules, name, 'package.json'), 'utf8'));
        const entry = pathToFileURL(join(modules, name, manifest.main ?? 'index.js')).href;
        run(node, ['--input-type=module', '--eval', `await import(${JSON.stringify(entry)});`], { cwd: work });
    }
    const layout = windows ? ['bin/erden.exe', 'bin/den.cmd'] : ['bin/erden', 'bin/den'];
    for (const path of [...layout, 'lib/package.json', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES/npm']) {
        if (!existsSync(join(tree, path))) {
            throw new Error(`The archive tree has no ${path}`);
        }
    }
    for (const absent of ['node', 'lib/dist', 'lib/src', 'lib/node_modules/effect']) {
        if (existsSync(join(tree, absent))) {
            throw new Error(`The archive tree still holds ${absent}, which the single executable bundles`);
        }
    }
    process.stdout.write(
        `${JSON.stringify({ platform: platformName, archive: RELEASE_PLATFORMS[platformName].archive, version, ...report.smoke, singleExecutable: report.singleExecutable })}\n`,
    );
} finally {
    rmSync(work, { recursive: true, force: true, maxRetries: 5 });
}
