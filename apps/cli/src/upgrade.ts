// `erden upgrade`: replaces an install made by the release install scripts with the latest release of a channel.
// (`erden update` updates a project's dependencies; this updates the CLI itself, like `brew upgrade` or `deno upgrade`.)
//
// The release endpoint on erden.sh only names the channel's latest version. Everything installed comes from the GitHub
// release itself: its SHA256SUMS, its install script for this OS and its archive for this platform, downloaded from
// github.com/erden-sh/erden/releases/download/<tag>/ and refused unless every response finally came from GitHub's own
// hosts and both files have the SHA-256 SHA256SUMS lists. Then it runs that release's own install script offline on
// the archive (`install.sh --archive`, `install.ps1 -Archive`), which checks the archive again against the digest it
// carries and installs it exactly as a fresh install would. Installs made by Homebrew or Scoop are refused with the
// command that updates them; so is an archive unpacked by hand or a build from source.
//
// On Windows the CLI runs from %LOCALAPPDATA%\Programs\Erden\<version>\bin unless install.ps1 keeps the version-free
// shim directory %LOCALAPPDATA%\Programs\Erden\bin; when that shim is there the new version runs at once, and when it is
// not the success message says exactly which PATH entry to change, and that the old version must stay until then.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { releaseChannel, type Installation, type ReleaseChannel } from './installation.js';
import type { Environment } from './telemetry.js';
import {
    compareVersions,
    fetchChannelRelease,
    releasesOrigin,
    updateEndpoint,
    upgradeHint,
    type ChannelRelease,
} from './updates.js';

export const RELEASE_DOWNLOAD_BASE = 'https://github.com/erden-sh/erden/releases/download';
/** The hosts a release asset may finally come from: GitHub, and the storage hosts its downloads redirect to. */
export const RELEASE_DOWNLOAD_HOSTS = Object.freeze([
    'github.com',
    'objects.githubusercontent.com',
    'release-assets.githubusercontent.com',
]);
const PLATFORMS: Readonly<Record<string, string>> = Object.freeze({
    'linux-x64': 'tar.gz',
    'linux-arm64': 'tar.gz',
    'darwin-arm64': 'tar.gz',
    'win32-x64': 'zip',
});
const MAXIMUM_ARCHIVE_BYTES = 512 * 1024 * 1024;
const MAXIMUM_TEXT_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 15_000;
const DOWNLOAD_IDLE_MS = 60_000;
const INSTALLER_TIMEOUT_MS = 300_000;

export interface UpgradeOptions {
    /** The channel to follow; by default this build's own. */
    readonly channel?: ReleaseChannel;
    /** Only report whether a newer release exists. */
    readonly check: boolean;
}

export interface CliUpgradeRuntime {
    readonly version: string;
    readonly platform: string;
    readonly arch: string;
    readonly userAgent: string;
    readonly installation: Installation;
    readonly environment: Environment;
    /** Whether telemetry is on; when it is off the release endpoint is asked at an address it does not count. */
    readonly telemetryEnabled: () => boolean;
    readonly fetch: typeof fetch;
    readonly pathExists: (path: string) => boolean;
    /** A new empty directory for the downloads; removed afterwards. */
    readonly temporaryDirectory: () => string;
    /** Runs a release's install script on a downloaded archive, in `directory`; returns its exit status and output. */
    readonly runInstaller: (
        script: string,
        archive: string,
        directory: string,
    ) => { readonly status: number | null; readonly stdout: string; readonly stderr: string };
}

export interface UpgradeOutput {
    readonly stdout: (text: string) => void;
    readonly stderr: (text: string) => void;
}

/** Why an upgrade stopped; `code` is printed in brackets like every other CLI error. */
export class UpgradeError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly exit: 1 | 3 = 3,
    ) {
        super(message);
        this.name = 'UpgradeError';
    }
}

/** The SHA-256 SHA256SUMS lists for each file name. */
export function parseSha256Sums(text: string): ReadonlyMap<string, string> {
    const sums = new Map<string, string>();
    for (const line of text.split('\n')) {
        const match = /^([0-9a-f]{64}) [ *]([A-Za-z0-9._-]+)$/u.exec(line.trimEnd());
        if (match !== null) {
            sums.set(match[2] as string, match[1] as string);
        }
    }
    return sums;
}

