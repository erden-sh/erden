// The npm packages of a release, built from its archives: one package per release platform, @erden-sh/cli-<platform>,
// holding that archive's whole tree (bin/erden, the lib/ sidecar it reads, the license files) byte for byte, and the
// package @erden-sh/cli, which holds only a launcher (release/npm/launcher.cjs) for `erden` and `den` and names every
// platform package as an exact optional dependency. npm, pnpm and Yarn install only the platform package whose `os`,
// `cpu` and `libc` match the machine; the launcher runs its executable.
//
// Each archive is refused unless it is the pinned one (release/pins/<version>.json). With --pack, each package is
// packed with `npm pack` into that directory, and each tarball is refused unless it holds exactly the archive's files,
// byte for byte, with the executables still executable, and the two files written here. With --publish, those tarballs
// are published, the platform packages first: by release.yml with --provenance through npm trusted publishing, and once
// by hand by scripts/npm-bootstrap.mjs, as a package must exist before a trusted publisher can be set up for it.
//
// Usage: node release/npm-packages.mjs --assets <dir with the release archives> --version <version> --out <dir>
//        [--pack <dir> [--publish [--provenance] [--dry-run]]]
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    chmodSync,
    copyFileSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    rmSync,
    statSync,
    writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS, assertPinned } from './lib/platforms.mjs';
import { readPins } from './pins.mjs';

const release = import.meta.dirname;
const root = resolve(release, '..');

export const NPM_SCOPE = '@erden-sh';
export const MAIN_PACKAGE = `${NPM_SCOPE}/cli`;
/** The repository the packages' provenance names; npm requires repository.url to be this repository. */
export const REPOSITORY_URL = 'git+https://github.com/erden-sh/erden.git';
const AUTHOR = 'Ingenio Ventures Inc';
const HOMEPAGE = 'https://erden.sh';
const BUGS = 'https://github.com/erden-sh/erden/issues';
const DESCRIPTION = 'Erden CLI (erden / den): check, pack and publish ontology projects';
/** The files @erden-sh/cli holds besides its package.json. */
const MAIN_FILES = Object.freeze(['LICENSE', 'NOTICE', 'README.md', 'bin/erden.cjs']);

/** The package of a release platform: @erden-sh/cli-<platform>. */
export function platformPackageName(platform) {
    if (RELEASE_PLATFORMS[platform] === undefined) {
        throw new Error(`${platform} is not a release platform`);
    }
    return `${MAIN_PACKAGE}-${platform}`;
}

function platformLabel(platform) {
    const { os, cpu, libc } = RELEASE_PLATFORMS[platform];
    const system = { darwin: 'macOS', linux: 'Linux', win32: 'Windows' }[os];
    return `${system} ${cpu}${os === 'linux' ? ` (${libc ?? 'glibc'})` : ''}`;
}

function common(version) {
    return {
        version,
        license: 'Apache-2.0',
        author: AUTHOR,
        homepage: HOMEPAGE,
        bugs: { url: BUGS },
        repository: { type: 'git', url: REPOSITORY_URL },
    };
}

/** The package.json of @erden-sh/cli-<platform>. */
export function platformManifest(version, platform) {
    const { os, cpu, libc } = RELEASE_PLATFORMS[platform];
    return {
        name: platformPackageName(platform),
        description: `The Erden CLI for ${platformLabel(platform)}; install ${MAIN_PACKAGE}, which runs it`,
        ...common(version),
        os: [os],
        cpu: [cpu],
        ...(os === 'linux' ? { libc: [libc ?? 'glibc'] } : {}),
        // Yarn's Plug'n'Play runs executables only from unpacked packages.
        preferUnplugged: true,
        files: ['bin', 'lib', 'LICENSE', 'NOTICE', 'THIRD-PARTY-NOTICES', 'README.md'],
    };
}

