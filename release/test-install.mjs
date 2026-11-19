// The install test: installs a built CLI archive with the install script, offline (`--archive`), and runs it on
// examples/erden-demo as a user would: `erden doctor` (both engines verified), `erden init`, `erden check` and
// `erden pack`. Then it changes one byte of the installed reasoner and requires `erden check` to refuse with the
// integrity error. The install script is written for the archive's own build record, so this runs before the pins
// are committed (in the mint) as well as after.
//
// On Linux (`--container`) everything runs in a pinned Ubuntu image, or for a musl archive a pinned Alpine image with
// only the C++ runtime added (`apk add libstdc++ libgcc`, as Node.js on Alpine needs), with networking disabled
// (`--network none`) and no Node.js of its own, as an unprivileged user. A musl archive of the other architecture runs
// under QEMU with `--allow-emulation`, for a local rehearsal. Elsewhere it runs on the host with a temporary home.
//
// Usage: node release/test-install.mjs --archive <file> --record <platform>.json [--container [--allow-emulation]]
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { RELEASE_PLATFORMS, assertPinned } from './lib/platforms.mjs';
import { installScripts } from './write-install-scripts.mjs';

const release = import.meta.dirname;
const repository = resolve(release, '..');
/** Ubuntu 24.04 (glibc 2.39, no Node.js), by digest. */
export const INSTALL_TEST_IMAGE =
    'ubuntu:24.04@sha256:534baea6a22c03a63003dbc8dbe78fe34bc0d7e595d9a9dc9834884ff530eb55';
/** Alpine 3.22 (musl 1.2.5, no Node.js), by digest; the musl install test adds libstdc++ to it. */
export const MUSL_INSTALL_TEST_IMAGE =
    'alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f';
const DOCKER_PLATFORMS = Object.freeze({ x64: 'linux/amd64', arm64: 'linux/arm64' });

/** The steps a user runs after installing, as a POSIX shell script; `$1` is the demo directory. */
const POSIX_STEPS = `#!/bin/sh
# Runs the installed CLI on a copy of the demo project, then refuses a reasoner changed by one byte.
set -eu
# A test run never sends telemetry.
export DO_NOT_TRACK=1
erden="$HOME/.local/bin/erden"
work=$(mktemp -d)
cp -R "$1" "$work/demo"
cd "$work"
"$erden" doctor --json > doctor.json
"$HOME/.local/bin/den" help > den-help.txt
"$erden" help > erden-help.txt
cmp den-help.txt erden-help.txt
"$erden" init project --json > init.json
"$erden" check demo --json > check.json
"$erden" pack 0.0.1 demo --json > pack.json
reasoner=$(find "$HOME/.local/share/erden" -path '*/@erden/reasoner-*/bin/erden-reasoner' | head -n 1)
[ -n "$reasoner" ] || { echo 'no installed reasoner' >&2; exit 1; }
before=$(sha256sum "$reasoner")
printf '\\001' | dd of="$reasoner" bs=1 seek=1024 count=1 conv=notrunc 2> /dev/null
if [ "$(sha256sum "$reasoner")" = "$before" ]; then
    printf '\\002' | dd of="$reasoner" bs=1 seek=1024 count=1 conv=notrunc 2> /dev/null
fi
if "$erden" check demo --json > /dev/null 2> tampered-check.txt; then
    echo 'erden check accepted a reasoner changed by one byte' >&2
    exit 1
fi
"$erden" doctor --json > tampered-doctor.json || true
for file in doctor.json init.json check.json pack.json tampered-check.txt tampered-doctor.json; do
    printf '%s ' "\${file%.*}"
    tr '\\n' ' ' < "$file" | head -c 4000
    echo
done
`;

