// The Erden release Worker on erden.sh: the install entry point, download redirects and the CLI's update endpoint,
// modeled on PaceBar's update proxy. Every download is a redirect to the GitHub release asset, so the bytes always come
// from the release itself and the install scripts' and SHA256SUMS digests stay the trust anchor; the Worker only picks
// the release and counts the request in a per-day rollup with no identifier (schema.sql).
//
// Routes (all GET or HEAD; HEAD is answered but never counted):
//   /install, /install.ps1                 the latest stable release's install.sh / install.ps1
//   /install/<channel>, /install/<channel>.ps1
//                                           the same for stable or canary
//   /download/<ref>/<file>                 a release asset. <ref> is stable, canary or a tag (v0.1.0, v0.2.0-rc.1).
//                                           <file> is install.sh, install.ps1, SHA256SUMS, erden-<platform>.<ext> (the
//                                           ref's version) or the exact erden-<version>-<platform>.<ext>
//   /updates/<channel>/<os>/<arch>/<version>
//                                           the channel's latest release, for a CLI with telemetry on; counted
//   /updates/<channel>                      the same answer, never counted: for a CLI with telemetry off
//   /updates/report                         aggregate counts for the last 30 days; needs X-Report-Token (REPORT_TOKEN)
//
// The release index is the repository's published releases with a v<x.y.z> or v<x.y.z>-rc.<n> tag, from the GitHub API
// (GITHUB_TOKEN is required in production), cached at the edge for CACHE_SECONDS. Every good answer is also kept in D1
// (release_index) and served when GitHub fails. Stable is the highest v<x.y.z> release; canary is the highest of all,
// so a canary install never lags stable. Only versions in the index are counted as themselves; any other is counted
// as `other`. Requests with an X-Erden-CI header (Erden's own CI) are served but not counted.
import {
    coarseCountry,
    json,
    reportAllowed,
    utcDay,
    type D1Database,
    type EdgeCache,
    type WorkerContext,
} from '../../shared/http.js';

export interface Env {
    readonly DB: D1Database;
    /** `production` in the deployed Worker: the GitHub token is then required. */
    readonly ENVIRONMENT?: string;
    /** Secret; GET /updates/report is refused unless the request's X-Report-Token equals it. */
    readonly REPORT_TOKEN?: string;
    /** Secret, required in production: a fine-grained, read-only GitHub token (public repositories, no scopes). */
    readonly GITHUB_TOKEN?: string;
}

export interface Dependencies {
    readonly fetch: typeof fetch;
    readonly cache?: EdgeCache;
    readonly now: () => Date;
}

export const REPOSITORY = 'erden-sh/erden';
export const RETENTION_DAYS = 730;
const CACHE_SECONDS = 300;
const REPORT_WINDOW_DAYS = 30;
const USER_AGENT = 'erden-releases-worker/1';