/** The package.json of @erden-sh/cli. */
export function mainManifest(version) {
    return {
        name: MAIN_PACKAGE,
        description: DESCRIPTION,
        ...common(version),
        keywords: ['erden', 'ontology', 'owl', 'rdf', 'shacl', 'cli'],
        bin: { den: 'bin/erden.cjs', erden: 'bin/erden.cjs' },
        files: ['bin', 'LICENSE', 'NOTICE', 'README.md'],
        optionalDependencies: Object.fromEntries(
            Object.keys(RELEASE_PLATFORMS)
                .sort()
                .map((platform) => [platformPackageName(platform), version]),
        ),
        // The launcher only: the executable it runs carries its own Node.js.
        engines: { node: '>=18' },
    };
}

function platformReadme(version, platform) {
    return [
        `# ${platformPackageName(platform)}`,
        '',
        `The Erden CLI ${version} for ${platformLabel(platform)}: the release archive`,
        `\`erden-${version}-${platform}\` from https://github.com/erden-sh/erden/releases/tag/v${version}, unchanged.`,
        '',
        `Install [\`${MAIN_PACKAGE}\`](https://www.npmjs.com/package/${MAIN_PACKAGE}) instead of this package: it`,
        'installs the package for your platform and runs it as `erden` and `den`.',
        '',
        'Apache License 2.0; the copyright holder is Ingenio Ventures Inc. Third-party components keep their own',
        'licenses; see THIRD-PARTY-NOTICES.',
        '',
    ].join('\n');
}

function mainReadme(version) {
    const platforms = Object.keys(RELEASE_PLATFORMS).sort();
    return [
        `# ${MAIN_PACKAGE}`,
        '',
        'The Erden command line tool, `erden` (also available as `den`): it checks an ontology project, packs it and',
        'talks to the Erden registry. Docs: https://erden.sh',
        '',
        '```sh',
        `pnpm add -D ${MAIN_PACKAGE}`,
        'pnpm exec erden --version',
        '```',
        '',
        `or \`npm install --save-dev ${MAIN_PACKAGE}\` and \`npx erden\`.`,
        '',
        'This package holds a small launcher. Erden itself, with the Node.js, reasoner and SHACL validator it runs on,',
        'is in one package per platform, installed as an optional dependency only on the platform it is for:',
        '',
        ...platforms.map((platform) => `- \`${platformPackageName(platform)}\`: ${platformLabel(platform)}`),
        '',
        "Each holds the files of that platform's release archive byte for byte, and is published with npm provenance",
        'from the release workflow of https://github.com/erden-sh/erden. Installing with `--no-optional` or',
        '`--omit=optional` leaves Erden out; on other platforms, and to install without npm, see https://erden.sh/install.',
        '',
        `This is version ${version}. Update it as you update any dependency; \`erden upgrade\` updates only an install`,
        'made by the Erden install script.',
        '',
        'Apache License 2.0; the copyright holder is Ingenio Ventures Inc.',
        '',
    ].join('\n');
}

