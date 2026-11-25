import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { TELEMETRY_COMMANDS, TELEMETRY_OUTCOMES } from '../../../apps/cli/src/telemetry.js';
import type { WorkerContext } from '../../shared/http.js';
import { testD1, type TestD1 } from '../../shared/test-d1.js';
import {
    ACTIVE_INSTALLS_RETENTION_DAYS,
    COMMANDS,
    COMMAND_RUNS_RETENTION_DAYS,
    OUTCOMES,
    DEFAULT_POSTHOG_HOST,
    dailyMaintenance,
    handle,
    parseEvent,
    type Env,
    type RateLimiter,
} from '../src/handler.js';
import worker from '../src/index.js';

const SCHEMA = join(import.meta.dirname, '..', 'schema.sql');
const NOW = new Date('2026-11-19T12:00:00Z');
const TOKEN = 'r'.repeat(40);

const EVENT = Object.freeze({
    schema: 'erden.telemetry-event/v1',
    installId: '3b241101-e2bb-4255-8caf-4136c566a962',
    version: '0.1.0',
    channel: 'stable',
    os: 'linux',
    arch: 'x64',
    command: 'check',
    outcome: 'success',
    durationMs: 812,
});

function environment(): Env & { DB: TestD1 } {
    return { DB: testD1(SCHEMA), REPORT_TOKEN: TOKEN };
}

function post(body: unknown, country = 'DE', headers: Record<string, string> = {}): Request {
    const text = typeof body === 'string' ? body : JSON.stringify(body);
    const request = new Request('https://telemetry.erden.sh/v1/events', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': String(text.length), ...headers },
        body: text,
    });
    Object.defineProperty(request, 'cf', { value: { country } });
    return request;
}

