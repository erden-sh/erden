// Builds a musl CLI archive (linux-x64-musl or linux-arm64-musl) on a glibc Linux host of the same architecture, by
// running build-cli-archive.mjs inside the pinned Node.js Alpine image: a fresh clone of the commit is installed from the
// lockfile there, so the workspace, the deployed packages and the smoke run are musl ones, as a user's Alpine machine
// has them. The inputs are checked against their pins by build-cli-archive.mjs, as on every platform. It runs as this
// host's user, never as root.
//
// The image runs natively; `--allow-emulation` lets a local rehearsal run the other architecture under QEMU, which a
// mint never does.
//
// Usage: node release/build-musl-archive.mjs --platform <linux-x64-musl|linux-arm64-musl> --node <archive>
//            --reasoner <binary> --shacl <binary> --out <directory> [--commit <sha>] [--allow-emulation]
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS } from './lib/platforms.mjs';

const repository = resolve(import.meta.dirname, '..');

/** Node.js 24.17.0 on Alpine 3.23 (the version in .node-version), by its multi-platform index digest. */
export const MUSL_BUILD_IMAGE = 'node@sha256:7c70d1235c0b4c2bc9eeed5393d19f1bbdde6885ba0d58ba62bb385d7b0f3ff1';

const DOCKER_PLATFORMS = Object.freeze({ x64: 'linux/amd64', arm64: 'linux/arm64' });

function main() {
    const { values } = parseArgs({
        options: {
            platform: { type: 'string' },
            node: { type: 'string' },
            reasoner: { type: 'string' },
            shacl: { type: 'string' },
            out: { type: 'string' },
            commit: { type: 'string', default: 'HEAD' },
            'allow-emulation': { type: 'boolean', default: false },
        },
    });
    for (const name of ['platform', 'node', 'reasoner', 'shacl', 'out']) {
        if (values[name] === undefined) {
            throw new Error(`--${name} is required`);
        }
    }
    const platform = RELEASE_PLATFORMS[values.platform];
    if (platform?.libc !== 'musl') {
        throw new Error(`${values.platform} is not a musl release platform`);
    }
    if (process.platform !== 'linux' || (process.arch !== platform.cpu && !values['allow-emulation'])) {
        throw new Error(`${values.platform} builds only on a Linux ${platform.cpu} host (no emulation)`);
    }
    const commit = execFileSync('git', ['-C', repository, 'rev-parse', '--verify', `${values.commit}^{commit}`], {
        encoding: 'utf8',
    }).trim();
    const out = resolve(values.out);
    mkdirSync(out, { recursive: true });
    const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'erden-musl-archive-'));
    try {
        // A clone holds its own object store, so it works inside the container wherever this checkout's .git is.
        execFileSync('git', ['clone', '--quiet', '--no-checkout', '--no-local', repository, join(work, 'source')]);
        execFileSync('git', ['-C', join(work, 'source'), 'checkout', '--quiet', '--detach', commit]);
        const inputs = join(work, 'inputs');
        mkdirSync(inputs);
        const nodeName = values.node.split('/').at(-1);
        copyFileSync(resolve(values.node), join(inputs, nodeName));
        copyFileSync(resolve(values.reasoner), join(inputs, 'erden-reasoner'));
        copyFileSync(resolve(values.shacl), join(inputs, 'erden-shacl'));
        const owner = `${String(process.getuid())}:${String(process.getgid())}`;
        // The pinned image with Git added, which build-cli-archive.mjs exports the commit with.
        const image = `erden-musl-builder:${MUSL_BUILD_IMAGE.slice(-12)}-${platform.cpu}`;
        const prepared = spawnSync(
            'docker',
            ['build', '--quiet', '--platform', DOCKER_PLATFORMS[platform.cpu], '--tag', image, '-'],
            { input: `FROM ${MUSL_BUILD_IMAGE}\nRUN apk add --no-cache git\n`, encoding: 'utf8' },
        );
        if (prepared.status !== 0) {
            throw new Error(`Could not prepare the musl builder image: ${prepared.stderr}`);
        }
        mkdirSync(join(work, 'user', 'bin'), { recursive: true });
        // build-cli-archive.mjs runs pnpm by name; Corepack runs the version packageManager names.
        writeFileSync(join(work, 'user', 'bin', 'pnpm'), '#!/bin/sh\nexec corepack pnpm "$@"\n', { mode: 0o755 });
        const script = [
            'set -eu',
            'cd /work/source',
            'pnpm install --frozen-lockfile --ignore-scripts',
            `node release/build-cli-archive.mjs --node "/work/inputs/${nodeName}" --reasoner /work/inputs/erden-reasoner --shacl /work/inputs/erden-shacl --out /out --commit ${commit}`,
        ].join('\n');
        // As this host's user, as the other platforms build: as root, tar would keep the exported files'
        // group-writable modes, which the CLI refuses in a project, and the smoke run would fail.
        const child = spawnSync(
            'docker',
            [
                'run',
                '--rm',
                '--platform',
                DOCKER_PLATFORMS[platform.cpu],
                '--memory',
                '8g',
                '--memory-swap',
                '8g',
                '--user',
                owner,
                '--env',
                'HOME=/work/user',
                '--env',
                'PATH=/work/user/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
                '--env',
                'COREPACK_HOME=/work/user/corepack',
                '--env',
                'COREPACK_ENABLE_DOWNLOAD_PROMPT=0',
                '--env',
                'DO_NOT_TRACK=1',
                '--mount',
                `type=bind,source=${work},target=/work`,
                '--mount',
                `type=bind,source=${out},target=/out`,
                image,
                'sh',
                '-c',
                script,
            ],
            { stdio: 'inherit' },
        );
        if (child.status !== 0) {
            throw new Error(`The ${values.platform} archive build failed (${String(child.status)})`);
        }
    } finally {
        rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    }
}

if (import.meta.main) {
    main();
}
