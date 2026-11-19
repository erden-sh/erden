// What this copy of the CLI is: its version and release channel, the User-Agent it sends, how it was installed, and
// where it keeps its per-user state. Telemetry, the update notice and `erden upgrade` all start from here.
import { readFileSync } from 'node:fs';
import { posix, win32 } from 'node:path';
import { isSea } from 'node:sea';
import { fileURLToPath } from 'node:url';

export type ReleaseChannel = 'stable' | 'canary';

/**
 * How this CLI was installed:
 * - `script`: by release/install.sh or install.ps1, to ~/.local/share/erden/<version> or
 *   %LOCALAPPDATA%\Programs\Erden\<version>; `erden upgrade` updates it.
 * - `homebrew`, `scoop`: by that package manager, which also updates it.
 * - `archive`: a release archive unpacked somewhere else by hand.
 * - `source`: not a release archive at all (a checkout, or a package built from one). Such a build sends no telemetry
 *   and never checks for updates.
 */
export type InstallMethod = 'script' | 'homebrew' | 'scoop' | 'archive' | 'source';

export interface Installation {
    readonly method: InstallMethod;
    /** The archive's root directory (holding bin/ and lib/); absent for `source`. */
    readonly root?: string;
}

export interface InstallationProbe {
    /**
     * This module's file: `<root>/lib/dist/installation.js` in a release archive (in its single executable, the path
     * the bundle gives this module).
     */
    readonly modulePath: string;
    /**
     * The executable running the CLI: in a release archive its single executable, `<root>/bin/erden` (`erden.exe` on
     * Windows), or in an archive from before the single executable, its Node.js, `<root>/node/node`.
     */
    readonly execPath: string;
    /** Whether this is a Node.js single executable application. */
    readonly sea?: boolean;
    readonly platform: NodeJS.Platform;
    readonly environment: Readonly<Record<string, string | undefined>>;
    readonly version: string;
}

const VERSION = /^\d+\.\d+\.\d+(?:-rc\.\d+)?$/u;

export function cliVersion(): string {
    return (JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string })
        .version;
}

/** A canary build's version is a release candidate, v<x.y.z>-rc.<n>; every other release is stable. */
export function releaseChannel(version: string): ReleaseChannel {
    return /-rc\.\d+$/u.test(version) ? 'canary' : 'stable';
}

/** The User-Agent of every request the CLI makes: the software, its version, OS and CPU architecture, and nothing else. */
export function cliUserAgent(
    version: string,
    platform: string = process.platform,
    arch: string = process.arch,
): string {
    return `erden/${VERSION.test(version) ? version : '0.0.0'} (${platform}; ${arch})`;
}

function same(left: string, right: string, platform: NodeJS.Platform): boolean {
    return platform === 'win32' || platform === 'darwin' ? left.toLowerCase() === right.toLowerCase() : left === right;
}

function segments(path: string): string[] {
    return path.split(/[\\/]+/u).map((segment) => segment.toLowerCase());
}

export function describeInstallation(probe: InstallationProbe): Installation {
    const windows = probe.platform === 'win32';
    const path = windows ? win32 : posix;
    const root = path.resolve(path.dirname(probe.modulePath), '..', '..');
    const executable =
        probe.sea === true
            ? path.join(root, 'bin', windows ? 'erden.exe' : 'erden')
            : path.join(root, 'node', windows ? 'node.exe' : 'node');
    if (
        !same(path.resolve(probe.execPath), executable, probe.platform) ||
        !same(path.basename(path.dirname(probe.modulePath)), 'dist', probe.platform)
    ) {
        return { method: 'source' };
    }
    const parts = segments(root);
    if (parts.includes('cellar') || parts.includes('homebrew') || parts.includes('.linuxbrew')) {
        return { method: 'homebrew', root };
    }
    const scoop = probe.environment.SCOOP;
    if (
        windows &&
        (parts.join('/').includes('/scoop/apps/') ||
            (scoop !== undefined &&
                path.isAbsolute(scoop) &&
                root.toLowerCase().startsWith(`${path.resolve(scoop).toLowerCase()}${path.sep}`)))
    ) {
        return { method: 'scoop', root };
    }
    const home = windows ? probe.environment.LOCALAPPDATA : probe.environment.HOME;
    if (home !== undefined && path.isAbsolute(home) && same(path.basename(root), probe.version, probe.platform)) {
        const parent = windows ? path.join(home, 'Programs', 'Erden') : path.join(home, '.local', 'share', 'erden');
        if (same(path.dirname(root), path.resolve(parent), probe.platform)) {
            return { method: 'script', root };
        }
    }
    return { method: 'archive', root };
}

export function nodeInstallation(version: string): Installation {
    return describeInstallation({
        modulePath: fileURLToPath(import.meta.url),
        execPath: process.execPath,
        sea: isSea(),
        platform: process.platform,
        environment: process.env,
        version,
    });
}

/**
 * The directory of the CLI's per-user state (telemetry.json, update-check.json): the same base the registry credentials
 * use, $XDG_CONFIG_HOME/erden or ~/.config/erden, and %LOCALAPPDATA%\Erden on Windows. Undefined when the environment
 * names none.
 */
export function stateDirectory(
    environment: Readonly<Record<string, string | undefined>>,
    platform: NodeJS.Platform,
): string | undefined {
    const path = platform === 'win32' ? win32 : posix;
    const base =
        platform === 'win32'
            ? environment.LOCALAPPDATA
            : (environment.XDG_CONFIG_HOME ??
              (environment.HOME === undefined ? undefined : path.join(environment.HOME, '.config')));
    if (base === undefined || !path.isAbsolute(base)) {
        return undefined;
    }
    return path.join(base, platform === 'win32' ? 'Erden' : 'erden');
}