describe('telemetry Worker', () => {
    it('stores one documented event as an install and a per-day rollup, and nothing else', async () => {
        const env = environment();
        const first = await handle(post(EVENT, 'DE', { 'x-forwarded-for': '203.0.113.9' }), env, NOW);
        expect(first.status).toBe(204);
        await handle(post({ ...EVENT, durationMs: 1200 }), env, NOW);
        expect(env.DB.rows('SELECT * FROM command_runs')).toEqual([
            {
                day: '2026-11-19',
                command: 'check',
                outcome: 'success',
                version: '0.1.0',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
                country: 'DE',
                runs: 2,
                duration_ms: 2012,
                max_ms: 1200,
            },
        ]);
        expect(env.DB.rows('SELECT * FROM active_installs')).toEqual([
            { day: '2026-11-19', install_id: EVENT.installId },
        ]);
        // No column anywhere can hold an address or a header.
        const columns = env.DB.rows(
            "SELECT name FROM pragma_table_info('active_installs') UNION SELECT name FROM pragma_table_info('command_runs')",
        ).map((row) => row.name);
        // Only the short-lived active set holds an install ID.
        expect(columns.filter((name) => String(name).includes('install'))).toEqual(['install_id']);
        expect(env.DB.rows("SELECT name FROM pragma_table_info('command_runs')").map((row) => row.name)).not.toContain(
            'install_id',
        );
        expect(columns.some((name) => /ip|addr|agent|header|host|user/u.test(String(name)))).toBe(false);
    });

    it('refuses anything that is not exactly one documented event', async () => {
        const refused: unknown[] = [
            { ...EVENT, extra: 'x' },
            { ...EVENT, command: '/home/alice/project' },
            { ...EVENT, command: 'Check' },
            { ...EVENT, command: 'secret-project' },
            { ...EVENT, command: 'store secrets' },
            { ...EVENT, installId: 'not-a-uuid' },
            { ...EVENT, version: '0.1.0+local' },
            { ...EVENT, os: 'freebsd' },
            { ...EVENT, outcome: 'error: file not found' },
            { ...EVENT, durationMs: -1 },
            { ...EVENT, durationMs: 1.5 },
            { ...EVENT, schema: 'other' },
            [EVENT],
            'not json',
        ];
        const env = environment();
        for (const body of refused) {
            expect((await handle(post(body), env, NOW)).status).toBe(400);
        }
        const huge = { ...EVENT, command: 'check' };
        const oversized = new Request('https://telemetry.erden.sh/v1/events', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(huge).padEnd(2000, ' '),
        });
        expect((await handle(oversized, env, NOW)).status).toBe(400);
        expect(env.DB.rows('SELECT COUNT(*) AS n FROM command_runs')).toEqual([{ n: 0 }]);
        expect((await handle(new Request('https://telemetry.erden.sh/v1/events'), env, NOW)).status).toBe(405);
    });

    it('accepts every command name and outcome the CLI can send', () => {
        expect([...COMMANDS]).toEqual([...TELEMETRY_COMMANDS]);
        for (const command of TELEMETRY_COMMANDS) {
            expect(parseEvent({ ...EVENT, command })).not.toBeNull();
        }
        expect([...TELEMETRY_OUTCOMES]).toEqual([...OUTCOMES]);
    });

    it('drops country codes that are not a country', async () => {
        const env = environment();
        await handle(post(EVENT, 'T1'), env, NOW);
        expect(env.DB.rows('SELECT country FROM command_runs')).toEqual([{ country: '' }]);
    });

    it('reports only with the report token', async () => {
        const env = environment();
        await handle(post(EVENT), env, NOW);
        const anonymous = await handle(new Request('https://telemetry.erden.sh/v1/report'), env, NOW);
        expect(anonymous.status).toBe(401);
        const wrong = await handle(
            new Request('https://telemetry.erden.sh/v1/report', { headers: { 'x-report-token': 'x'.repeat(40) } }),
            env,
            NOW,
        );
        expect(wrong.status).toBe(401);
        const unset = await handle(
            new Request('https://telemetry.erden.sh/v1/report', { headers: { 'x-report-token': TOKEN } }),
            { DB: env.DB },
            NOW,
        );
        expect(unset.status).toBe(401);
        const report = await handle(
            new Request('https://telemetry.erden.sh/v1/report', { headers: { 'x-report-token': TOKEN } }),
            env,
            NOW,
        );
        expect(report.status).toBe(200);
        const body = (await report.json()) as Record<string, unknown>;
        expect(body.commands).toEqual([{ command: 'check', outcome: 'success', runs: 1, mean_ms: 812, max_ms: 812 }]);
    });

    it('rolls distinct installs up into ID-free totals and keeps install IDs only 35 days', async () => {
        const env = environment();
        const second = '9b2c1f3e-7a4d-4e5f-9a1b-2c3d4e5f6a7b';
        function day(offset: number): Date {
            return new Date(NOW.getTime() - offset * 86_400_000);
        }
        await handle(post(EVENT), env, day(1));
        await handle(post({ ...EVENT, installId: second }), env, day(1));
        await handle(post(EVENT), env, day(5));
        await handle(post({ ...EVENT, installId: second }), env, day(20));
        await handle(post(EVENT), env, day(ACTIVE_INSTALLS_RETENTION_DAYS + 1));
        await handle(post(EVENT), env, day(COMMAND_RUNS_RETENTION_DAYS + 1));
        await dailyMaintenance(env.DB, NOW);
        expect(env.DB.rows('SELECT * FROM active_totals')).toEqual([
            { day: '2026-11-18', daily: 2, weekly: 2, monthly: 2 },
        ]);
        expect(env.DB.rows('SELECT MIN(day) AS oldest FROM active_installs')).toEqual([{ oldest: '2026-10-30' }]);
        expect(env.DB.rows("SELECT COUNT(*) AS n FROM command_runs WHERE day < '2024-11-19'")).toEqual([{ n: 0 }]);
        expect(env.DB.rows('SELECT COUNT(*) AS n FROM command_runs')).toEqual([{ n: 4 }]);
    });

    it('refuses senders over the per-address rate limit, without storing the address', async () => {
        const keys: string[] = [];
        const limiter: RateLimiter = {
            async limit({ key }) {
                keys.push(key);
                return await Promise.resolve({ success: keys.length <= 1 });
            },
        };
        const env = { ...environment(), EVENT_LIMITER: limiter };
        expect((await handle(post(EVENT, 'DE', { 'cf-connecting-ip': '203.0.113.9' }), env, NOW)).status).toBe(204);
        expect((await handle(post(EVENT, 'DE', { 'cf-connecting-ip': '203.0.113.9' }), env, NOW)).status).toBe(429);
        expect(keys).toEqual(['203.0.113.9', '203.0.113.9']);
        expect(JSON.stringify(env.DB.rows('SELECT * FROM command_runs'))).not.toContain('203.0.113');
        expect(JSON.stringify(env.DB.rows('SELECT * FROM active_installs'))).not.toContain('203.0.113');
    });

    it('answers 503 instead of throwing when storage fails', async () => {
        const broken: Env = {
            DB: {
                prepare: () => {
                    throw new Error('down');
                },
                batch: async () => await Promise.reject(new Error('down')),
            },
        };
        expect((await worker.fetch(post(EVENT), broken, context().context)).status).toBe(503);
    });
});

/** A Worker context that keeps what it is asked to wait for, so a test can wait for it too. */
function context(): { context: WorkerContext; settled: () => Promise<unknown> } {
    const pending: Array<Promise<unknown>> = [];
    return {
        context: { waitUntil: (promise) => pending.push(promise) },
        settled: async () => await Promise.all(pending),
    };
}

/** What one forwarded request held. */
interface Forwarded {
    readonly url: string;
    readonly method: string | undefined;
    readonly headers: Array<[string, string]>;
    readonly body: string;
}

/** A stand-in for the global fetch that records each forwarded request and answers with `answer`. */
function stubFetch(
    answer: () => Promise<Response> = async () => await Promise.resolve(new Response(null, { status: 200 })),
): Forwarded[] {
    const requests: Forwarded[] = [];
    vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
        requests.push({
            url,
            method: init.method,
            headers: [...new Headers(init.headers).entries()],
            body: init.body as string,
        });
        return await answer();
    });
    return requests;
}

