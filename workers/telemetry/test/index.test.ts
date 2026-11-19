import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { TELEMETRY_COMMANDS, TELEMETRY_OUTCOMES } from '../../../apps/cli/src/telemetry.js';
import { testD1, type TestD1 } from '../../shared/test-d1.js';
import { OUTCOMES, RETENTION_DAYS, handle, parseEvent, prune, type Env } from '../src/handler.js';
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
        expect(env.DB.rows('SELECT * FROM installs')).toEqual([
            {
                id: EVENT.installId,
                first_day: '2026-11-19',
                last_day: '2026-11-19',
                version: '0.1.0',
                channel: 'stable',
                os: 'linux',
                arch: 'x64',
                country: 'DE',
            },
        ]);
        expect(env.DB.rows('SELECT * FROM command_runs')).toEqual([
            {
                day: '2026-11-19',
                install_id: EVENT.installId,
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
        // No column anywhere can hold an address or a header.
        const columns = env.DB.rows(
            "SELECT name FROM pragma_table_info('installs') UNION SELECT name FROM pragma_table_info('command_runs')",
        ).map((row) => row.name);
        expect(columns.some((name) => /ip|addr|agent|header|host|user/u.test(String(name)))).toBe(false);
    });

    it('refuses anything that is not exactly one documented event', async () => {
        const refused: unknown[] = [
            { ...EVENT, extra: 'x' },
            { ...EVENT, command: '/home/alice/project' },
            { ...EVENT, command: 'Check' },
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
        expect(env.DB.rows('SELECT COUNT(*) AS n FROM installs')).toEqual([{ n: 0 }]);
        expect((await handle(new Request('https://telemetry.erden.sh/v1/events'), env, NOW)).status).toBe(405);
    });

    it('accepts every command name and outcome the CLI can send', () => {
        for (const command of TELEMETRY_COMMANDS) {
            expect(parseEvent({ ...EVENT, command })).not.toBeNull();
        }
        expect([...TELEMETRY_OUTCOMES]).toEqual([...OUTCOMES]);
    });

    it('drops country codes that are not a country', async () => {
        const env = environment();
        await handle(post(EVENT, 'T1'), env, NOW);
        expect(env.DB.rows('SELECT country FROM installs')).toEqual([{ country: '' }]);
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
        expect(body.activeInstalls).toBe(1);
        expect(body.commands).toEqual([
            { command: 'check', outcome: 'success', runs: 1, installs: 1, mean_ms: 812, max_ms: 812 },
        ]);
    });

    it('deletes rows past the retention period', async () => {
        const env = environment();
        const old = new Date(NOW.getTime() - (RETENTION_DAYS + 1) * 86_400_000);
        await handle(post(EVENT), env, old);
        await handle(post({ ...EVENT, installId: '9b2c1f3e-7a4d-4e5f-9a1b-2c3d4e5f6a7b' }), env, NOW);
        await prune(env.DB, NOW);
        expect(env.DB.rows('SELECT id FROM installs')).toEqual([{ id: '9b2c1f3e-7a4d-4e5f-9a1b-2c3d4e5f6a7b' }]);
        expect(env.DB.rows('SELECT COUNT(*) AS n FROM command_runs')).toEqual([{ n: 1 }]);
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
        expect((await worker.fetch(post(EVENT), broken)).status).toBe(503);
    });
});
