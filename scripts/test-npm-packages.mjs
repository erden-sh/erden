// Installs a release's npm packages the way a project would, without the npm registry: builds and packs them
// (release/npm-packages.mjs) from the release archives, installs the main package's tarball into a scratch pnpm project
// whose overrides point every platform package at its tarball, and runs `pnpm exec erden --version` and `den --version`.
// It checks that pnpm installed only this machine's platform package, that the launcher passes on Erden's exit status,
// and that a project without this platform's package gets the launcher's error. Nothing is published, and the scratch
// project's registry is an address nothing listens on, so nothing is fetched while installing.
//
// --assets is a directory with the release archives (as the release has them); without it, the archives of --version
// are downloaded from its GitHub release (and checked against the pins, as always).
// --musl also installs the musl package and runs it in the digest-pinned Node.js Alpine image the musl archives build in
// (Docker, no network). --foreign-arch installs the other CPU's Linux package and checks its bytes, without running it.
//
// Usage: node scripts/test-npm-packages.mjs [--version <version>] [--assets <dir>] [--musl] [--foreign-arch] [--keep]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { MUSL_BUILD_IMAGE } from '../release/build-musl-archive.mjs';
import { RELEASE_PLATFORMS, hostPlatform } from '../release/lib/platforms.mjs';
import {
    MAIN_PACKAGE,
    buildNpmPackages,
    downloadReleaseArchives,
    platformPackageName,
} from '../release/npm-packages.mjs';

const root = resolve(import.meta.dirname, '..');

function run(command, args, options = {}) {
    const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options });
    if (child.error !== undefined) {
        throw child.error;
    }
    return child;
}