describe('telemetry Worker forwarding to PostHog', () => {
    const PROJECT_TOKEN = 'phc_testprojecttoken';
    const CLIENT_HEADERS = {
        'cf-connecting-ip': '203.0.113.9',
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.9',
        'true-client-ip': '203.0.113.9',
        forwarded: 'for=203.0.113.9',
        cookie: 'session=abc',
        'user-agent': 'erden/0.1.0 (linux; x64)',
    };

    function forwarding(): Env & { DB: TestD1 } {
        return { ...environment(), POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN, POSTHOG_HOST: 'https://posthog.example' };
    }

    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('sends nothing without a project token', async () => {
        const requests = stubFetch();
        for (const env of [environment(), { ...environment(), POSTHOG_PROJECT_TOKEN: '' }]) {
            const { context: ctx, settled } = context();
            expect((await handle(post(EVENT), env, NOW, ctx)).status).toBe(204);
            await settled();
        }
        expect(requests).toEqual([]);
    });

    it("posts one closed, ID-free event to the capture API, with none of the request's headers", async () => {
        const requests = stubFetch();
        const { context: ctx, settled } = context();
        const response = await handle(post(EVENT, 'DE', CLIENT_HEADERS), forwarding(), NOW, ctx);
        expect(response.status).toBe(204);
        await settled();
        expect(requests).toHaveLength(1);
        const [forwarded] = requests as [Forwarded];
        expect(forwarded.url).toBe('https://posthog.example/i/v0/e/');
        expect(forwarded.method).toBe('POST');
        const body = JSON.parse(forwarded.body) as Record<string, unknown>;
        expect(typeof body.distinct_id).toBe('string');
        expect(body.distinct_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
        expect(body.distinct_id).not.toBe(EVENT.installId);
        expect(body).toEqual({
            api_key: PROJECT_TOKEN,
            event: 'cli_command_run',
            distinct_id: body.distinct_id,
            timestamp: '2026-11-19T12:00:00.000Z',
            properties: {
                command: 'check',
                outcome: 'success',
                duration_ms: 812,
                version: '0.1.0',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
                country: 'DE',
                $geoip_disable: true,
                $process_person_profile: false,
            },
        });
        expect(forwarded.body).not.toContain(EVENT.installId);
        expect(forwarded.body).not.toContain('203.0.113');
        expect(forwarded.headers).toEqual([
            ['content-type', 'application/json'],
            ['user-agent', 'erden-telemetry-worker'],
        ]);
    });

    it('gives each forwarded event its own distinct ID and uses the default host when none is set', async () => {
        const requests = stubFetch();
        const env = { ...environment(), POSTHOG_PROJECT_TOKEN: PROJECT_TOKEN };
        const { context: ctx, settled } = context();
        await handle(post(EVENT), env, NOW, ctx);
        await handle(post(EVENT), env, NOW, ctx);
        await settled();
        expect(requests.map(({ url }) => url)).toEqual([
            `${DEFAULT_POSTHOG_HOST}/i/v0/e/`,
            `${DEFAULT_POSTHOG_HOST}/i/v0/e/`,
        ]);
        const ids = requests.map(({ body }) => (JSON.parse(body) as { distinct_id: string }).distinct_id);
        expect(new Set(ids).size).toBe(2);
    });

    it('forwards nothing for refused or rate-limited events', async () => {
        const requests = stubFetch();
        const limiter: RateLimiter = { limit: async () => await Promise.resolve({ success: false }) };
        const { context: ctx, settled } = context();
        expect((await handle(post({ ...EVENT, extra: 'x' }), forwarding(), NOW, ctx)).status).toBe(400);
        expect(
            (await handle(post(EVENT, 'DE', CLIENT_HEADERS), { ...forwarding(), EVENT_LIMITER: limiter }, NOW, ctx))
                .status,
        ).toBe(429);
        await settled();
        expect(requests).toEqual([]);
    });

    it('still answers 204 and stores the event when PostHog fails, and stores the same rows as without forwarding', async () => {
        const failing = [
            async () => await Promise.reject(new Error('unreachable')),
            async () => await Promise.resolve(new Response('no', { status: 500 })),
        ];
        const plain = environment();
        await handle(post(EVENT), plain, NOW);
        for (const answer of failing) {
            stubFetch(answer);
            const env = forwarding();
            const { context: ctx, settled } = context();
            expect((await handle(post(EVENT), env, NOW, ctx)).status).toBe(204);
            await expect(settled()).resolves.toBeDefined();
            for (const table of ['command_runs', 'active_installs', 'active_totals']) {
                expect(env.DB.rows(`SELECT * FROM ${table}`)).toEqual(plain.DB.rows(`SELECT * FROM ${table}`));
            }
            expect(env.DB.rows('SELECT COUNT(*) AS n FROM command_runs')).toEqual([{ n: 1 }]);
        }
    });

    it('waits for forwarding after the response, through the Worker context', async () => {
        const answer = Promise.withResolvers<Response>();
        stubFetch(async () => await answer.promise);
        const { context: ctx, settled } = context();
        const response = await worker.fetch(post(EVENT), forwarding(), ctx);
        expect(response.status).toBe(204);
        answer.resolve(new Response(null, { status: 200 }));
        await settled();
    });
});