function refusal(installation: Installation): UpgradeError | null {
    switch (installation.method) {
        case 'script':
            return null;
        case 'homebrew':
        case 'scoop':
            return new UpgradeError(
                'UPGRADE_MANAGED_INSTALL',
                `This Erden was installed with ${installation.method === 'homebrew' ? 'Homebrew' : 'Scoop'}; update it with \`${upgradeHint(installation.method)}\``,
                1,
            );
        case 'archive':
            return new UpgradeError(
                'UPGRADE_UNKNOWN_INSTALL',
                'This Erden was not installed by the Erden install script, so erden upgrade cannot replace it; install the new release with the script from https://erden.sh/install (Windows: https://erden.sh/install.ps1)',
                1,
            );
        case 'source':
            return new UpgradeError(
                'UPGRADE_SOURCE_BUILD',
                'This Erden runs from a source checkout or a package built from one; update the checkout instead',
                1,
            );
    }
}

/** Whether a download's final address is on one of GitHub's release hosts, over https. */
export function fromReleaseHost(finalUrl: string): boolean {
    try {
        const url = new URL(finalUrl);
        return url.protocol === 'https:' && RELEASE_DOWNLOAD_HOSTS.includes(url.hostname);
    } catch {
        return false;
    }
}

async function download(
    runtime: CliUpgradeRuntime,
    url: string,
    destination: string,
    maximumBytes: number,
): Promise<string> {
    const controller = new AbortController();
    let timer = setTimeout(() => {
        controller.abort();
    }, REQUEST_TIMEOUT_MS);
    try {
        const response = await runtime.fetch(url, {
            headers: { 'user-agent': runtime.userAgent },
            signal: controller.signal,
        });
        if (!fromReleaseHost(response.url)) {
            await response.body?.cancel();
            throw new UpgradeError('UPGRADE_DOWNLOAD_FAILED', `${url} was not served by GitHub's release hosts`);
        }
        if (!response.ok || response.body === null) {
            await response.body?.cancel();
            throw new UpgradeError(
                'UPGRADE_DOWNLOAD_FAILED',
                `Downloading ${url} failed (HTTP ${String(response.status)})`,
            );
        }
        const declared = Number(response.headers.get('content-length') ?? '0');
        if (declared > maximumBytes) {
            await response.body.cancel();
            throw new UpgradeError('UPGRADE_DOWNLOAD_FAILED', `${url} is larger than expected`);
        }
        const hash = createHash('sha256');
        let received = 0;
        const meter = new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                received += chunk.byteLength;
                clearTimeout(timer);
                timer = setTimeout(() => {
                    controller.abort();
                }, DOWNLOAD_IDLE_MS);
                if (received > maximumBytes) {
                    callback(new UpgradeError('UPGRADE_DOWNLOAD_FAILED', `${url} is larger than expected`));
                    return;
                }
                hash.update(chunk);
                callback(null, chunk);
            },
        });
        await pipeline(
            Readable.fromWeb(response.body as import('node:stream/web').ReadableStream<Uint8Array>),
            meter,
            createWriteStream(destination, { mode: 0o600 }),
        );
        return hash.digest('hex');
    } catch (cause) {
        if (cause instanceof UpgradeError) {
            throw cause;
        }
        throw new UpgradeError('UPGRADE_DOWNLOAD_FAILED', `Downloading ${url} failed`);
    } finally {
        clearTimeout(timer);
    }
}

/** The channel's latest version, from the release endpoint. */
async function latestRelease(runtime: CliUpgradeRuntime, channel: ReleaseChannel): Promise<ChannelRelease> {
    try {
        return await fetchChannelRelease(
            updateEndpoint(
                releasesOrigin(runtime.environment),
                channel,
                runtime.telemetryEnabled()
                    ? { platform: runtime.platform, arch: runtime.arch, version: runtime.version }
                    : null,
            ),
            runtime.userAgent,
            runtime.fetch,
            REQUEST_TIMEOUT_MS,
        );
    } catch {
        throw new UpgradeError(
            'UPGRADE_RELEASE_UNAVAILABLE',
            `Could not find the latest ${channel} release; try again later, or install with the script from https://erden.sh/install`,
        );
    }
}

/** What to tell the user after the new version is installed: where it runs from, and what to do with the old one. */
export function installedMessage(runtime: CliUpgradeRuntime, current: string, latest: string): string {
    const root = runtime.installation.root;
    if (runtime.platform !== 'win32' || root === undefined) {
        return `Upgraded Erden from ${current} to ${latest}. ${current} stays in ${root ?? 'its directory'}; remove it to free the space.\n`;
    }
    const programs = win32.dirname(root);
    const shim = win32.join(programs, 'bin');
    if (runtime.pathExists(win32.join(shim, 'erden.cmd'))) {
        return `Upgraded Erden from ${current} to ${latest}; erden in ${shim} now runs ${latest}. ${current} stays in ${root}; remove it, once no erden from it is running, to free the space.\n`;
    }
    const oldBin = win32.join(root, 'bin');
    const newBin = win32.join(programs, latest, 'bin');
    return [
        `Installed Erden ${latest} in ${win32.join(programs, latest)}, but your PATH still runs ${current} from ${oldBin}.`,
        `Replace ${oldBin} with ${newBin} in your user PATH, for example in PowerShell:`,
        `  [Environment]::SetEnvironmentVariable('Path', [Environment]::GetEnvironmentVariable('Path', 'User').Replace('${oldBin}', '${newBin}'), 'User')`,
        `then open a new terminal. Keep ${root} until then: erden runs from it.`,
        '',
    ].join('\n');
}

