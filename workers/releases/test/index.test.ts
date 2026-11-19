import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { cliUserAgent } from '../../../apps/cli/src/installation.js';
import type { EdgeCache, WorkerContext } from '../../shared/http.js';
import { testD1, type TestD1 } from '../../shared/test-d1.js';
import {
    RETENTION_DAYS,
    clientOf,
    compareVersions,
    handle,
    parseAsset,
    prune,
    type Dependencies,
    type Env,
} from '../src/handler.js';

const SCHEMA = join(import.meta.dirname, '..', 'schema.sql');
const NOW = new Date('2026-11-19T12:00:00Z');
const TOKEN = 't'.repeat(40);

function assets(version: string): Array<{ name: string }> {
    return [
        `erden-${version}-darwin-arm64.tar.gz`,
        `erden-${version}-linux-arm64.tar.gz`,
        `erden-${version}-linux-x64.tar.gz`,
        `erden-${version}-win32-x64.zip`,
        'SHA256SUMS',
        'install.ps1',
        'install.sh',
    ].map((name) => ({ name }));
}

const STABLE = {
    tag_name: 'v0.1.0',
    draft: false,
    prerelease: false,
    published_at: '2026-11-10T00:00:00Z',
    assets: assets('0.1.0'),
};
const RELEASES = [
    {
        tag_name: 'v0.2.0-rc.2',
        draft: false,
        prerelease: true,
        published_at: '2026-11-18T00:00:00Z',
        assets: assets('0.2.0-rc.2'),
    },
    {
        tag_name: 'v0.2.0-rc.10',
        draft: false,
        prerelease: true,
        published_at: '2026-11-19T00:00:00Z',
        assets: assets('0.2.0-rc.10'),
    },
    { tag_name: 'v0.3.0-rc.1', draft: true, prerelease: true, assets: [] },
    { tag_name: 'v9.9.9-beta', draft: false, prerelease: true, assets: [] },
    STABLE,
];

interface Harness {
    readonly env: Env & { DB: TestD1 };
    readonly dependencies: Dependencies;
    readonly calls: string[];
    readonly pending: Array<Promise<unknown>>;
    readonly context: WorkerContext;
    readonly request: (path: string, init?: RequestInit, country?: string) => Promise<Response>;
}

function harness(releases: unknown[] = RELEASES, latest: unknown = STABLE): Harness {
    const calls: string[] = [];
    const pending: Array<Promise<unknown>> = [];
    const store = new Map<string, Response>();
    const cache: EdgeCache = {
        async match(request) {
            return await Promise.resolve(store.get(request.url)?.clone());
        },
        async put(request, response) {
            store.set(request.url, response);
            await Promise.resolve();
        },
    };
    const dependencies: Dependencies = {
        async fetch(input, init) {
            const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
            calls.push(url);
            expect(new Headers(init?.headers).get('user-agent')).toBe('erden-releases-worker/1');
            if (url.endsWith('/releases/latest')) {
                return await Promise.resolve(
                    latest === null ? new Response('', { status: 404 }) : Response.json(latest),
                );
            }
            return await Promise.resolve(Response.json(releases));
        },
        cache,
        now: () => NOW,
    };
    const env = { DB: testD1(SCHEMA), REPORT_TOKEN: TOKEN };
    const context: WorkerContext = { waitUntil: (promise) => pending.push(promise) };
    return {
        env,
        dependencies,
        calls,
        pending,
        context,
        async request(path, init = {}, country = 'BR') {
            const request = new Request(`https://erden.sh${path}`, init);
            Object.defineProperty(request, 'cf', { value: { country } });
            const response = await handle(request, env, context, dependencies);
            await Promise.all(pending.splice(0));
            return response;
        },
    };
}