export const CHANNELS = Object.freeze(['stable', 'canary'] as const);
export type Channel = (typeof CHANNELS)[number];
export const PLATFORMS = Object.freeze({
    'linux-x64': { os: 'linux', arch: 'x64', extension: 'tar.gz' },
    'linux-arm64': { os: 'linux', arch: 'arm64', extension: 'tar.gz' },
    'darwin-arm64': { os: 'darwin', arch: 'arm64', extension: 'tar.gz' },
    'win32-x64': { os: 'win32', arch: 'x64', extension: 'zip' },
} as const);
type Platform = keyof typeof PLATFORMS;
const OPERATING_SYSTEMS = Object.freeze(['linux', 'darwin', 'win32']);
const ARCHITECTURES = Object.freeze(['x64', 'arm64']);
const NUMBER = '(?:0|[1-9]\\d{0,5})';
const VERSION_TEXT = `${NUMBER}\\.${NUMBER}\\.${NUMBER}(?:-rc\\.${NUMBER})?`;
const VERSION = new RegExp(`^${VERSION_TEXT}$`, 'u');
const STABLE_TAG = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}$`, 'u');
const CANARY_TAG = new RegExp(`^v${NUMBER}\\.${NUMBER}\\.${NUMBER}-rc\\.${NUMBER}$`, 'u');
const ARCHIVE = new RegExp(
    `^erden-(?:(${VERSION_TEXT})-)?(linux-x64|linux-arm64|darwin-arm64|win32-x64)\\.(tar\\.gz|zip)$`,
    'u',
);
const CLI_USER_AGENT = new RegExp(`^erden/${VERSION_TEXT} \\((linux|darwin|win32); (x64|arm64)\\)$`, 'u');
/** What a version outside the release index is counted as. */
export const OTHER_VERSION = 'other';

/** The part of a release the Worker keeps. */
export interface ReleaseSummary {
    readonly tag: string;
    readonly version: string;
    readonly publishedAt: string;
    readonly assets: ReadonlyArray<string>;
}

interface GitHubRelease {
    readonly tag_name?: unknown;
    readonly draft?: unknown;
    readonly prerelease?: unknown;
    readonly published_at?: unknown;
    readonly assets?: ReadonlyArray<{ readonly name?: unknown }>;
}

/** The release's version as a comparable tuple; a stable release sorts above its own release candidates. */
export function versionKey(version: string): [number, number, number, number] {
    const match = /^(\d+)\.(\d+)\.(\d+)(?:-rc\.(\d+))?$/u.exec(version);
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

export function compareVersions(left: string, right: string): number {
    const a = versionKey(left);
    const b = versionKey(right);
    for (let index = 0; index < a.length; index += 1) {
        if (a[index] !== b[index]) {
            return (a[index] as number) - (b[index] as number);
        }
    }
    return 0;
}

function summary(release: GitHubRelease): ReleaseSummary | null {
    const tag = release.tag_name;
    if (typeof tag !== 'string' || release.draft === true) {
        return null;
    }
    const stable = STABLE_TAG.test(tag) && release.prerelease !== true;
    const canary = CANARY_TAG.test(tag) && release.prerelease === true;
    if (!stable && !canary) {
        return null;
    }
    return {
        tag,
        version: tag.slice(1),
        publishedAt: typeof release.published_at === 'string' ? release.published_at : '',
        assets: (release.assets ?? []).flatMap((asset) => (typeof asset.name === 'string' ? [asset.name] : [])),
    };
}

/** The published releases, from GitHub; throws when GitHub cannot answer, or when production has no token. */
export async function fetchReleaseIndex(env: Env, dependencies: Dependencies): Promise<ReleaseSummary[]> {
    if (env.ENVIRONMENT === 'production' && (env.GITHUB_TOKEN === undefined || env.GITHUB_TOKEN === '')) {
        throw new Error('GITHUB_TOKEN is required in production');
    }
    const response = await dependencies.fetch(`https://api.github.com/repos/${REPOSITORY}/releases?per_page=100`, {
        headers: {
            accept: 'application/vnd.github+json',
            'user-agent': USER_AGENT,
            'x-github-api-version': '2022-11-28',
            ...(env.GITHUB_TOKEN === undefined || env.GITHUB_TOKEN === ''
                ? {}
                : { authorization: `Bearer ${env.GITHUB_TOKEN}` }),
        },
    });
    if (!response.ok) {
        throw new Error(`GitHub answered ${String(response.status)}`);
    }
    const releases = (await response.json()) as unknown;
    if (!Array.isArray(releases)) {
        throw new Error('GitHub answered something other than a release list');
    }
    return (releases as GitHubRelease[]).flatMap((release) => {
        const kept = summary(release);
        return kept === null ? [] : [kept];
    });
}

async function lastKnownGood(db: D1Database): Promise<ReleaseSummary[] | null> {
    const row = await db.prepare('SELECT releases FROM release_index WHERE id = 1').first();
    return typeof row?.releases === 'string' ? (JSON.parse(row.releases) as ReleaseSummary[]) : null;
}

/** The release index: from the edge cache when fresh, else from GitHub, else the last good answer kept in D1. */
export async function releaseIndex(
    env: Env,
    context: WorkerContext,
    dependencies: Dependencies,
): Promise<ReleaseSummary[]> {
    const key = new Request('https://erden-releases.internal/release-index.json');
    const cached = await dependencies.cache?.match(key);
    if (cached !== undefined) {
        return (await cached.json()) as ReleaseSummary[];
    }
    let index: ReleaseSummary[];
    try {
        index = await fetchReleaseIndex(env, dependencies);
    } catch (cause) {
        const kept = await lastKnownGood(env.DB);
        if (kept === null) {
            throw cause;
        }
        return kept;
    }
    const text = JSON.stringify(index);
    if (dependencies.cache !== undefined) {
        context.waitUntil(
            dependencies.cache.put(
                key,
                new Response(text, {
                    headers: {
                        'content-type': 'application/json',
                        'cache-control': `max-age=${String(CACHE_SECONDS)}`,
                    },
                }),
            ),
        );
    }
    context.waitUntil(
        env.DB.prepare(
            `INSERT INTO release_index (id, fetched_at, releases) VALUES (1, ?1, ?2)
             ON CONFLICT (id) DO UPDATE SET fetched_at = ?1, releases = ?2`,
        )
            .bind(dependencies.now().toISOString(), text)
            .run()
            .catch(() => undefined),
    );
    return index;
}

/** The channel's release in the index, or null when the channel has none yet. */
export function channelRelease(index: ReadonlyArray<ReleaseSummary>, channel: Channel): ReleaseSummary | null {
    let best: ReleaseSummary | null = null;
    for (const release of index) {
        if (channel === 'stable' && !STABLE_TAG.test(release.tag)) {
            continue;
        }
        if (best === null || compareVersions(release.version, best.version) > 0) {
            best = release;
        }
    }
    return best;
}

