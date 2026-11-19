import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
    chmodSync,
    existsSync,
    lstatSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    readlinkSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, win32 } from 'node:path';
import { describe, it } from 'node:test';

import { writeArchive } from '../../release/lib/archive.mjs';
import { RELEASE_PLATFORMS, archiveName, sha256 } from '../../release/lib/platforms.mjs';
import { installScriptDifferences, installScripts } from '../../release/write-install-scripts.mjs';

const root = resolve(import.meta.dirname, '../..');
const VERSION = '1.0.0';

/** A release archive for `platform` holding a launcher that prints a marker, and pins naming it. */
function fixture(platform = 'linux-x64', withAlias = true) {
    const directory = mkdtempSync(join(tmpdir(), 'erden-install-test-'));
    const tree = join(directory, 'tree');
    mkdirSync(join(tree, 'bin'), { recursive: true });
    writeFileSync(join(tree, 'bin', 'erden'), '#!/bin/sh\necho installed-erden "$@"\n');
    chmodSync(join(tree, 'bin', 'erden'), 0o755);
    if (withAlias) {
        writeFileSync(join(tree, 'bin', 'den'), '#!/bin/sh\necho installed-erden "$@"\n');
        chmodSync(join(tree, 'bin', 'den'), 0o755);
    }
    const file = archiveName(VERSION, platform);
    const archive = join(directory, file);
    const pin = { file, ...writeArchive(tree, `erden-${VERSION}-${platform}`, archive, 1_700_000_000) };
    const archives = Object.fromEntries(
        Object.keys(RELEASE_PLATFORMS).map((name) => [
            name,
            name === platform ? pin : { file: archiveName(VERSION, name), bytes: 1, sha256: sha256('other') },
        ]),
    );
    const pins = { version: VERSION, archives };
    const script = join(directory, 'install.sh');
    writeFileSync(script, installScripts(pins)['install.sh']);
    const home = join(directory, 'home');
    mkdirSync(home);
    const shims = join(directory, 'shims');
    mkdirSync(shims);
    return { directory, archive, script, home, shims, pins, file };
}

/**
 * A PATH shim: `uname` answers as `system`/`machine`, `sysctl` reports Rosetta 2 when `translated`, and `curl` logs its
 * arguments and copies to its -o target `served`, or the file `routes` gives for the URL's last segment.
 */
function shim(
    context,
    { system = 'Linux', machine = 'x86_64', served, routes = {}, musl = false, translated = false } = {},
) {
    writeFileSync(
        join(context.shims, 'uname'),
        `#!/bin/sh\ncase "$1" in -s) echo ${system} ;; -m) echo ${machine} ;; esac\n`,
    );
    writeFileSync(join(context.shims, 'sysctl'), `#!/bin/sh\necho ${translated ? 1 : 0}\n`);
    const route = Object.entries(routes)
        .map(([name, file]) => `*/${name}) cp "${file}" "$out"; exit 0 ;;`)
        .join(' ');
    writeFileSync(
        join(context.shims, 'curl'),
        `#!/bin/sh\nprintf '%s\\n' "$*" >> "${join(context.directory, 'curl.log')}"\n` +
            'out=""; url=""; while [ "$#" -gt 0 ]; do case $1 in -o) out=$2; shift ;; https://*) url=$1 ;; esac; shift; done\n' +
            `case $url in ${route} esac\n` +
            (served === undefined ? 'exit 22\n' : `cp "${served}" "$out"\n`),
    );
    writeFileSync(
        join(context.shims, 'ldd'),
        `#!/bin/sh\necho '${musl ? 'musl libc (x86_64)' : 'ldd (GNU libc) 2.39'}'\n`,
    );
    for (const name of ['uname', 'sysctl', 'curl', 'ldd']) {
        chmodSync(join(context.shims, name), 0o755);
    }
}

