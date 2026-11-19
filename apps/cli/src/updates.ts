// The release endpoint (the erden-releases Worker on erden.sh) and the once-a-day update notice. The check itself runs
// in the detached background process (background.ts), so a command never waits for it; the next run prints the notice
// from what the check stored. The notice is one line on stderr, only when stdout and stderr are both terminals and no
// CI service is detected, and never when ERDEN_NO_UPDATE_NOTIFIER, NO_UPDATE_NOTIFIER or DO_NOT_TRACK is set.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import type { InstallMethod, ReleaseChannel } from './installation.js';
import { inCi, optOutSet, writeStateFile, type Environment } from './telemetry.js';

export const RELEASES_ORIGIN = 'https://erden.sh';
export const UPDATE_CHECK_FILE = 'update-check.json';
export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/u;

/** What the release endpoint answers for a channel. */
export interface ChannelRelease {
    readonly version: string;
    readonly tag: string;
}

/** The last update check, in <state directory>/update-check.json. */
export interface UpdateCheck {
    readonly schema: 'erden.update-check/v1';
    readonly checkedAt: number;
    readonly channel: ReleaseChannel;
    /** The channel's latest version as of checkedAt, or null when the check failed or found none. */
    readonly latest: string | null;
}

export function isReleaseVersion(value: unknown): value is string {
    return typeof value === 'string' && VERSION.test(value);
}

/** Orders release versions; a stable release sorts above its own release candidates. */
export function compareVersions(left: string, right: string): number {
    function key(version: string): number[] {
        const match = VERSION.exec(version);
        if (match === null) {
            throw new Error(`not a release version: ${version}`);
        }
        return [
            Number(match[1]),
            Number(match[2]),
            Number(match[3]),
            match[4] === undefined ? Number.MAX_SAFE_INTEGER : Number(match[4]),
        ];
    }
    const a = key(left);
    const b = key(right);
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) {
            return (a[index] as number) - (b[index] as number);
        }
    }
    return 0;
}

/** The release endpoint's origin; ERDEN_RELEASES_ORIGIN replaces it for testing against a local Worker. */
export function releasesOrigin(environment: Environment): string {
    const configured = environment.ERDEN_RELEASES_ORIGIN;
    if (configured !== undefined && /^https?:\/\/[^/?#]+$/u.test(configured)) {
        return configured;
    }
    return RELEASES_ORIGIN;
}

export function updateEndpoint(
    origin: string,
    channel: ReleaseChannel,
    platform: string,
    arch: string,
    version: string,
) {
    return `${origin}/updates/${channel}/${platform}/${arch}/${version}`;
}

/** The channel's latest release from the endpoint; throws on any failure. */
export async function fetchChannelRelease(
    url: string,
    userAgent: string,
    fetchImplementation: typeof fetch,
    timeoutMs: number,
    extraHeaders: Readonly<Record<string, string>> = {},
): Promise<ChannelRelease> {
    const response = await fetchImplementation(url, {
        headers: { accept: 'application/json', 'user-agent': userAgent, ...extraHeaders },
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
    });
    if (!response.ok) {
        throw new Error(`the release endpoint answered ${String(response.status)}`);
    }
    const text = await response.text();
    if (text.length > 4096) {
        throw new Error('the release endpoint answered too much');
    }
    const body = JSON.parse(text) as { schema?: unknown; version?: unknown; tag?: unknown };
    if (body.schema !== 'erden.cli-release/v1' || !isReleaseVersion(body.version) || body.tag !== `v${body.version}`) {
        throw new Error('the release endpoint answered something else');
    }
    return { version: body.version, tag: body.tag };
}

export function updateCheckPath(directory: string): string {
    return join(directory, UPDATE_CHECK_FILE);
}

export function readUpdateCheck(path: string): UpdateCheck | null {
    try {
        const value = JSON.parse(readFileSync(path, 'utf8')) as Partial<UpdateCheck>;
        if (
            value.schema === 'erden.update-check/v1' &&
            typeof value.checkedAt === 'number' &&
            Number.isSafeInteger(value.checkedAt) &&
            (value.channel === 'stable' || value.channel === 'canary') &&
            (value.latest === null || isReleaseVersion(value.latest))
        ) {
            return {
                schema: value.schema,
                checkedAt: value.checkedAt,
                channel: value.channel,
                latest: value.latest,
            };
        }
        return null;
    } catch {
        return null;
    }
}

export function writeUpdateCheck(path: string, check: UpdateCheck): void {
    writeStateFile(path, check);
}

/** Whether the update notice may run at all this time. */
export function updateNoticeAllowed(environment: Environment, stdoutIsTty: boolean, stderrIsTty: boolean): boolean {
    return (
        stdoutIsTty &&
        stderrIsTty &&
        !inCi(environment) &&
        !optOutSet(environment.ERDEN_NO_UPDATE_NOTIFIER) &&
        !optOutSet(environment.NO_UPDATE_NOTIFIER) &&
        !optOutSet(environment.DO_NOT_TRACK)
    );
}

/** How to update an install made by `method`. */
export function upgradeHint(method: InstallMethod): string {
    switch (method) {
        case 'homebrew':
            return 'brew upgrade erden';
        case 'scoop':
            return 'scoop update erden';
        case 'script':
            return 'erden upgrade';
        default:
            return 'see https://github.com/erden-sh/erden/releases';
    }
}

/** The one-line notice, or null when the stored check found nothing newer on this build's channel. */
export function updateNotice(
    check: UpdateCheck | null,
    current: string,
    channel: ReleaseChannel,
    method: InstallMethod,
): string | null {
    if (
        check === null ||
        check.channel !== channel ||
        check.latest === null ||
        !isReleaseVersion(current) ||
        compareVersions(check.latest, current) <= 0
    ) {
        return null;
    }
    return `Erden ${check.latest} is available (you have ${current}). Update: ${upgradeHint(method)}. Hide this: ERDEN_NO_UPDATE_NOTIFIER=1\n`;
}