/** The version as counted: itself when a published release has it, else `other`. */
export function countedVersion(index: ReadonlyArray<ReleaseSummary>, version: string): string {
    return index.some((release) => release.version === version) ? version : OTHER_VERSION;
}

function assetUrl(tag: string, file: string): string {
    return `https://github.com/${REPOSITORY}/releases/download/${tag}/${file}`;
}

function redirect(location: string): Response {
    return new Response(null, {
        status: 302,
        headers: { location, 'cache-control': 'no-store', 'referrer-policy': 'no-referrer' },
    });
}

/** Who is downloading, from the User-Agent's shape alone; the header itself is never stored. */
export function clientOf(request: Request): { client: 'cli' | 'script' | 'other'; os: string; arch: string } {
    const agent = request.headers.get('user-agent') ?? '';
    const cli = CLI_USER_AGENT.exec(agent);
    if (cli !== null) {
        return { client: 'cli', os: cli[1] as string, arch: cli[2] as string };
    }
    return { client: /^erden-install\/\d{1,3}$/u.test(agent) ? 'script' : 'other', os: '', arch: '' };
}

interface DownloadRecord {
    readonly channel: Channel | 'pinned';
    readonly version: string;
    readonly asset: 'archive' | 'install.sh' | 'install.ps1' | 'SHA256SUMS';
    readonly os: string;
    readonly arch: string;
}

function counted(request: Request): boolean {
    return request.method === 'GET' && !request.headers.has('x-erden-ci');
}

async function recordDownload(db: D1Database, request: Request, record: DownloadRecord, day: string): Promise<void> {
    const client = clientOf(request);
    await db
        .prepare(
            `INSERT INTO downloads (day, channel, version, asset, os, arch, client, country, hits)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1)
             ON CONFLICT (day, channel, version, asset, os, arch, client, country) DO UPDATE SET hits = hits + 1`,
        )
        .bind(
            day,
            record.channel,
            record.version,
            record.asset,
            record.os === '' ? client.os : record.os,
            record.arch === '' ? client.arch : record.arch,
            client.client,
            coarseCountry(request),
        )
        .run();
}

/** The asset a download path names, or null when it names none of a release's assets. */
export function parseAsset(
    file: string,
    version: string,
): { file: string; asset: DownloadRecord['asset']; os: string; arch: string } | null {
    if (file === 'install.sh' || file === 'install.ps1' || file === 'SHA256SUMS') {
        return { file, asset: file, os: '', arch: '' };
    }
    const match = ARCHIVE.exec(file);
    if (match === null) {
        return null;
    }
    const named = match[1];
    const platform = PLATFORMS[match[2] as Platform];
    if ((named !== undefined && named !== version) || platform.extension !== match[3]) {
        return null;
    }
    return {
        file: `erden-${version}-${match[2] as string}.${platform.extension}`,
        asset: 'archive',
        os: platform.os,
        arch: platform.arch,
    };
}

async function handleDownload(
    request: Request,
    ref: string,
    file: string,
    env: Env,
    context: WorkerContext,
    dependencies: Dependencies,
): Promise<Response> {
    let channel: Channel | 'pinned';
    let release: { tag: string; version: string; assets?: ReadonlyArray<string> };
    let countAs: string;
    if (ref === 'stable' || ref === 'canary') {
        const resolved = channelRelease(await releaseIndex(env, context, dependencies), ref);
        if (resolved === null) {
            return json({ error: `no ${ref} release yet` }, 404);
        }
        channel = ref;
        release = resolved;
        countAs = resolved.version;
    } else if (STABLE_TAG.test(ref) || CANARY_TAG.test(ref)) {
        // GitHub answers 404 for an asset an exact tag does not have; the index only decides how it is counted.
        channel = 'pinned';
        release = { tag: ref, version: ref.slice(1) };
        let index: ReadonlyArray<ReleaseSummary> = [];
        try {
            index = await releaseIndex(env, context, dependencies);
        } catch {
            index = [];
        }
        countAs = countedVersion(index, release.version);
    } else {
        return json({ error: 'not a channel or release tag' }, 404);
    }
    const asset = parseAsset(file, release.version);
    if (asset === null || (release.assets !== undefined && !release.assets.includes(asset.file))) {
        return json({ error: `no such asset in ${release.tag}` }, 404);
    }
    if (counted(request)) {
        context.waitUntil(
            recordDownload(
                env.DB,
                request,
                { channel, version: countAs, asset: asset.asset, os: asset.os, arch: asset.arch },
                utcDay(dependencies.now()),
            ).catch(() => undefined),
        );
    }
    return redirect(assetUrl(release.tag, asset.file));
}