/** Runs install.sh with `args`; `environment` adds variables (SHELL is unset unless given). */
function install(context, args, environment = {}) {
    return spawnSync('sh', [context.script, ...args], {
        encoding: 'utf8',
        env: { PATH: `${context.shims}:/usr/bin:/bin`, HOME: context.home, ...environment },
    });
}

/** The Erden lines of a profile in the fixture's home, or undefined when it does not exist. */
function profile(context, name) {
    const path = join(context.home, name);
    return existsSync(path) ? readFileSync(path, 'utf8') : undefined;
}

const PROFILE_LINE = '. "$HOME/.local/share/erden/env"';

function leftovers(context) {
    const data = join(context.home, '.local', 'share', 'erden');
    return existsSync(data) ? readdirSync(data) : [];
}

describe('install.sh', { skip: process.platform === 'win32' }, () => {
    it('installs a local archive with no network request and links erden into ~/.local/bin', () => {
        const context = fixture();
        try {
            shim(context);
            const result = install(context, ['--archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            const target = join(context.home, '.local', 'share', 'erden', VERSION);
            const link = join(context.home, '.local', 'bin', 'erden');
            assert.ok(lstatSync(link).isSymbolicLink());
            assert.equal(readlinkSync(link), join(target, 'bin', 'erden'));
            assert.equal(spawnSync(link, ['doctor'], { encoding: 'utf8' }).stdout, 'installed-erden doctor\n');
            const alias = join(context.home, '.local', 'bin', 'den');
            assert.ok(lstatSync(alias).isSymbolicLink());
            assert.equal(readlinkSync(alias), join(target, 'bin', 'den'));
            assert.equal(spawnSync(alias, ['doctor'], { encoding: 'utf8' }).stdout, 'installed-erden doctor\n');
            assert.equal(existsSync(join(context.directory, 'curl.log')), false, 'an --archive install made a request');
            // The version and the env script the shell profiles source.
            assert.deepEqual(leftovers(context), [VERSION, 'env']);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses a digest-valid archive missing den before installing it', () => {
        const context = fixture('linux-x64', false);
        try {
            shim(context);
            const result = install(context, ['--archive', context.archive]);
            assert.notEqual(result.status, 0);
            assert.match(result.stderr, /does not hold bin\/den/u);
            assert.deepEqual(leftovers(context), []);
            assert.equal(existsSync(join(context.home, '.local', 'bin', 'erden')), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('downloads from the release with a generic User-Agent and checks the digest', () => {
        const context = fixture();
        try {
            shim(context, { served: context.archive });
            const result = install(context, []);
            assert.equal(result.status, 0, result.stderr);
            const request = readFileSync(join(context.directory, 'curl.log'), 'utf8');
            assert.match(request, /-A erden-install\/1 /u);
            assert.match(
                request,
                new RegExp(`https://github\\.com/erden-sh/erden/releases/download/v1\\.0\\.0/${context.file}`, 'u'),
            );
            assert.ok(existsSync(join(context.home, '.local', 'share', 'erden', VERSION, 'bin', 'erden')));
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses an archive with another digest, a partial download and a failed download, leaving nothing installed', () => {
        const context = fixture();
        try {
            const swapped = join(context.directory, 'swapped.tar.gz');
            const bytes = readFileSync(context.archive);
            bytes[bytes.length - 1] ^= 1;
            writeFileSync(swapped, bytes);
            shim(context);
            let result = install(context, ['--archive', swapped]);
            assert.equal(result.status, 1);
            assert.match(
                result.stderr,
                /SHA-256 is not the one erden-1\.0\.0-linux-x64\.tar\.gz was released with; nothing was installed/u,
            );
            const partial = join(context.directory, 'partial.tar.gz');
            writeFileSync(partial, readFileSync(context.archive).subarray(0, 100));
            shim(context, { served: partial });
            result = install(context, []);
            assert.equal(result.status, 1);
            assert.match(
                result.stderr,
                /is 100 bytes, not the \d+ bytes of erden-1\.0\.0-linux-x64\.tar\.gz \(a partial or different download\)/u,
            );
            shim(context);
            result = install(context, []);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /could not download https:/u);
            assert.deepEqual(leftovers(context), []);
            assert.equal(existsSync(join(context.home, '.local', 'bin', 'erden')), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses unsupported platforms before anything is downloaded', () => {
        const context = fixture();
        try {
            for (const [options, pattern] of [
                [{ system: 'FreeBSD' }, /unsupported platform: FreeBSD x86_64/u],
                [{ system: 'Darwin', machine: 'x86_64' }, /unsupported platform: darwin-x64/u],
                [{ machine: 'riscv64' }, /unsupported platform: linux-riscv64/u],
                [
                    { musl: true },
                    /Erden on linux-x64-musl needs libstdc\+\+\.so\.6; install it first \(Alpine: apk add libstdc\+\+ libgcc\)/u,
                ],
            ]) {
                shim(context, { ...options, served: context.archive });
                const result = install(context, []);
                assert.equal(result.status, 1, JSON.stringify(options));
                assert.match(result.stderr, pattern);
            }
            assert.equal(existsSync(join(context.directory, 'curl.log')), false);
            assert.deepEqual(leftovers(context), []);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('adds ~/.local/bin to the PATH in the shell profiles once, and --uninstall takes everything back out', () => {
        const context = fixture();
        try {
            shim(context);
            writeFileSync(join(context.home, '.bashrc'), 'export KEPT=1');
            mkdirSync(join(context.home, '.config', 'fish'), { recursive: true });
            const environment = { SHELL: '/bin/zsh' };
            let result = install(context, ['--archive', context.archive], environment);
            assert.equal(result.status, 0, result.stderr);
            assert.match(
                result.stdout,
                /Added ~\/\.local\/bin to your PATH in: ~\/\.profile ~\/\.bashrc ~\/\.zshenv /u,
            );
            assert.match(result.stdout, /To use it in this shell now, run:\n {4}\. ".*\/\.local\/share\/erden\/env"/u);
            for (const name of ['.profile', '.bashrc', '.zshenv']) {
                assert.equal(profile(context, name).split(PROFILE_LINE).length, 2, name);
            }
            assert.equal(profile(context, '.bashrc').split('\n')[0], 'export KEPT=1');
            assert.equal(profile(context, '.bash_profile'), undefined, 'a bash file that did not exist was created');
            const fish = profile(context, '.config/fish/conf.d/erden.fish');
            assert.match(fish, /set -gx PATH "\$HOME\/\.local\/bin" \$PATH/u);
            // A login shell that reads ~/.profile now finds erden.
            const login = spawnSync('sh', ['-c', `. "${join(context.home, '.profile')}" && command -v erden`], {
                encoding: 'utf8',
                env: { PATH: '/usr/bin:/bin', HOME: context.home },
            });
            assert.equal(login.stdout.trim(), join(context.home, '.local', 'bin', 'erden'));

            result = install(context, ['--archive', context.archive], environment);
            assert.equal(result.status, 0, result.stderr);
            assert.doesNotMatch(result.stdout, /Added/u);
            assert.deepEqual(readdirSync(join(context.home, '.local', 'bin')).sort(), ['den', 'erden']);
            for (const name of ['.profile', '.bashrc', '.zshenv']) {
                assert.equal(profile(context, name).split(PROFILE_LINE).length, 2, `${name} after a second install`);
            }

            // The package store shares the data directory with the installs; uninstalling keeps it.
            const store = join(context.home, '.local', 'share', 'erden', 'store', 'v1');
            mkdirSync(store, { recursive: true });
            writeFileSync(join(store, 'kept'), 'package');
            result = install(context, ['--uninstall'], environment);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(join(store, 'kept'), 'utf8'), 'package');
            assert.deepEqual(leftovers(context), ['store']);
            rmSync(join(context.home, '.local', 'share', 'erden', 'store'), { recursive: true });
            assert.equal(profile(context, '.bashrc'), 'export KEPT=1\n');
            for (const name of ['.profile', '.zshenv']) {
                assert.doesNotMatch(profile(context, name), /erden/iu, name);
            }
            assert.equal(profile(context, '.config/fish/conf.d/erden.fish'), undefined);
            assert.equal(existsSync(join(context.home, '.local', 'bin', 'erden')), false);
            assert.equal(existsSync(join(context.home, '.local', 'bin', 'den')), false);
            assert.equal(existsSync(join(context.directory, 'curl.log')), false, '--uninstall made a request');
            result = install(context, ['--uninstall'], environment);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(existsSync(join(context.home, '.local', 'share', 'erden')), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('leaves the profiles alone with --no-modify-path, ERDEN_NO_MODIFY_PATH=1, or the directory already on the PATH', () => {
        const context = fixture();
        try {
            shim(context);
            const bin = join(context.home, '.local', 'bin');
            for (const [args, environment] of [
                [['--no-modify-path'], {}],
                [[], { ERDEN_NO_MODIFY_PATH: '1' }],
                [[], { PATH: `${context.shims}:${bin}:/usr/bin:/bin` }],
            ]) {
                const result = install(context, ['--archive', context.archive, ...args], {
                    SHELL: '/bin/zsh',
                    ...environment,
                });
                assert.equal(result.status, 0, result.stderr);
                assert.doesNotMatch(result.stdout, /Added/u);
                assert.deepEqual(readdirSync(context.home), ['.local'], JSON.stringify(environment));
                assert.equal(existsSync(join(context.home, '.local', 'share', 'erden', 'env')), false);
            }
            const result = install(context, ['--archive', context.archive, '--no-modify-path']);
            assert.match(result.stdout, /Add ~\/\.local\/bin to your PATH to run erden/u);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('runs piped into sh, and a script cut short installs nothing', () => {
        const context = fixture();
        try {
            shim(context, { served: context.archive });
            const text = readFileSync(context.script, 'utf8');
            const environment = { PATH: `${context.shims}:/usr/bin:/bin`, HOME: context.home };
            let result = spawnSync('sh', ['-s', '--', '--no-modify-path'], {
                input: text,
                encoding: 'utf8',
                env: environment,
            });
            assert.equal(result.status, 0, result.stderr);
            assert.ok(existsSync(join(context.home, '.local', 'share', 'erden', VERSION, 'bin', 'erden')));
            result = spawnSync('sh', ['-s', '--', '--help'], { input: text, encoding: 'utf8', env: environment });
            assert.match(result.stdout, /curl -fsSL https:\/\/erden\.sh\/install \| sh/u);
            rmSync(join(context.home, '.local'), { recursive: true });
            // Everything up to the last line only defines functions.
            const cut = text.slice(0, text.lastIndexOf('main "$@"'));
            for (const length of [cut.length, Math.floor(cut.length / 2)]) {
                result = spawnSync('sh', [], { input: cut.slice(0, length), encoding: 'utf8', env: environment });
                assert.deepEqual(
                    readdirSync(context.home),
                    [],
                    `a script cut at ${String(length)} bytes did something`,
                );
            }
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it("installs another version, with ERDEN_VERSION or --version, against that release's SHA256SUMS", () => {
        const context = fixture();
        try {
            const other = '0.9.0';
            const tree = join(context.directory, 'tree');
            const file = archiveName(other, 'linux-x64');
            const archive = join(context.directory, file);
            const { sha256: digest } = writeArchive(tree, `erden-${other}-linux-x64`, archive, 1_700_000_000);
            const sums = join(context.directory, 'SHA256SUMS');
            writeFileSync(sums, `${'0'.repeat(64)}  erden-${other}-darwin-arm64.tar.gz\n${digest.slice(7)}  ${file}\n`);
            shim(context, { routes: { SHA256SUMS: sums, [file]: archive } });
            let result = install(context, ['--no-modify-path'], { ERDEN_VERSION: `v${other}` });
            assert.equal(result.status, 0, result.stderr);
            assert.ok(existsSync(join(context.home, '.local', 'share', 'erden', other, 'bin', 'erden')));
            const requests = readFileSync(join(context.directory, 'curl.log'), 'utf8');
            assert.match(requests, /releases\/download\/v0\.9\.0\/SHA256SUMS/u);
            assert.match(requests, /releases\/download\/v0\.9\.0\/erden-0\.9\.0-linux-x64\.tar\.gz/u);

            writeFileSync(sums, `${'0'.repeat(64)}  ${file}\n`);
            result = install(context, ['--version', other]);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /SHA-256 is not the one erden-0\.9\.0-linux-x64\.tar\.gz was released with/u);
            result = install(context, ['--version', other, '--archive', archive]);
            assert.match(result.stderr, /--archive installs only 1\.0\.0/u);
            result = install(context, ['--version', '1.0;reboot']);
            assert.match(result.stderr, /not a version: 1\.0;reboot/u);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('installs the arm64 archive from a shell under Rosetta 2', () => {
        const context = fixture('darwin-arm64');
        try {
            shim(context, { system: 'Darwin', machine: 'x86_64', translated: true });
            const result = install(context, ['--archive', context.archive, '--no-modify-path']);
            assert.equal(result.status, 0, result.stderr);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('installs the macOS arm64 archive on macOS arm64', () => {
        const context = fixture('darwin-arm64');
        try {
            shim(context, { system: 'Darwin', machine: 'arm64' });
            const result = install(context, ['--archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            assert.ok(existsSync(join(context.home, '.local', 'share', 'erden', VERSION, 'bin', 'erden')));
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });
});

const POWERSHELL = ['pwsh', 'powershell'].find(
    (name) =>
        spawnSync(name, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.Major'], { encoding: 'utf8' }).status ===
        0,
);

/**
 * install.ps1 for a win32-x64 zip. Off Windows the script refuses the platform first, so the digest and install paths
 * run in a copy whose platform check is forced, with the user's data folder under a temporary home. The copy keeps the
 * user PATH in a file instead of the registry, so no test changes the PATH of the machine it runs on.
 */
function powershellFixture() {
    const context = fixture('win32-x64');
    const windows = process.platform === 'win32';
    const tree = join(context.directory, 'tree');
    writeFileSync(join(tree, 'bin', 'erden.cmd'), '@echo off\r\necho installed-erden %*\r\n');
    writeFileSync(join(tree, 'bin', 'den.cmd'), '@echo off\r\necho installed-erden %*\r\n');
    const pin = {
        file: context.file,
        ...writeArchive(tree, `erden-${VERSION}-win32-x64`, context.archive, 1_700_000_000),
    };
    const pins = { ...context.pins, archives: { ...context.pins.archives, 'win32-x64': pin } };
    const script = join(context.directory, 'install.ps1');
    const text = installScripts(pins)['install.ps1'];
    writeFileSync(script, text);
    const userPath = join(context.directory, 'user-path.txt');
    const fileBackedPath = [
        "    function Get-UserPath { if (Test-Path -LiteralPath $env:ERDEN_TEST_USER_PATH) { return [IO.File]::ReadAllText($env:ERDEN_TEST_USER_PATH) } return '' }",
        '    function Set-UserPath([string]$value) { [IO.File]::WriteAllText($env:ERDEN_TEST_USER_PATH, $value) }',
        '',
        '    $localData = ',
    ].join('\n');
    assert.ok(text.includes('\n    $localData = '));
    let forcedText = text.replace('    $localData = ', fileBackedPath);
    if (!windows) {
        forcedText = forcedText.replace("if (-not $isWindowsHost -or $architecture -ne 'X64') {", 'if ($false) {');
    }
    const forced = join(context.directory, 'install-forced.ps1');
    writeFileSync(forced, forcedText);
    const env = { ...process.env, LOCALAPPDATA: context.home, ERDEN_TEST_USER_PATH: userPath };
    delete env.ERDEN_VERSION;
    delete env.ERDEN_NO_MODIFY_PATH;
    const programs = join(context.home, 'Programs', 'Erden');
    function run(file, args, extra = {}) {
        return spawnSync(POWERSHELL, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
            encoding: 'utf8',
            env: { ...env, ...extra },
        });
    }
    /** Runs `command` in one PowerShell session with no -File, as `irm | iex` does. */
    function session(command, extra = {}) {
        return spawnSync(POWERSHELL, ['-NoProfile', '-Command', command], {
            encoding: 'utf8',
            env: { ...env, ...extra },
        });
    }
    return { ...context, script, forced, programs, userPath, run, session };
}

/** Pins naming one win32-x64 file, enough to write install.ps1. */
function powershellPins() {
    return {
        version: VERSION,
        archives: { 'win32-x64': { file: archiveName(VERSION, 'win32-x64'), bytes: 1, sha256: sha256('w') } },
    };
}

describe('install.ps1', { skip: POWERSHELL === undefined ? 'no PowerShell on this host' : false }, () => {
    it(
        'refuses a platform other than Windows x64',
        { skip: process.platform === 'win32' && process.arch === 'x64' },
        () => {
            const context = powershellFixture();
            try {
                const result = context.run(context.script, ['-Archive', context.archive]);
                assert.equal(result.status, 1);
                assert.match(result.stderr, /unsupported platform: .*install\.ps1 installs win32-x64/u);
                assert.equal(existsSync(context.programs), false);
            } finally {
                rmSync(context.directory, { recursive: true, force: true });
            }
        },
    );

    it('installs a local archive after its digest check and refuses another or a partial one', () => {
        const context = powershellFixture();
        try {
            const bytes = readFileSync(context.archive);
            const swapped = join(context.directory, 'swapped.zip');
            const swappedBytes = Buffer.from(bytes);
            swappedBytes[swappedBytes.length - 1] ^= 1;
            writeFileSync(swapped, swappedBytes);
            let result = context.run(context.forced, ['-Archive', swapped]);
            assert.equal(result.status, 1);
            assert.match(
                result.stderr,
                /SHA-256 is not the one erden-1\.0\.0-win32-x64\.zip was released with; nothing was installed/u,
            );
            const partial = join(context.directory, 'partial.zip');
            writeFileSync(partial, bytes.subarray(0, 100));
            result = context.run(context.forced, ['-Archive', partial]);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /is 100 bytes, not the \d+ bytes of erden-1\.0\.0-win32-x64\.zip/u);
            assert.deepEqual(existsSync(context.programs) ? readdirSync(context.programs) : [], []);
            result = context.run(context.forced, ['-Archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /Installed Erden 1\.0\.0 to /u);
            assert.ok(existsSync(join(context.programs, VERSION, 'bin', 'erden.cmd')));
            assert.ok(existsSync(join(context.programs, VERSION, 'bin', 'den.cmd')));
            assert.deepEqual(readdirSync(context.programs).sort(), [VERSION, 'bin']);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('adds its bin folder to the user PATH once, keeps the other entries as stored, and -Uninstall removes it', () => {
        const context = powershellFixture();
        try {
            const bin = join(context.programs, 'bin');
            writeFileSync(context.userPath, '%USERPROFILE%\\tools;C:\\Other');
            let result = context.run(context.forced, ['-Archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            assert.match(result.stdout, /Added .* to your user PATH/u);
            assert.equal(readFileSync(context.userPath, 'utf8'), `${bin};%USERPROFILE%\\tools;C:\\Other`);
            const launcher = readFileSync(join(bin, 'erden.cmd'), 'utf8');
            assert.match(launcher, /^@echo off\r\n/u);
            assert.ok(launcher.includes(`"%~dp0..\\${VERSION}\\bin\\erden.cmd" %*\r\n`), launcher);
            assert.ok(existsSync(join(bin, 'den.cmd')));
            if (process.platform === 'win32') {
                for (const name of ['erden', 'den']) {
                    const shimmed = spawnSync(
                        process.env.ComSpec ?? 'cmd.exe',
                        ['/d', '/c', join(bin, `${name}.cmd`), 'help'],
                        {
                            encoding: 'utf8',
                        },
                    );
                    assert.equal(shimmed.stdout.trim(), 'installed-erden help', `${name}.cmd in the bin folder`);
                }
            }

            result = context.run(context.forced, ['-Archive', context.archive]);
            assert.equal(result.status, 0, result.stderr);
            assert.doesNotMatch(result.stdout, /Added/u);
            // The second install replaced the launchers in place and left no temporary file.
            assert.deepEqual(readdirSync(bin).sort(), ['den.cmd', 'erden.cmd']);
            assert.equal(readFileSync(context.userPath, 'utf8'), `${bin};%USERPROFILE%\\tools;C:\\Other`);

            result = context.run(context.forced, ['-Uninstall']);
            assert.equal(result.status, 0, result.stderr);
            assert.equal(readFileSync(context.userPath, 'utf8'), '%USERPROFILE%\\tools;C:\\Other');
            assert.equal(existsSync(context.programs), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('leaves the user PATH alone with -NoModifyPath or ERDEN_NO_MODIFY_PATH=1', () => {
        const context = powershellFixture();
        try {
            writeFileSync(context.userPath, 'C:\\Other');
            for (const [args, extra] of [
                [['-NoModifyPath'], {}],
                [[], { ERDEN_NO_MODIFY_PATH: '1' }],
            ]) {
                const result = context.run(context.forced, ['-Archive', context.archive, ...args], extra);
                assert.equal(result.status, 0, result.stderr);
                assert.match(result.stdout, /to your PATH to run erden \(your PATH was left as it is\)/u);
                assert.equal(readFileSync(context.userPath, 'utf8'), 'C:\\Other');
            }
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('runs through Invoke-Expression without closing or changing the session, even when it fails', () => {
        const context = powershellFixture();
        try {
            const command = [
                "$ErrorActionPreference = 'Continue'",
                `Get-Content -Raw -LiteralPath '${context.forced.replaceAll("'", "''")}' | Invoke-Expression`,
                'Write-Output "session alive: $ErrorActionPreference $([bool](Get-Variable pinnedVersion -ErrorAction SilentlyContinue))"',
            ].join('; ');
            const result = context.session(command, { ERDEN_VERSION: 'bad;version' });
            assert.match(result.stderr, /erden install: not a version: bad;version/u);
            assert.match(result.stdout, /session alive: Continue False/u);
            assert.equal(existsSync(context.programs), false);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });

    it('refuses a version it cannot name before any request', () => {
        const context = powershellFixture();
        try {
            const result = context.run(context.forced, ['-Version', '1.0;x']);
            assert.equal(result.status, 1);
            assert.match(result.stderr, /not a version: 1\.0;x/u);
            const pinned = context.run(context.forced, ['-Version', '0.9.0', '-Archive', context.archive]);
            assert.match(pinned.stderr, /-Archive installs only 1\.0\.0/u);
        } finally {
            rmSync(context.directory, { recursive: true, force: true });
        }
    });
});

describe('install.ps1 and the Windows registry', { skip: process.platform !== 'win32' }, () => {
    it('reads and writes the user PATH as an expandable string and restores it', () => {
        const text = installScripts(powershellPins())['install.ps1'];
        const functions = text.slice(
            text.indexOf('    function Get-UserPath'),
            text.indexOf('    function Test-SamePath'),
        );
        const command = [
            functions,
            '$before = Get-UserPath',
            "$kind = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValueKind('Path')",
            'try {',
            "    Set-UserPath ($before + ';%USERPROFILE%\\erden-registry-test')",
            '    $after = Get-UserPath',
            "    $afterKind = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment').GetValueKind('Path')",
            '} finally {',
            "    $key = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey('Environment', $true)",
            "    $key.SetValue('Path', $before, $kind)",
            '    $key.Close()',
            '}',
            'Write-Output "$($after.EndsWith(\';%USERPROFILE%\\erden-registry-test\')) $afterKind $((Get-UserPath) -eq $before)"',
        ].join('\n');
        const result = spawnSync(POWERSHELL, ['-NoProfile', '-Command', command], { encoding: 'utf8' });
        assert.equal(result.status, 0, result.stderr);
        assert.equal(result.stdout.trim(), 'True ExpandString True');
    });
});

describe('install.ps1 on long Windows paths', () => {
    it('stages the archive under names short enough for the 260-character path limit', () => {
        const template = readFileSync(join(root, 'release', 'install.template.ps1'), 'utf8');
        const work =
            /\$work = Join-Path \$programs \('([^']+)' \+ \[Guid\]::NewGuid\(\)\.ToString\('N'\)\.Substring\(0, (\d+)\)\)/u.exec(
                template,
            );
        const extract = /\$extract = Join-Path \$work '([^']+)'/u.exec(template);
        assert.ok(work !== null && extract !== null, 'install.ps1 names its staging directories');
        // A 20-character user name, and a budget for the archive's deepest entry: today it is 134 characters,
        // erden-<version>-win32-x64/THIRD-PARTY-NOTICES/erden-reasoner/licenses/<sha256>.txt.
        const local = win32.join('C:\\Users', 'u'.repeat(20), 'AppData', 'Local');
        const deepestEntry = 150;
        const staging = win32.join(local, 'Programs', 'Erden', `${work[1]}${'0'.repeat(Number(work[2]))}`, extract[1]);
        assert.ok(staging.length + 1 + deepestEntry < 260, `${staging} leaves too little of the path limit`);
    });
});

describe('the install scripts and the pins', () => {
    it('carry the version and every archive digest and are refused when stale', () => {
        const { directory, pins } = fixture();
        try {
            const scripts = installScripts(pins);
            assert.match(
                scripts['install.sh'],
                new RegExp(`^linux_x64_sha256='${pins.archives['linux-x64'].sha256.slice(7)}'$`, 'mu'),
            );
            assert.match(scripts['install.ps1'], /^ {4}\$win32X64File = 'erden-1\.0\.0-win32-x64\.zip'$/mu);
            assert.doesNotMatch(`${scripts['install.sh']}${scripts['install.ps1']}`, /@@/u);
            const copy = join(directory, 'release');
            mkdirSync(copy);
            for (const name of ['install.template.sh', 'install.template.ps1']) {
                writeFileSync(join(copy, name), readFileSync(join(root, 'release', name)));
            }
            assert.deepEqual(installScriptDifferences(pins, copy), [
                'release/install.sh is missing',
                'release/install.ps1 is missing',
            ]);
            writeFileSync(join(copy, 'install.sh'), scripts['install.sh']);
            writeFileSync(
                join(copy, 'install.ps1'),
                scripts['install.ps1'].replace(/'[0-9a-f]{64}'/u, `'${'0'.repeat(64)}'`),
            );
            assert.deepEqual(installScriptDifferences(pins, copy), [
                'release/install.ps1 is not the one release/pins/1.0.0.json gives',
            ]);
        } finally {
            rmSync(directory, { recursive: true, force: true });
        }
    });

    it('committed install scripts are the ones their pins give', () => {
        const pinsDirectory = join(root, 'release', 'pins');
        const committed = existsSync(join(root, 'release', 'install.sh'));
        if (!existsSync(pinsDirectory)) {
            assert.equal(committed, false, 'install scripts are committed with no pins');
            return;
        }
        const version = readFileSync(join(root, 'release', 'install.sh'), 'utf8').match(/^version='([^']+)'$/mu)?.[1];
        const pins = JSON.parse(readFileSync(join(pinsDirectory, `${String(version)}.json`), 'utf8'));
        assert.deepEqual(installScriptDifferences(pins), []);
    });
});