export async function runUpgrade(
    options: UpgradeOptions,
    runtime: CliUpgradeRuntime,
    output: UpgradeOutput,
): Promise<number> {
    const current = runtime.version;
    const currentChannel = releaseChannel(current);
    const channel = options.channel ?? currentChannel;
    const refused = refusal(runtime.installation);
    if (refused !== null && !options.check) {
        throw refused;
    }
    const platform = `${runtime.platform}-${runtime.arch}`;
    const extension = PLATFORMS[platform];
    if (extension === undefined) {
        throw new UpgradeError('UPGRADE_UNSUPPORTED_PLATFORM', `Erden has no release for ${platform}`, 1);
    }
    const latest = await latestRelease(runtime, channel);
    const newer = compareVersions(latest.version, current) > 0;
    const switching = channel !== currentChannel && latest.version !== current;
    if (!newer && !switching) {
        output.stdout(`Erden ${current} is the latest ${channel} release\n`);
        return 0;
    }
    if (options.check) {
        output.stdout(
            `Erden ${latest.version} is available on the ${channel} channel (you have ${current})${refused === null ? '; run erden upgrade' : `; ${upgradeHint(runtime.installation.method)}`}\n`,
        );
        return 0;
    }
    const script = runtime.platform === 'win32' ? 'install.ps1' : 'install.sh';
    const archive = `erden-${latest.version}-${platform}.${extension}`;
    const directory = runtime.temporaryDirectory();
    try {
        output.stderr(`Downloading Erden ${latest.version} (${channel}) for ${platform}\n`);
        const base = `${RELEASE_DOWNLOAD_BASE}/${latest.tag}`;
        await download(runtime, `${base}/SHA256SUMS`, join(directory, 'SHA256SUMS'), MAXIMUM_TEXT_BYTES);
        const sums = parseSha256Sums(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'));
        for (const name of [script, archive]) {
            const expected = sums.get(name);
            if (expected === undefined) {
                throw new UpgradeError('UPGRADE_DIGEST_MISMATCH', `${latest.tag}'s SHA256SUMS does not list ${name}`);
            }
            const actual = await download(
                runtime,
                `${base}/${name}`,
                join(directory, name),
                name === archive ? MAXIMUM_ARCHIVE_BYTES : MAXIMUM_TEXT_BYTES,
            );
            if (actual !== expected) {
                throw new UpgradeError(
                    'UPGRADE_DIGEST_MISMATCH',
                    `${name} does not have the SHA-256 ${latest.tag}'s SHA256SUMS lists; nothing was installed`,
                );
            }
        }
        output.stderr(`Checked ${script} and ${archive} against SHA256SUMS\n`);
        const installed = runtime.runInstaller(join(directory, script), join(directory, archive), directory);
        if (installed.stderr !== '') {
            output.stderr(installed.stderr);
        }
        if (installed.status !== 0) {
            throw new UpgradeError('UPGRADE_INSTALL_FAILED', `The ${latest.tag} install script failed`);
        }
        output.stdout(installed.stdout);
        output.stdout(installedMessage(runtime, current, latest.version));
        return 0;
    } finally {
        rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
    }
}

export function nodeTemporaryDirectory(): string {
    return mkdtempSync(join(tmpdir(), 'erden-upgrade-'));
}

export function nodePathExists(path: string): boolean {
    return existsSync(path);
}

/** Windows PowerShell by its absolute path, so no `powershell.exe` earlier on the PATH or in the directory can run. */
export function windowsPowerShell(environment: Environment): string {
    const root = environment.SystemRoot ?? environment.SYSTEMROOT ?? 'C:\\Windows';
    return win32.join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Runs install.sh with sh, or install.ps1 with Windows PowerShell, offline on the archive, in `directory`. */
export function nodeRunInstaller(script: string, archive: string, directory: string) {
    const options = {
        cwd: directory,
        encoding: 'utf8' as const,
        maxBuffer: 1 << 24,
        timeout: INSTALLER_TIMEOUT_MS,
        windowsHide: true,
    };
    const child =
        process.platform === 'win32'
            ? spawnSync(
                  windowsPowerShell(process.env),
                  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Archive', archive],
                  options,
              )
            : spawnSync('sh', [script, '--archive', archive], options);
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
}