describe('release Worker', () => {
    it('redirects the install entry points to the channel release install scripts', async () => {
        const h = harness();
        const cases: Array<[string, string]> = [
            ['/install', 'v0.1.0/install.sh'],
            ['/install.ps1', 'v0.1.0/install.ps1'],
            ['/install/stable', 'v0.1.0/install.sh'],
            ['/install/canary', 'v0.2.0-rc.10/install.sh'],
            ['/install/canary.ps1', 'v0.2.0-rc.10/install.ps1'],
        ];
        for (const [path, target] of cases) {
            const response = await h.request(path);
            expect(response.status).toBe(302);
            expect(response.headers.get('location')).toBe(
                `https://github.com/erden-sh/erden/releases/download/${target}`,
            );
        }
        for (const path of ['/install/nightly', '/install.ps1/canary', '/install/canary/x', '/installer']) {
            expect((await h.request(path)).status).toBe(404);
        }
        // One GitHub request per channel; the rest came from the edge cache.
        expect(h.calls).toEqual([
            'https://api.github.com/repos/erden-sh/erden/releases/latest',
            'https://api.github.com/repos/erden-sh/erden/releases?per_page=50',
        ]);
        expect(
            h.env.DB.rows('SELECT channel, version, asset, client, hits FROM downloads ORDER BY channel, asset'),
        ).toEqual([
            { channel: 'canary', version: '0.2.0-rc.10', asset: 'install.ps1', client: 'other', hits: 1 },
            { channel: 'canary', version: '0.2.0-rc.10', asset: 'install.sh', client: 'other', hits: 1 },
            { channel: 'stable', version: '0.1.0', asset: 'install.ps1', client: 'other', hits: 1 },
            { channel: 'stable', version: '0.1.0', asset: 'install.sh', client: 'other', hits: 2 },
        ]);
    });

    it('redirects downloads to the exact release asset and counts them without identifiers', async () => {
        const h = harness();
        const alias = await h.request('/download/stable/erden-linux-arm64.tar.gz', {
            headers: { 'user-agent': cliUserAgent('0.1.0', 'linux', 'arm64'), 'x-forwarded-for': '198.51.100.7' },
        });
        expect(alias.headers.get('location')).toBe(
            'https://github.com/erden-sh/erden/releases/download/v0.1.0/erden-0.1.0-linux-arm64.tar.gz',
        );
        const exact = await h.request('/download/v0.1.0/erden-0.1.0-win32-x64.zip', {
            headers: { 'user-agent': 'erden-install/1' },
        });
        expect(exact.headers.get('location')).toBe(
            'https://github.com/erden-sh/erden/releases/download/v0.1.0/erden-0.1.0-win32-x64.zip',
        );
        const sums = await h.request('/download/canary/SHA256SUMS', {
            headers: { 'user-agent': cliUserAgent('0.2.0-rc.2', 'darwin', 'arm64') },
        });
        expect(sums.headers.get('location')).toBe(
            'https://github.com/erden-sh/erden/releases/download/v0.2.0-rc.10/SHA256SUMS',
        );
        expect(h.env.DB.rows('SELECT * FROM downloads ORDER BY channel, version, asset')).toEqual([
            {
                day: '2026-11-19',
                channel: 'canary',
                version: '0.2.0-rc.10',
                asset: 'SHA256SUMS',
                os: 'darwin',
                arch: 'arm64',
                client: 'cli',
                country: 'BR',
                hits: 1,
            },
            {
                day: '2026-11-19',
                channel: 'pinned',
                version: '0.1.0',
                asset: 'archive',
                os: 'win32',
                arch: 'x64',
                client: 'script',
                country: 'BR',
                hits: 1,
            },
            {
                day: '2026-11-19',
                channel: 'stable',
                version: '0.1.0',
                asset: 'archive',
                os: 'linux',
                arch: 'arm64',
                client: 'cli',
                country: 'BR',
                hits: 1,
            },
        ]);
        for (const path of [
            '/download/stable/erden-0.0.9-linux-x64.tar.gz',
            '/download/stable/erden-linux-x64.zip',
            '/download/stable/erden-freebsd-x64.tar.gz',
            '/download/stable/../../etc/passwd',
            '/download/latest/install.sh',
            '/download/v0.1/install.sh',
            '/download/v0.1.0/README.md',
        ]) {
            expect((await h.request(path)).status, path).toBe(404);
        }
    });

    it('serves but does not count requests from Erden CI, or HEAD requests', async () => {
        const h = harness();
        expect((await h.request('/install', { headers: { 'x-erden-ci': '1' } })).status).toBe(302);
        expect((await h.request('/install', { method: 'HEAD' })).status).toBe(302);
        expect((await h.request('/updates/stable/linux/x64/0.1.0', { headers: { 'x-erden-ci': '1' } })).status).toBe(
            200,
        );
        expect(h.env.DB.rows('SELECT COUNT(*) AS n FROM downloads')).toEqual([{ n: 0 }]);
        expect(h.env.DB.rows('SELECT COUNT(*) AS n FROM update_checks')).toEqual([{ n: 0 }]);
        expect((await h.request('/install', { method: 'POST' })).status).toBe(405);
    });

    it('answers the latest release per channel and counts the check per day', async () => {
        const h = harness();
        const stable = await h.request('/updates/stable/linux/x64/0.1.0');
        expect(await stable.json()).toEqual({
            schema: 'erden.cli-release/v1',
            channel: 'stable',
            version: '0.1.0',
            tag: 'v0.1.0',
            publishedAt: '2026-11-10T00:00:00Z',
            url: 'https://github.com/erden-sh/erden/releases/tag/v0.1.0',
        });
        const canary = (await (await h.request('/updates/canary/win32/x64/0.1.0')).json()) as { version: string };
        expect(canary.version).toBe('0.2.0-rc.10');
        await h.request('/updates/stable/linux/x64/0.1.0');
        expect(h.env.DB.rows('SELECT * FROM update_checks ORDER BY channel')).toEqual([
            {
                day: '2026-11-19',
                channel: 'canary',
                os: 'win32',
                arch: 'x64',
                version: '0.1.0',
                country: 'BR',
                hits: 1,
            },
            {
                day: '2026-11-19',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
                version: '0.1.0',
                country: 'BR',
                hits: 2,
            },
        ]);
        for (const path of [
            '/updates/beta/linux/x64/0.1.0',
            '/updates/stable/haiku/x64/0.1.0',
            '/updates/stable/linux/ia32/0.1.0',
            '/updates/stable/linux/x64/0.1.0-dev',
        ]) {
            expect((await h.request(path)).status, path).toBe(400);
        }
    });

    it('lets canary follow stable once stable is newer, and has no canary before any release', async () => {
        const newer = { ...STABLE, tag_name: 'v0.2.0', assets: assets('0.2.0') };
        const h = harness([...RELEASES, newer], newer);
        const canary = (await (await h.request('/updates/canary/linux/x64/0.2.0-rc.10')).json()) as {
            version: string;
        };
        expect(canary.version).toBe('0.2.0');
        const empty = harness([], null);
        expect((await empty.request('/install')).status).toBe(404);
        expect((await empty.request('/updates/canary/linux/x64/0.1.0')).status).toBe(404);
    });

    it('orders versions with a release above its own release candidates', () => {
        expect(compareVersions('0.2.0', '0.2.0-rc.10')).toBeGreaterThan(0);
        expect(compareVersions('0.2.0-rc.10', '0.2.0-rc.2')).toBeGreaterThan(0);
        expect(compareVersions('0.10.0', '0.9.9')).toBeGreaterThan(0);
        expect(parseAsset('erden-0.1.0-darwin-arm64.tar.gz', '0.1.0')?.os).toBe('darwin');
        expect(parseAsset('erden-0.1.0-darwin-arm64.tar.gz', '0.2.0')).toBeNull();
    });

    it('recognizes the CLI by the User-Agent the CLI sends', () => {
        for (const [platform, arch] of [
            ['linux', 'x64'],
            ['linux', 'arm64'],
            ['darwin', 'arm64'],
            ['win32', 'x64'],
        ] as const) {
            const request = new Request('https://erden.sh/', {
                headers: { 'user-agent': cliUserAgent('0.2.0-rc.1', platform, arch) },
            });
            expect(clientOf(request)).toEqual({ client: 'cli', os: platform, arch });
        }
    });

    it('reports only with the report token and prunes old rows', async () => {
        const h = harness();
        await h.request('/install');
        expect((await h.request('/updates/report')).status).toBe(401);
        const report = await h.request('/updates/report', { headers: { 'x-report-token': TOKEN } });
        expect(report.status).toBe(200);
        expect(((await report.json()) as { downloads: { asset: unknown } }).downloads.asset).toEqual([
            { key: 'install.sh', hits: 1 },
        ]);
        await prune(h.env.DB, new Date(NOW.getTime() + (RETENTION_DAYS + 1) * 86_400_000));
        expect(h.env.DB.rows('SELECT COUNT(*) AS n FROM downloads')).toEqual([{ n: 0 }]);
    });
});