/** The same steps on Windows, through the installed `erden.cmd`. */
function windowsSteps(target, demo) {
    // The native real path expands an 8.3 short name, which `erden init` refuses as an aliased parent.
    const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'erden-install-steps-'));
    cpSync(demo, join(work, 'demo'), { recursive: true });
    function erden(args, name = 'erden') {
        return spawnSync(
            process.env.ComSpec ?? 'cmd.exe',
            ['/d', '/s', '/c', `""${join(target, 'bin', `${name}.cmd`)}" ${args}"`],
            // `/s /c` takes off the outer quotes, and the launcher keeps its own; Node's quoting would escape them.
            {
                cwd: work,
                encoding: 'utf8',
                env: { ...process.env, DO_NOT_TRACK: '1' },
                windowsHide: true,
                windowsVerbatimArguments: true,
            },
        );
    }
    const help = erden('help');
    const aliasHelp = erden('help', 'den');
    if (help.status !== 0 || aliasHelp.status !== 0 || help.stdout !== aliasHelp.stdout) {
        throw new Error('The installed den alias did not run the same CLI as erden');
    }
    const lines = [];
    for (const [name, args] of [
        ['doctor', 'doctor --json'],
        ['init', 'init project --json'],
        ['check', 'check demo --json'],
        ['pack', 'pack 0.0.1 demo --json'],
    ]) {
        const child = erden(args);
        if (child.status !== 0) {
            throw new Error(`erden ${args} failed: ${child.stderr}${child.stdout}`);
        }
        lines.push(`${name} ${child.stdout.trim().slice(0, 4000)}`);
    }
    const reasoner = join(
        target,
        'lib',
        'node_modules',
        '@erden',
        'reasoner-win32-x64-msvc',
        'bin',
        'erden-reasoner.exe',
    );
    const bytes = readFileSync(reasoner);
    bytes[1024] ^= 1;
    writeFileSync(reasoner, bytes);
    const tampered = erden('check demo --json');
    if (tampered.status === 0) {
        throw new Error('erden check accepted a reasoner changed by one byte');
    }
    lines.push(`tampered-check ${tampered.stderr.replaceAll(/\r?\n/gu, ' ').slice(0, 4000)}`);
    lines.push(`tampered-doctor ${erden('doctor --json').stdout.trim().slice(0, 4000)}`);
    return `${lines.join('\n')}\n`;
}

function run(command, args, options = {}) {
    const child = spawnSync(command, args, {
        encoding: 'utf8',
        maxBuffer: 1 << 26,
        ...options,
        env: { ...(options.env ?? process.env), DO_NOT_TRACK: '1' },
    });
    if (child.status !== 0) {
        throw new Error(
            `${command} ${args.join(' ')} failed (${String(child.status)}):\n${child.stderr}${child.stdout}`,
        );
    }
    return child.stdout;
}

/**
 * The `docker run` platform arguments and image for a Linux archive: Ubuntu for glibc; for musl, Alpine with
 * libstdc++, built here (with the network) as a local image named by the base digest.
 */
export function containerArguments(platformName, allowEmulation) {
    const platform = RELEASE_PLATFORMS[platformName];
    if (platform?.os !== 'linux') {
        throw new Error(`--container installs a Linux archive, not ${platformName}`);
    }
    if (platform.cpu !== process.arch && !allowEmulation) {
        throw new Error(`${platformName} runs only on a ${platform.cpu} host (or with --allow-emulation)`);
    }
    const dockerPlatform = ['--platform', DOCKER_PLATFORMS[platform.cpu]];
    if (platform.libc !== 'musl') {
        return { platform: dockerPlatform, image: INSTALL_TEST_IMAGE };
    }
    const tag = `erden-install-test-musl:${MUSL_INSTALL_TEST_IMAGE.slice(-12)}-${platform.cpu}`;
    run('docker', ['build', '--quiet', ...dockerPlatform, '--tag', tag, '-'], {
        input: `FROM ${MUSL_INSTALL_TEST_IMAGE}\nRUN apk add --no-cache libstdc++ libgcc\n`,
    });
    return { platform: dockerPlatform, image: tag };
}

/** The pins of one built archive, enough to write install scripts that accept exactly it. */
function pinsOfRecord(record) {
    return { version: record.version, archives: { [record.platform]: record.archive } };
}