function run(command, args, options = {}) {
    const child = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 1 << 26, ...options });
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}): ${child.error?.message ?? ''}${child.stderr}${child.stdout}`,
        );
    }
    return child.stdout;
}

/** Every file under `directory`, as sorted '/'-separated paths; refuses links and anything but files and directories. */
export function filesUnder(directory) {
    const files = [];
    for (const entry of readdirSync(directory, { withFileTypes: true, recursive: true })) {
        const path = join(entry.parentPath, entry.name);
        const stat = lstatSync(path);
        if (stat.isFile()) {
            files.push(relative(directory, path).split(sep).join('/'));
        } else if (!stat.isDirectory()) {
            throw new Error(`${path} is neither a file nor a directory`);
        }
    }
    return files.sort();
}

function digest(path) {
    return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** Extracts `archive` into an empty `into` and returns the archive's single top directory. */
function extract(archive, into, top) {
    mkdirSync(into, { recursive: true });
    if (archive.endsWith('.zip')) {
        run('unzip', ['-q', archive, '-d', into]);
    } else {
        run('tar', ['-xzf', archive, '-C', into]);
    }
    const entries = readdirSync(into);
    if (entries.length !== 1 || entries[0] !== top) {
        throw new Error(`${archive} holds ${entries.join(', ')}, not the one directory ${top}`);
    }
    return join(into, top);
}

/** The executables of a platform's tree, which must stay executable in its package. */
function executables(platform) {
    return RELEASE_PLATFORMS[platform].os === 'win32' ? [] : ['bin/den', 'bin/erden'];
}

/** Copies `tree` into `target` file by file, keeping each file's executable bits. */
function copyTree(tree, target) {
    for (const file of filesUnder(tree)) {
        const source = join(tree, ...file.split('/'));
        const destination = join(target, ...file.split('/'));
        mkdirSync(join(destination, '..'), { recursive: true });
        copyFileSync(source, destination);
        chmodSync(destination, statSync(source).mode & 0o777);
    }
}

/**
 * Refuses the tarball `tarball` unless it holds exactly the files `expected` names (path → SHA-256 hex) and the
 * `executable` paths are executable.
 */
export function verifyTarball(tarball, expected, executable, work) {
    const into = mkdtempSync(join(work, 'verify-'));
    try {
        run('tar', ['-xzf', tarball, '-C', into]);
        const unpacked = join(into, 'package');
        const files = filesUnder(unpacked);
        const wanted = [...expected.keys()].sort();
        const missing = wanted.filter((file) => !files.includes(file));
        const extra = files.filter((file) => !expected.has(file));
        if (missing.length > 0 || extra.length > 0) {
            throw new Error(
                `${tarball} does not hold the package's files: missing ${missing.slice(0, 20).join(', ') || 'none'}; ` +
                    `extra ${extra.slice(0, 20).join(', ') || 'none'}`,
            );
        }
        for (const file of files) {
            if (digest(join(unpacked, ...file.split('/'))) !== expected.get(file)) {
                throw new Error(`${tarball}: ${file} is not the archive's file`);
            }
        }
        for (const file of executable) {
            if ((statSync(join(unpacked, ...file.split('/'))).mode & 0o111) === 0) {
                throw new Error(`${tarball}: ${file} is not executable`);
            }
        }
        return files.length;
    } finally {
        rmSync(into, { recursive: true, force: true });
    }
}

/** `npm pack` of the package at `directory` into `destination`; returns the tarball's path. */
function pack(directory, destination) {
    // --ignore-scripts: these packages have no scripts, and nothing else may run.
    const output = run('npm', ['pack', '--ignore-scripts', '--json', '--pack-destination', destination], {
        cwd: directory,
        env: npmEnvironment(),
    });
    const [{ filename }] = JSON.parse(output);
    return join(destination, filename);
}

function checkLauncherPlatforms() {
    const { PLATFORMS } = createRequire(import.meta.url)('./npm/launcher.cjs');
    const platforms = Object.keys(RELEASE_PLATFORMS).sort();
    if (JSON.stringify([...PLATFORMS].sort()) !== JSON.stringify(platforms)) {
        throw new Error(
            `release/npm/launcher.cjs names ${PLATFORMS.join(', ')}; the release platforms are ${platforms.join(', ')}`,
        );
    }
}

/**
 * Writes the packages of `version` from the release archives in `assets` into `out` (one directory per package, named
 * after it without the scope), and with `packInto` packs and verifies each there. Returns the packages, platform
 * packages first, each with its name, directory and (packed) tarball.
 */