async function handleUpdate(
    request: Request,
    segments: ReadonlyArray<string>,
    env: Env,
    context: WorkerContext,
    dependencies: Dependencies,
): Promise<Response> {
    const [channel, os, arch, version] = segments;
    const recorded = segments.length === 4;
    if (
        !CHANNELS.includes(channel as Channel) ||
        (recorded &&
            (!OPERATING_SYSTEMS.includes(os as string) ||
                !ARCHITECTURES.includes(arch as string) ||
                !VERSION.test(version as string)))
    ) {
        return json(
            { error: 'expected /updates/<stable|canary> or /updates/<stable|canary>/<os>/<arch>/<version>' },
            400,
        );
    }
    const index = await releaseIndex(env, context, dependencies);
    if (recorded && counted(request)) {
        context.waitUntil(
            env.DB.prepare(
                `INSERT INTO update_checks (day, channel, os, arch, version, country, hits)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 1)
                 ON CONFLICT (day, channel, os, arch, version, country) DO UPDATE SET hits = hits + 1`,
            )
                .bind(
                    utcDay(dependencies.now()),
                    channel as string,
                    os as string,
                    arch as string,
                    countedVersion(index, version as string),
                    coarseCountry(request),
                )
                .run()
                .catch(() => undefined),
        );
    }
    const release = channelRelease(index, channel as Channel);
    if (release === null) {
        return json({ error: `no ${channel as string} release yet` }, 404);
    }
    return json({
        schema: 'erden.cli-release/v1',
        channel,
        version: release.version,
        tag: release.tag,
        publishedAt: release.publishedAt,
        url: `https://github.com/${REPOSITORY}/releases/tag/${release.tag}`,
    });
}

async function handleReport(env: Env, dependencies: Dependencies): Promise<Response> {
    const since = utcDay(new Date(dependencies.now().getTime() - REPORT_WINDOW_DAYS * 86_400_000));
    // Table and column names come only from these fixed lists, never from the request.
    async function sumBy(table: 'downloads' | 'update_checks', column: string) {
        return (
            await env.DB.prepare(
                `SELECT ${column} AS key, SUM(hits) AS hits FROM ${table} WHERE day >= ?1
                 GROUP BY ${column} ORDER BY hits DESC`,
            )
                .bind(since)
                .all()
        ).results;
    }
    const downloads: Record<string, unknown> = {};
    for (const column of ['version', 'channel', 'asset', 'os', 'arch', 'client', 'country']) {
        downloads[column] = await sumBy('downloads', column);
    }
    const updateChecks: Record<string, unknown> = {};
    for (const column of ['version', 'channel', 'os', 'arch', 'country']) {
        updateChecks[column] = await sumBy('update_checks', column);
    }
    return json({ windowDays: REPORT_WINDOW_DAYS, downloads, updateChecks });
}

/** Deletes everything older than the retention period. */
export async function prune(db: D1Database, now: Date): Promise<void> {
    const cutoff = utcDay(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
    await db.batch([
        db.prepare('DELETE FROM downloads WHERE day < ?1').bind(cutoff),
        db.prepare('DELETE FROM update_checks WHERE day < ?1').bind(cutoff),
    ]);
}

export async function handle(
    request: Request,
    env: Env,
    context: WorkerContext,
    dependencies: Dependencies,
): Promise<Response> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        return json({ error: 'method not allowed' }, 405, { allow: 'GET, HEAD' });
    }
    const segments = new URL(request.url).pathname.split('/').slice(1);
    const [first, ...rest] = segments;
    if (first === 'install' || first === 'install.ps1') {
        const name = rest.length === 0 ? (first === 'install' ? 'stable' : 'stable.ps1') : rest.join('/');
        const match = /^(stable|canary)(\.ps1)?$/u.exec(name);
        if (match === null || (first === 'install.ps1' && rest.length > 0)) {
            return json({ error: 'not found' }, 404);
        }
        const script = first === 'install.ps1' || match[2] !== undefined ? 'install.ps1' : 'install.sh';
        return await handleDownload(request, match[1] as Channel, script, env, context, dependencies);
    }
    if (first === 'download' && rest.length === 2) {
        return await handleDownload(request, rest[0] as string, rest[1] as string, env, context, dependencies);
    }
    if (first === 'updates' && rest.length === 1 && rest[0] === 'report') {
        return reportAllowed(request, env.REPORT_TOKEN)
            ? await handleReport(env, dependencies)
            : json({ error: 'unauthorized' }, 401);
    }
    if (first === 'updates' && (rest.length === 1 || rest.length === 4)) {
        return await handleUpdate(request, rest, env, context, dependencies);
    }
    return json({ error: 'not found' }, 404);
}