/** Checks the outputs the steps printed; returns a summary. */
export function checkOutputs(text) {
    const outputs = Object.fromEntries(
        text
            .trim()
            .split('\n')
            .filter((line) => /^(?:doctor|init|check|pack|tampered-check|tampered-doctor) /u.test(line))
            .map((line) => [line.slice(0, line.indexOf(' ')), line.slice(line.indexOf(' ') + 1)]),
    );
    const doctor = JSON.parse(outputs.doctor);
    for (const engine of [doctor.reasoner, doctor.shaclEngine]) {
        if (
            engine.availability !== 'available' ||
            engine.selfTest.status !== 'passed' ||
            engine.actualPlatformPackage === 'source-build'
        ) {
            throw new Error(`erden doctor did not verify an engine: ${JSON.stringify(engine)}`);
        }
    }
    const refusal = outputs['tampered-check'] ?? '';
    if (!refusal.includes('CHECK_TOOLCHAIN_UNAVAILABLE')) {
        throw new Error(`erden check refused the changed reasoner without the integrity error: ${refusal}`);
    }
    const tampered = JSON.parse(outputs['tampered-doctor']);
    if (tampered.reasoner?.failureCode !== 'BINARY_DIGEST_MISMATCH') {
        throw new Error(
            `erden doctor did not name the changed reasoner's digest: ${JSON.stringify(tampered.reasoner)}`,
        );
    }
    return {
        doctor: doctor.outcome,
        reasoner: doctor.reasoner.actualPlatformPackage,
        shaclEngine: doctor.shaclEngine.actualPlatformPackage,
        tamperedCheck: refusal.trim().slice(0, 200),
        tamperedDoctor: tampered.reasoner.failureCode,
    };
}

function main() {
    const { values } = parseArgs({
        options: {
            archive: { type: 'string' },
            record: { type: 'string' },
            container: { type: 'boolean', default: false },
            'allow-emulation': { type: 'boolean', default: false },
        },
    });
    if (values.archive === undefined || values.record === undefined) {
        throw new Error('Usage: test-install.mjs --archive <file> --record <platform>.json [--container]');
    }
    const record = JSON.parse(readFileSync(values.record, 'utf8'));
    assertPinned(values.archive, record.archive, `${record.platform} archive`);
    const scripts = installScripts(pinsOfRecord(record));
    const work = mkdtempSync(join(realpathSync.native(tmpdir()), 'erden-install-test-'));
    try {
        const input = join(work, 'in');
        mkdirSync(input);
        cpSync(values.archive, join(input, basename(values.archive)));
        cpSync(join(repository, 'examples/erden-demo'), join(input, 'demo'), { recursive: true });
        writeFileSync(join(input, 'install.sh'), scripts['install.sh']);
        writeFileSync(join(input, 'install.ps1'), scripts['install.ps1']);
        writeFileSync(join(input, 'steps.sh'), POSIX_STEPS);
        chmodSync(join(input, 'steps.sh'), 0o755);
        let output;
        if (values.container) {
            const { platform, image } = containerArguments(record.platform, values['allow-emulation']);
            output = run('docker', [
                'run',
                '--rm',
                ...platform,
                '--network',
                'none',
                '--user',
                '1000:1000',
                '--env',
                'HOME=/tmp/home',
                '--env',
                'DO_NOT_TRACK=1',
                '--volume',
                `${input}:/in:ro`,
                image,
                'sh',
                '-c',
                `mkdir -p /tmp/home && sh /in/install.sh --archive /in/${basename(values.archive)} && sh /in/steps.sh /in/demo`,
            ]);
        } else if (process.platform === 'win32') {
            const archive = join(input, basename(values.archive));
            run('powershell', [
                '-NoProfile',
                '-ExecutionPolicy',
                'Bypass',
                '-File',
                join(input, 'install.ps1'),
                '-Archive',
                archive,
            ]);
            const target = join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Erden', record.version);
            output = windowsSteps(target, join(input, 'demo'));
        } else {
            const home = join(work, 'home');
            mkdirSync(home);
            const env = { ...process.env, HOME: home, DO_NOT_TRACK: '1' };
            run('sh', [join(input, 'install.sh'), '--archive', join(input, basename(values.archive))], { env });
            output = run('sh', [join(input, 'steps.sh'), join(input, 'demo')], { env });
        }
        const summary = checkOutputs(output);
        process.stdout.write(
            `${JSON.stringify({ platform: record.platform, container: values.container, ...summary })}\n`,
        );
    } finally {
        rmSync(work, { recursive: true, force: true, maxRetries: 5 });
    }
}

if (import.meta.main) {
    main();
}