function succeed(command, args, options = {}) {
    const child = run(command, args, options);
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}):\n${child.stderr}${child.stdout}`,
        );
    }
    return child.stdout;
}

/** A scratch pnpm project at `directory` with every platform package overridden to its tarball. */
function scratchProject(directory, packages, supportedArchitectures) {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'package.json'), `${JSON.stringify({ name: 'scratch', private: true }, null, 4)}\n`);
    const overrides = packages
        .filter((entry) => entry.platform !== undefined)
        .map((entry) => `    '${entry.name}': 'file:${entry.tarball}'`);
    const architectures =
        supportedArchitectures === undefined
            ? []
            : [
                  'supportedArchitectures:',
                  ...Object.entries(supportedArchitectures).map(
                      ([key, values]) => `    ${key}: [${values.join(', ')}]`,
                  ),
              ];
    writeFileSync(
        join(directory, 'pnpm-workspace.yaml'),
        ['overrides:', ...overrides, ...architectures, ''].join('\n'),
    );
    // Nothing listens on port 9 (discard): any registry request fails at once instead of reaching a registry.
    writeFileSync(join(directory, '.npmrc'), 'registry=http://127.0.0.1:9/\n');
}

function install(directory, mainTarball) {
    succeed('pnpm', ['add', '--save-dev', `file:${mainTarball}`], {
        cwd: directory,
        env: { ...process.env, npm_config_update_notifier: 'false' },
    });
}

/** The @erden-sh packages pnpm installed in `directory`, by name. */
function installed(directory) {
    const store = join(directory, 'node_modules', '.pnpm');
    return readdirSync(store)
        .filter((entry) => entry.startsWith('@erden-sh+'))
        .map((entry) => entry.replace(/^@erden-sh\+/u, '@erden-sh/').replace(/@file\+.*$|@\d.*$/u, ''))
        .sort();
}

function installedRoot(directory, name) {
    const store = join(directory, 'node_modules', '.pnpm');
    const entry = readdirSync(store).find(
        (candidate) =>
            candidate.startsWith(`${name.replace('/', '+')}@`) &&
            existsSync(join(store, candidate, 'node_modules', ...name.split('/'))),
    );
    if (entry === undefined) {
        throw new Error(`${name} is not installed in ${directory}`);
    }
    return join(store, entry, 'node_modules', ...name.split('/'));
}

function expect(condition, message) {
    if (!condition) {
        throw new Error(message);
    }
    process.stdout.write(`ok: ${message}\n`);
}

async function main() {
    const { values } = parseArgs({
        options: {
            version: { type: 'string' },
            assets: { type: 'string' },
            musl: { type: 'boolean', default: false },
            'foreign-arch': { type: 'boolean', default: false },
            keep: { type: 'boolean', default: false },
        },
    });
    const version = values.version ?? JSON.parse(readFileSync(join(root, 'apps/cli/package.json'), 'utf8')).version;
    const host = hostPlatform();
    if (host === undefined || RELEASE_PLATFORMS[host].os === 'win32') {
        throw new Error('This test runs on a Linux or macOS release platform');
    }
    const work = mkdtempSync(join(tmpdir(), 'erden-npm-test-'));
    try {
        let assets = values.assets === undefined ? undefined : resolve(values.assets);
        if (assets === undefined) {
            assets = join(work, 'assets');
            await downloadReleaseArchives(version, assets);
        }
        const packages = buildNpmPackages({
            assets,
            version,
            out: join(work, 'packages'),
            packInto: join(work, 'tarballs'),
        });
        for (const entry of packages) {
            process.stdout.write(`packed ${entry.name}@${version} (${String(entry.files)} files, verified)\n`);
        }
        const main = packages.find((entry) => entry.name === MAIN_PACKAGE);

        // This machine: only its platform package, and both commands run.
        const project = join(work, 'project');
        scratchProject(project, packages);
        install(project, main.tarball);
        const names = installed(project);
        expect(
            JSON.stringify(names) === JSON.stringify([MAIN_PACKAGE, platformPackageName(host)].sort()),
            `pnpm installed ${names.join(' and ')} on ${host}`,
        );
        for (const command of ['erden', 'den']) {
            const output = succeed('pnpm', ['exec', command, '--version'], { cwd: project }).trim();
            expect(output.includes(version), `pnpm exec ${command} --version printed ${JSON.stringify(output)}`);
        }
        // The launcher's exit status is Erden's: compare with the executable run directly on an unknown command.
        const executable = join(installedRoot(project, platformPackageName(host)), 'bin', 'erden');
        const direct = run(executable, ['no-such-command']);
        const launched = run('pnpm', ['exec', 'erden', 'no-such-command'], { cwd: project });
        expect(
            direct.status !== 0 && launched.status === direct.status && launched.stderr.includes(direct.stderr.trim()),
            `erden no-such-command exits ${String(launched.status)} through the launcher, as the executable does`,
        );

        // A project without this platform's package: the launcher says which package is missing.
        const other =
            RELEASE_PLATFORMS[host].os === 'darwin'
                ? { os: ['linux'], cpu: ['x64'] }
                : { os: ['darwin'], cpu: ['arm64'] };
        const missing = join(work, 'missing');
        scratchProject(missing, packages, other);
        install(missing, main.tarball);
        const refused = run('pnpm', ['exec', 'erden', '--version'], { cwd: missing });
        expect(
            refused.status === 1 &&
                refused.stderr.includes(platformPackageName(host)) &&
                refused.stderr.includes('https://erden.sh/install'),
            `without ${platformPackageName(host)}, erden exits 1 naming it: ${refused.stderr.trim()}`,
        );

        if (values['foreign-arch'] && RELEASE_PLATFORMS[host].os === 'linux') {
            const cpu = process.arch === 'x64' ? 'arm64' : 'x64';
            const foreign = join(work, 'foreign');
            scratchProject(foreign, packages, { os: ['linux'], cpu: [cpu], libc: ['glibc'] });
            install(foreign, main.tarball);
            const foreignNames = installed(foreign);
            const name = platformPackageName(`linux-${cpu}`);
            expect(
                JSON.stringify(foreignNames) === JSON.stringify([MAIN_PACKAGE, name].sort()),
                `with supportedArchitectures cpu ${cpu}, pnpm installed ${foreignNames.join(' and ')}`,
            );
            const description = succeed('file', ['-bL', join(installedRoot(foreign, name), 'bin', 'erden')]);
            expect(
                description.includes(cpu === 'arm64' ? 'aarch64' : 'x86-64'),
                `${name}'s bin/erden is ${description.trim().split(',').slice(0, 2).join(',')}`,
            );
        }

        if (values.musl && RELEASE_PLATFORMS[host].os === 'linux') {
            const cpu = RELEASE_PLATFORMS[host].cpu;
            const musl = join(work, 'musl');
            scratchProject(musl, packages, { os: ['linux'], cpu: [cpu], libc: ['musl'] });
            install(musl, main.tarball);
            const muslNames = installed(musl);
            const name = platformPackageName(`linux-${cpu}-musl`);
            expect(
                JSON.stringify(muslNames) === JSON.stringify([MAIN_PACKAGE, name].sort()),
                `with supportedArchitectures libc musl, pnpm installed ${muslNames.join(' and ')}`,
            );
            const output = succeed('docker', [
                'run',
                '--rm',
                '--network',
                'none',
                '--platform',
                `linux/${cpu === 'x64' ? 'amd64' : 'arm64'}`,
                '--volume',
                `${musl}:${musl}:ro`,
                '--workdir',
                musl,
                MUSL_BUILD_IMAGE,
                'node_modules/.bin/erden',
                '--version',
            ]).trim();
            expect(
                output.includes(version),
                `in Alpine (musl), node_modules/.bin/erden --version printed ${JSON.stringify(output)}`,
            );
        }
        process.stdout.write(`The npm packages of ${version} install and run on ${host}\n`);
    } finally {
        if (values.keep) {
            process.stdout.write(`kept ${work}\n`);
        } else {
            rmSync(work, { recursive: true, force: true });
        }
    }
}

await main();
