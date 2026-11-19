import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { cleanupTestTempRoot, makeTestTempRoot } from '../../../scripts/lib/test-temp-root.mjs';
import type { Installation } from '../src/installation.js';
import { CLI_EXIT, runCli, type CliRuntime } from '../src/main.js';
import {
    fromReleaseHost,
    nodeLibc,
    parseSha256Sums,
    windowsPowerShell,
    type CliUpgradeRuntime,
} from '../src/upgrade.js';

const roots: string[] = [];
function tempRoot(): string {
    const root = makeTestTempRoot('erden-cli-upgrade-');
    roots.push(root);
    return root;
}

afterEach(() => {
    for (const root of roots.splice(0)) {
        cleanupTestTempRoot(root);
    }
});

function hex(bytes: string | Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

interface Release {
    readonly version: string;
    readonly files: Record<string, string>;
    readonly sums?: string;
}

function release(version: string, tamper?: string): Release {
    const files: Record<string, string> = {
        'install.sh': `#!/bin/sh\necho installed ${version}\n`,
        'install.ps1': `Write-Output 'installed ${version}'\n`,
        [`erden-${version}-linux-x64.tar.gz`]: `archive ${version} linux-x64`,
        [`erden-${version}-linux-x64-musl.tar.gz`]: `archive ${version} linux-x64-musl`,
        [`erden-${version}-win32-x64.zip`]: `archive ${version} win32-x64`,
    };
    const sums = Object.entries(files)
        .map(([name, text]) => `${hex(text)}  ${name}`)
        .join('\n');
    if (tamper !== undefined) {
        files[tamper] = `${files[tamper] as string} changed`;
    }
    return { version, files, sums: `${sums}\n` };
}

interface Harness {
    readonly runtime: CliRuntime;
    readonly requests: Array<{ url: string; userAgent: string | null }>;
    readonly installs: Array<{
        script: string;
        archive: string;
        directory: string;
        scriptText: string;
        archiveText: string;
    }>;
    readonly output: () => { stdout: string; stderr: string };
}

function harness(
    current: string,
    releases: Record<'stable' | 'canary', Release>,
    installation: Installation = { method: 'script', root: `/home/alice/.local/share/erden/${current}` },
    platform = 'linux',
    options: {
        readonly telemetry?: boolean;
        readonly existing?: ReadonlyArray<string>;
        readonly servedFrom?: string;
        readonly libc?: 'musl';
    } = {},
): Harness {
    let stdout = '';
    let stderr = '';
    const requests: Harness['requests'] = [];
    const installs: Harness['installs'] = [];
    const work = tempRoot();
    let counter = 0;
    const upgrade: CliUpgradeRuntime = {
        version: current,
        platform,
        arch: 'x64',
        libc: options.libc,
        userAgent: `erden/${current} (${platform}; x64)`,
        installation,
        environment: {},
        telemetryEnabled: () => options.telemetry ?? true,
        pathExists: (path) => (options.existing ?? []).includes(path),
        async fetch(input, init) {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            requests.push({ url, userAgent: new Headers(init?.headers).get('user-agent') });
            const update = /^https:\/\/erden\.sh\/updates\/(stable|canary)(?:\/[^/]+\/[^/]+\/[^/]+)?$/u.exec(url);
            if (update !== null) {
                const latest = releases[update[1] as 'stable' | 'canary'];
                return await Promise.resolve(
                    Response.json({
                        schema: 'erden.cli-release/v1',
                        version: latest.version,
                        tag: `v${latest.version}`,
                    }),
                );
            }
            const download = /^https:\/\/github\.com\/erden-sh\/erden\/releases\/download\/v([^/]+)\/(.+)$/u.exec(url);
            const found = Object.values(releases).find((candidate) => candidate.version === download?.[1]);
            const name = download?.[2] as string;
            const text = name === 'SHA256SUMS' ? found?.sums : found?.files[name];
            const response = text === undefined ? new Response('missing', { status: 404 }) : new Response(text);
            // GitHub redirects a release download to its asset storage; the final address is what is checked.
            Object.defineProperty(response, 'url', {
                value: `https://${options.servedFrom ?? 'release-assets.githubusercontent.com'}/assets/${name}`,
            });
            return await Promise.resolve(response);
        },
        temporaryDirectory() {
            counter += 1;
            const directory = join(work, `download-${String(counter)}`);
            mkdirSync(directory);
            return directory;
        },
        runInstaller(script, archive, directory) {
            installs.push({
                script,
                archive,
                directory,
                scriptText: readFileSync(script, 'utf8'),
                archiveText: readFileSync(archive, 'utf8'),
            });
            return { status: 0, stdout: 'Installed Erden\n', stderr: '' };
        },
    };
    const runtime = {
        cwd: () => '/',
        stdout: { write: (text: string) => (stdout += text) },
        stderr: { write: (text: string) => (stderr += text) },
        services: {} as CliRuntime['services'],
        upgrade,
    } as CliRuntime;
    return { runtime, requests, installs, output: () => ({ stdout, stderr }) };
}

const STABLE = release('0.2.0');
const CANARY = release('0.3.0-rc.1');

describe('erden upgrade', () => {
    it('installs the newer release with its own install script after checking both files against SHA256SUMS', async () => {
        const h = harness('0.1.0', { stable: STABLE, canary: CANARY });
        expect(await runCli(['upgrade'], h.runtime)).toBe(CLI_EXIT.success);
        expect(h.installs).toHaveLength(1);
        expect(h.installs[0]?.scriptText).toBe(STABLE.files['install.sh']);
        expect(h.installs[0]?.archiveText).toBe(STABLE.files['erden-0.2.0-linux-x64.tar.gz']);
        expect(h.installs[0]?.archive.endsWith('erden-0.2.0-linux-x64.tar.gz')).toBe(true);
        expect(h.installs[0]?.directory).toBe(dirname(h.installs[0]?.archive as string));
        expect(existsSync(h.installs[0]?.archive as string)).toBe(false);
        expect(h.output().stdout).toContain('Upgraded Erden from 0.1.0 to 0.2.0');
        expect(h.requests.map((request) => request.url)).toEqual([
            'https://erden.sh/updates/stable/linux/x64/0.1.0',
            'https://github.com/erden-sh/erden/releases/download/v0.2.0/SHA256SUMS',
            'https://github.com/erden-sh/erden/releases/download/v0.2.0/install.sh',
            'https://github.com/erden-sh/erden/releases/download/v0.2.0/erden-0.2.0-linux-x64.tar.gz',
        ]);
        expect(new Set(h.requests.map((request) => request.userAgent))).toEqual(new Set(['erden/0.1.0 (linux; x64)']));
    });

    it('installs the musl archive on a musl Linux such as Alpine', async () => {
        const h = harness('0.1.0', { stable: STABLE, canary: CANARY }, undefined, 'linux', { libc: 'musl' });
        expect(await runCli(['upgrade'], h.runtime)).toBe(CLI_EXIT.success);
        expect(h.installs).toHaveLength(1);
        expect(h.installs[0]?.archive.endsWith('erden-0.2.0-linux-x64-musl.tar.gz')).toBe(true);
        expect(h.installs[0]?.archiveText).toBe(STABLE.files['erden-0.2.0-linux-x64-musl.tar.gz']);
        expect(h.requests.map((request) => request.url).at(-1)).toBe(
            'https://github.com/erden-sh/erden/releases/download/v0.2.0/erden-0.2.0-linux-x64-musl.tar.gz',
        );
    });

    it('names this Linux C library as install.sh does', () => {
        const expected =
            process.platform === 'linux' &&
            typeof (process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } }).header
                ?.glibcVersionRuntime !== 'string'
                ? 'musl'
                : undefined;
        expect(nodeLibc()).toBe(expected);
    });

    it('follows the canary channel when asked, and uses install.ps1 on Windows', async () => {
        const root = 'C:\\Users\\alice\\AppData\\Local\\Programs\\Erden\\0.1.0';
        const h = harness('0.1.0', { stable: STABLE, canary: CANARY }, { method: 'script', root }, 'win32');
        expect(await runCli(['upgrade', '--channel', 'canary'], h.runtime)).toBe(CLI_EXIT.success);
        expect(h.installs[0]?.script.endsWith('install.ps1')).toBe(true);
        expect(h.installs[0]?.archive.endsWith('erden-0.3.0-rc.1-win32-x64.zip')).toBe(true);
        // No shim yet: the PATH change is spelled out, and the old version must stay.
        const message = h.output().stdout;
        expect(message).toContain(
            'Replace C:\\Users\\alice\\AppData\\Local\\Programs\\Erden\\0.1.0\\bin with C:\\Users\\alice\\AppData\\Local\\Programs\\Erden\\0.3.0-rc.1\\bin in your user PATH',
        );
        expect(message).toContain(`Keep ${root} until then`);
        expect(message).not.toContain('remove it');
        const shimmed = harness('0.1.0', { stable: STABLE, canary: CANARY }, { method: 'script', root }, 'win32', {
            existing: ['C:\\Users\\alice\\AppData\\Local\\Programs\\Erden\\bin\\erden.cmd'],
        });
        expect(await runCli(['upgrade'], shimmed.runtime)).toBe(CLI_EXIT.success);
        expect(shimmed.output().stdout).toContain(
            'erden in C:\\Users\\alice\\AppData\\Local\\Programs\\Erden\\bin now runs 0.2.0',
        );
    });

    it('asks the uncounted release address when telemetry is off, and refuses downloads from other hosts', async () => {
        const off = harness('0.1.0', { stable: STABLE, canary: CANARY }, undefined, 'linux', { telemetry: false });
        expect(await runCli(['upgrade', '--check'], off.runtime)).toBe(CLI_EXIT.success);
        expect(off.requests.map((request) => request.url)).toEqual(['https://erden.sh/updates/stable']);
        const foreign = harness('0.1.0', { stable: STABLE, canary: CANARY }, undefined, 'linux', {
            servedFrom: 'attacker.example',
        });
        expect(await runCli(['upgrade'], foreign.runtime)).toBe(CLI_EXIT.operational);
        expect(foreign.output().stderr).toContain("was not served by GitHub's release hosts [UPGRADE_DOWNLOAD_FAILED]");
        expect(foreign.installs).toEqual([]);
    });

    it('refuses files that differ from SHA256SUMS and installs nothing', async () => {
        for (const tampered of ['install.sh', 'erden-0.2.0-linux-x64.tar.gz']) {
            const h = harness('0.1.0', { stable: release('0.2.0', tampered), canary: CANARY });
            expect(await runCli(['upgrade'], h.runtime)).toBe(CLI_EXIT.operational);
            expect(h.output().stderr).toContain('[UPGRADE_DIGEST_MISMATCH]');
            expect(h.installs).toEqual([]);
        }
    });

    it('says when it is already current, and --check only reports', async () => {
        const current = harness('0.2.0', { stable: STABLE, canary: CANARY });
        expect(await runCli(['upgrade'], current.runtime)).toBe(CLI_EXIT.success);
        expect(current.output().stdout).toBe('Erden 0.2.0 is the latest stable release\n');
        const check = harness('0.1.0', { stable: STABLE, canary: CANARY });
        expect(await runCli(['upgrade', '--check'], check.runtime)).toBe(CLI_EXIT.success);
        expect(check.output().stdout).toContain('Erden 0.2.0 is available on the stable channel (you have 0.1.0)');
        expect(check.installs).toEqual([]);
        // A canary build stays on canary unless told otherwise.
        const canary = harness('0.3.0-rc.1', { stable: STABLE, canary: CANARY });
        expect(await runCli(['upgrade'], canary.runtime)).toBe(CLI_EXIT.success);
        expect(canary.output().stdout).toBe('Erden 0.3.0-rc.1 is the latest canary release\n');
        const back = harness('0.3.0-rc.1', { stable: STABLE, canary: CANARY });
        expect(await runCli(['upgrade', '--channel', 'stable'], back.runtime)).toBe(CLI_EXIT.success);
        expect(back.installs[0]?.archive.endsWith('erden-0.2.0-linux-x64.tar.gz')).toBe(true);
    });

    it('refuses Homebrew, Scoop, hand-unpacked and source installs with a pointer', async () => {
        const cases: Array<[Installation, string]> = [
            [{ method: 'homebrew', root: '/opt/homebrew/Cellar/erden/0.1.0' }, 'brew upgrade erden'],
            [{ method: 'scoop', root: 'C:\\scoop\\apps\\erden\\0.1.0' }, 'scoop update erden'],
            [{ method: 'archive', root: '/opt/erden' }, 'https://erden.sh/install'],
            [{ method: 'source' }, 'update the checkout'],
        ];
        for (const [installation, pointer] of cases) {
            const h = harness('0.1.0', { stable: STABLE, canary: CANARY }, installation);
            expect(await runCli(['upgrade'], h.runtime)).toBe(CLI_EXIT.semanticFailure);
            expect(h.output().stderr).toContain(pointer);
            expect(h.requests).toEqual([]);
        }
    });

    it('rejects unknown arguments', async () => {
        const h = harness('0.1.0', { stable: STABLE, canary: CANARY });
        expect(await runCli(['upgrade', '--channel', 'nightly'], h.runtime)).toBe(CLI_EXIT.usage);
        expect(await runCli(['upgrade', 'now'], h.runtime)).toBe(CLI_EXIT.usage);
        expect(await runCli(['upgrade', '--check', '--check'], h.runtime)).toBe(CLI_EXIT.usage);
    });

    it('runs Windows PowerShell by its absolute path and accepts only GitHub release hosts', () => {
        expect(windowsPowerShell({ SystemRoot: 'D:\\Win' })).toBe(
            'D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
        );
        expect(windowsPowerShell({})).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
        expect(fromReleaseHost('https://github.com/erden-sh/erden/releases/download/v0.1.0/SHA256SUMS')).toBe(true);
        expect(fromReleaseHost('https://objects.githubusercontent.com/x')).toBe(true);
        expect(fromReleaseHost('https://release-assets.githubusercontent.com/x')).toBe(true);
        for (const url of ['http://github.com/x', 'https://github.com.example/x', 'https://erden.sh/x', '']) {
            expect(fromReleaseHost(url), url).toBe(false);
        }
    });

    it('reads SHA256SUMS lines in both sha256sum formats', () => {
        const digest = 'a'.repeat(64);
        expect(parseSha256Sums(`${digest}  install.sh\n${digest} *erden-0.1.0-win32-x64.zip\r\nnoise\n`)).toEqual(
            new Map([
                ['install.sh', digest],
                ['erden-0.1.0-win32-x64.zip', digest],
            ]),
        );
    });
});