export function buildNpmPackages({ assets, version, out, packInto, pinsRoot = root }) {
    checkLauncherPlatforms();
    const pins = readPins(version, pinsRoot);
    if (pins.version !== version || pins.complete !== true) {
        throw new Error(`release/pins/${version}.json is not the complete pins of ${version}`);
    }
    const platforms = Object.keys(RELEASE_PLATFORMS).sort();
    const pinned = Object.keys(pins.archives).sort();
    if (JSON.stringify(pinned) !== JSON.stringify(platforms)) {
        throw new Error(`The pins of ${version} name ${pinned.join(', ')}, not the release platforms`);
    }
    mkdirSync(out, { recursive: true });
    if (packInto !== undefined) {
        mkdirSync(packInto, { recursive: true });
    }
    const work = mkdtempSync(join(tmpdir(), 'erden-npm-'));
    const packages = [];
    try {
        for (const platform of platforms) {
            const pin = pins.archives[platform];
            const archive = join(assets, pin.file);
            if (!existsSync(archive)) {
                throw new Error(`${archive} is missing`);
            }
            assertPinned(archive, pin, `${platform} archive ${pin.file}`);
            const tree = extract(archive, join(work, platform), `erden-${version}-${platform}`);
            const name = platformPackageName(platform);
            const directory = join(out, name.slice(`${NPM_SCOPE}/`.length));
            rmSync(directory, { recursive: true, force: true });
            const archiveFiles = filesUnder(tree);
            for (const own of ['package.json', 'README.md']) {
                if (archiveFiles.includes(own)) {
                    throw new Error(`${pin.file} has its own ${own}`);
                }
            }
            for (const file of executables(platform)) {
                if (!archiveFiles.includes(file)) {
                    throw new Error(`${pin.file} has no ${file}`);
                }
            }
            copyTree(tree, directory);
            writeFileSync(
                join(directory, 'package.json'),
                `${JSON.stringify(platformManifest(version, platform), null, 4)}\n`,
            );
            writeFileSync(join(directory, 'README.md'), platformReadme(version, platform));
            const expected = new Map(archiveFiles.map((file) => [file, digest(join(tree, ...file.split('/')))]));
            rmSync(join(work, platform), { recursive: true, force: true });
            packages.push({ name, platform, directory, expected, executable: executables(platform) });
        }

        const directory = join(out, MAIN_PACKAGE.slice(`${NPM_SCOPE}/`.length));
        rmSync(directory, { recursive: true, force: true });
        mkdirSync(join(directory, 'bin'), { recursive: true });
        copyFileSync(join(release, 'npm', 'launcher.cjs'), join(directory, 'bin', 'erden.cjs'));
        chmodSync(join(directory, 'bin', 'erden.cjs'), 0o755);
        copyFileSync(join(root, 'LICENSE'), join(directory, 'LICENSE'));
        copyFileSync(join(root, 'NOTICE'), join(directory, 'NOTICE'));
        writeFileSync(join(directory, 'package.json'), `${JSON.stringify(mainManifest(version), null, 4)}\n`);
        writeFileSync(join(directory, 'README.md'), mainReadme(version));
        const expected = new Map(MAIN_FILES.map((file) => [file, digest(join(directory, ...file.split('/')))]));
        packages.push({ name: MAIN_PACKAGE, directory, expected, executable: ['bin/erden.cjs'] });

        for (const entry of packages) {
            entry.expected.set('package.json', digest(join(entry.directory, 'package.json')));
            entry.expected.set('README.md', digest(join(entry.directory, 'README.md')));
            if (packInto !== undefined) {
                entry.tarball = pack(entry.directory, packInto);
                entry.files = verifyTarball(entry.tarball, entry.expected, entry.executable, work);
            }
        }
    } finally {
        rmSync(work, { recursive: true, force: true });
    }
    return packages.map(({ name, platform, directory, tarball, files }) => ({
        name,
        platform,
        directory,
        tarball,
        files,
    }));
}

/**
 * Downloads the archives of `version` from its GitHub release into `into`. buildNpmPackages checks each against its pin,
 * so the download need not be trusted.
 */
export async function downloadReleaseArchives(version, into, pinsRoot = root) {
    const pins = readPins(version, pinsRoot);
    mkdirSync(into, { recursive: true });
    for (const platform of Object.keys(RELEASE_PLATFORMS).sort()) {
        const file = pins.archives[platform].file;
        const url = `https://github.com/erden-sh/erden/releases/download/v${version}/${file}`;
        const response = await fetch(url, { headers: { 'user-agent': 'erden-npm-packages/1' } });
        if (!response.ok) {
            throw new Error(`${url}: HTTP ${String(response.status)}`);
        }
        writeFileSync(join(into, file), Buffer.from(await response.arrayBuffer()));
        process.stdout.write(`downloaded ${file}\n`);
    }
}

/** The registry every npm command here talks to, whatever the user's npm configuration names. */
export const NPM_REGISTRY = 'https://registry.npmjs.org/';

/** The npm commands' environment: no update notice or funding messages. */
function npmEnvironment() {
    return { ...process.env, npm_config_update_notifier: 'false', npm_config_fund: 'false' };
}

/** Whether `name@version` is on the registry; refuses on any answer but the version or "not found". */
export function isPublished(name, version) {
    const child = spawnSync('npm', ['view', `${name}@${version}`, 'version', '--json', '--registry', NPM_REGISTRY], {
        encoding: 'utf8',
        env: npmEnvironment(),
    });
    if (child.status === 0 && child.stdout.trim() !== '') {
        if (JSON.parse(child.stdout) !== version) {
            throw new Error(`npm view ${name}@${version} answered ${child.stdout.trim()}`);
        }
        return true;
    }
    // npm view prints nothing for a version the package lacks, and E404 for a package that does not exist.
    if ((child.status === 0 && child.stdout.trim() === '') || /\bE404\b/u.test(`${child.stderr}${child.stdout}`)) {
        return false;
    }
    throw new Error(`npm view ${name}@${version} failed (${String(child.status)}):\n${child.stderr}${child.stdout}`);
}

/** The npm dist-tag of a version: `latest` for a release, `next` for a release candidate. */
export function distTag(version) {
    return version.includes('-') ? 'next' : 'latest';
}

/**
 * Publishes the packed `packages` of `version` in their order (the platform packages before @erden-sh/cli, which names
 * them), each tarball as packed and verified, skipping any version already on the registry so that a rerun finishes
 * what a failed run started. `provenance` asks npm for a provenance statement, which needs a CI run's identity (the
 * release workflow's trusted publishing); `dryRun` publishes nothing.
 */
export function publishNpmPackages(packages, version, { provenance = false, dryRun = false } = {}) {
    for (const entry of packages) {
        if (entry.tarball === undefined) {
            throw new Error(`${entry.name} was not packed`);
        }
        if (!dryRun && isPublished(entry.name, version)) {
            process.stdout.write(`${entry.name}@${version} is already on the registry\n`);
            continue;
        }
        const args = [
            'publish',
            entry.tarball,
            '--access',
            'public',
            '--tag',
            distTag(version),
            '--registry',
            NPM_REGISTRY,
            '--ignore-scripts',
            ...(provenance ? ['--provenance'] : []),
            ...(dryRun ? ['--dry-run'] : []),
        ];
        // From the tarball's directory, so that no project's .npmrc or package.json takes part.
        const child = spawnSync('npm', args, { cwd: dirname(entry.tarball), stdio: 'inherit', env: npmEnvironment() });
        if (child.status !== 0) {
            throw new Error(`npm ${args.join(' ')} failed (${String(child.status)})`);
        }
        process.stdout.write(`${dryRun ? 'would publish' : 'published'} ${entry.name}@${version}\n`);
    }
}

const USAGE =
    'Usage: node release/npm-packages.mjs --assets <dir> --version <version> --out <dir> [--pack <dir> ' +
    '[--publish [--provenance] [--dry-run]]]';

function main() {
    const { values } = parseArgs({
        options: {
            assets: { type: 'string' },
            version: { type: 'string' },
            out: { type: 'string' },
            pack: { type: 'string' },
            publish: { type: 'boolean', default: false },
            provenance: { type: 'boolean', default: false },
            'dry-run': { type: 'boolean', default: false },
        },
    });
    for (const name of ['assets', 'version', 'out']) {
        if (values[name] === undefined) {
            throw new Error(USAGE);
        }
    }
    if (values.publish && values.pack === undefined) {
        throw new Error(`--publish publishes the packed tarballs: give --pack <dir>\n${USAGE}`);
    }
    const packages = buildNpmPackages({
        assets: resolve(values.assets),
        version: values.version,
        out: resolve(values.out),
        packInto: values.pack === undefined ? undefined : resolve(values.pack),
    });
    for (const entry of packages) {
        process.stdout.write(
            `${entry.name}@${values.version}${entry.tarball === undefined ? '' : `: ${entry.tarball} (${String(entry.files)} files, verified)`}\n`,
        );
    }
    if (values.publish) {
        publishNpmPackages(packages, values.version, { provenance: values.provenance, dryRun: values['dry-run'] });
    }
}

if (import.meta.main) {
    main();
}
