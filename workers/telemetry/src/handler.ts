// The Erden CLI telemetry Worker (telemetry.erden.sh), modeled on PaceBar's: the CLI posts one anonymous event per
// command it ran, and the Worker keeps per-day rollups in D1 (schema.sql). Every field is checked against a closed
// vocabulary or format before anything is stored, and a body that is not exactly the documented event is refused, so a
// changed or hostile client cannot make it store free text. docs/telemetry.md is the public description of all of it.
//
//   POST /v1/events   one event; 204 when stored, 400 when refused, 429 when the sender is over the rate limit
//   GET  /v1/report   aggregate counts; needs the X-Report-Token secret (REPORT_TOKEN)
//   GET  /health      {"ok":true}
//
// What is stored, and for how long:
// - command_runs: runs, total and longest duration per UTC day, command, outcome, version, channel, OS, architecture
//   and country. No install ID. Kept COMMAND_RUNS_RETENTION_DAYS.
// - active_installs: which install IDs sent an event on which UTC day, and nothing else, only to count distinct
//   installs. Kept ACTIVE_INSTALLS_RETENTION_DAYS, enough for daily, weekly and 30-day counts.
// - active_totals: those counts per day (daily, 7-day and 30-day distinct installs), with no ID. Kept like command_runs.
// The daily scheduled run computes active_totals for the previous day, then deletes what is past its retention.
//
// The rate limit is keyed on the client's IP address (the CF-Connecting-IP header), which the rate-limit binding sees
// in memory for the length of the request; it is never stored or logged.
import { coarseCountry, json, reportAllowed, utcDay, type D1Database } from '../../shared/http.js';

/** The Workers rate-limit binding (`ratelimits` in wrangler.jsonc). */
export interface RateLimiter {
    limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
    readonly DB: D1Database;
    /** Secret; GET /v1/report is refused unless the request's X-Report-Token equals it. */
    readonly REPORT_TOKEN?: string;
    /** Events per client IP address per minute; absent in local development. */
    readonly EVENT_LIMITER?: RateLimiter;
}

export const COMMAND_RUNS_RETENTION_DAYS = 730;
export const ACTIVE_INSTALLS_RETENTION_DAYS = 35;
const REPORT_WINDOW_DAYS = 30;
const MAXIMUM_BODY_BYTES = 1024;
const MAXIMUM_DURATION_MS = 86_400_000;
const DAY_MS = 86_400_000;

export const EVENT_SCHEMA = 'erden.telemetry-event/v1';
export const CHANNELS = Object.freeze(['stable', 'canary'] as const);
export const OPERATING_SYSTEMS = Object.freeze(['linux', 'darwin', 'win32'] as const);
export const ARCHITECTURES = Object.freeze(['x64', 'arm64'] as const);
export const OUTCOMES = Object.freeze(['success', 'failure', 'usage-error', 'operational-error', 'crash'] as const);
/**
 * The command names the CLI may send (apps/cli/src/telemetry.ts TELEMETRY_COMMANDS; a test keeps the two equal). A
 * newer CLI's new command is sent as `unknown` until this list has it, so nothing outside it is ever stored.
 */
export const COMMANDS = Object.freeze([
    'add',
    'check',
    'doctor',
    'help',
    'init',
    'install',
    'login',
    'logout',
    'pack',
    'path',
    'publication',
    'publish',
    'query',
    'remove',
    'store',
    'store path',
    'store prune',
    'store status',
    'unknown',
    'update',
    'upgrade',
    'version',
] as const);
const INSTALL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const VERSION = /^(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})\.(?:0|[1-9]\d{0,5})(?:-rc\.(?:0|[1-9]\d{0,5}))?$/u;

export interface TelemetryEvent {
    readonly installId: string;
    readonly version: string;
    readonly channel: string;
    readonly os: string;
    readonly arch: string;
    readonly command: string;
    readonly outcome: string;
    readonly durationMs: number;
}

const EVENT_FIELDS = Object.freeze(
    ['arch', 'channel', 'command', 'durationMs', 'installId', 'os', 'outcome', 'schema', 'version'].sort(),
);

function oneOf(value: unknown, allowed: ReadonlyArray<string>): value is string {
    return typeof value === 'string' && allowed.includes(value);
}

function matches(value: unknown, pattern: RegExp): value is string {
    return typeof value === 'string' && pattern.test(value);
}

/** The event `body` holds, or null unless it is exactly one documented event. */
export function parseEvent(body: unknown): TelemetryEvent | null {
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return null;
    }
    const record = body as Record<string, unknown>;
    if (Object.keys(record).sort().join(',') !== EVENT_FIELDS.join(',')) {
        return null;
    }
    const { installId, version, channel, os, arch, command, outcome, durationMs } = record;
    if (
        record.schema !== EVENT_SCHEMA ||
        !matches(installId, INSTALL_ID) ||
        !matches(version, VERSION) ||
        !oneOf(channel, CHANNELS) ||
        !oneOf(os, OPERATING_SYSTEMS) ||
        !oneOf(arch, ARCHITECTURES) ||
        !oneOf(command, COMMANDS) ||
        !oneOf(outcome, OUTCOMES) ||
        typeof durationMs !== 'number' ||
        !Number.isSafeInteger(durationMs) ||
        durationMs < 0 ||
        durationMs > MAXIMUM_DURATION_MS
    ) {
        return null;
    }
    return { installId, version, channel, os, arch, command, outcome, durationMs };
}

async function readBody(request: Request): Promise<unknown> {
    if (!(request.headers.get('content-type') ?? '').startsWith('application/json')) {
        return undefined;
    }
    const declared = Number(request.headers.get('content-length') ?? '0');
    if (declared > MAXIMUM_BODY_BYTES) {
        return undefined;
    }
    const bytes = new Uint8Array(await request.arrayBuffer());
    if (bytes.byteLength > MAXIMUM_BODY_BYTES) {
        return undefined;
    }
    try {
        return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)) as unknown;
    } catch {
        return undefined;
    }
}

/** Stores one event: its run in the day's ID-free rollup, and its install ID in the day's short-lived active set. */
export async function storeEvent(db: D1Database, event: TelemetryEvent, country: string, day: string): Promise<void> {
    await db.batch([
        db
            .prepare(
                `INSERT INTO command_runs
                     (day, command, outcome, version, channel, os, arch, country, runs, duration_ms, max_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 1, ?9, ?9)
                 ON CONFLICT (day, command, outcome, version, channel, os, arch, country) DO UPDATE SET
                     runs = runs + 1, duration_ms = duration_ms + ?9, max_ms = max(max_ms, ?9)`,
            )
            .bind(
                day,
                event.command,
                event.outcome,
                event.version,
                event.channel,
                event.os,
                event.arch,
                country,
                event.durationMs,
            ),
        db
            .prepare('INSERT INTO active_installs (day, install_id) VALUES (?1, ?2) ON CONFLICT DO NOTHING')
            .bind(day, event.installId),
    ]);
}

/** Whether the client is under the per-IP event limit; the address is used here only and never stored. */
async function underRateLimit(request: Request, env: Env): Promise<boolean> {
    const address = request.headers.get('cf-connecting-ip');
    if (env.EVENT_LIMITER === undefined || address === null) {
        return true;
    }
    return (await env.EVENT_LIMITER.limit({ key: address })).success;
}

async function handleEvent(request: Request, env: Env, now: Date): Promise<Response> {
    if (!(await underRateLimit(request, env))) {
        return json({ error: 'too many events' }, 429, { 'retry-after': '60' });
    }
    const event = parseEvent(await readBody(request));
    if (event === null) {
        return json({ error: 'not an erden.telemetry-event/v1 event' }, 400);
    }
    await storeEvent(env.DB, event, coarseCountry(request), utcDay(now));
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

function daysBefore(day: string, days: number): string {
    return utcDay(new Date(Date.parse(`${day}T00:00:00Z`) - days * DAY_MS));
}

/** Records the ID-free daily, 7-day and 30-day distinct install counts for `day`, from active_installs. */
export async function rollUpActiveInstalls(db: D1Database, day: string): Promise<void> {
    function distinctSince(since: string) {
        return db
            .prepare('SELECT COUNT(DISTINCT install_id) AS n FROM active_installs WHERE day >= ?1 AND day <= ?2')
            .bind(since, day)
            .first();
    }
    const [daily, weekly, monthly] = await Promise.all([
        distinctSince(day),
        distinctSince(daysBefore(day, 6)),
        distinctSince(daysBefore(day, 29)),
    ]);
    await db
        .prepare(
            `INSERT INTO active_totals (day, daily, weekly, monthly) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT (day) DO UPDATE SET daily = ?2, weekly = ?3, monthly = ?4`,
        )
        .bind(day, Number(daily?.n ?? 0), Number(weekly?.n ?? 0), Number(monthly?.n ?? 0))
        .run();
}

/** The daily run: yesterday's active totals, then everything past its retention deleted. */
export async function dailyMaintenance(db: D1Database, now: Date): Promise<void> {
    const today = utcDay(now);
    await rollUpActiveInstalls(db, daysBefore(today, 1));
    const longCutoff = daysBefore(today, COMMAND_RUNS_RETENTION_DAYS);
    await db.batch([
        db
            .prepare('DELETE FROM active_installs WHERE day < ?1')
            .bind(daysBefore(today, ACTIVE_INSTALLS_RETENTION_DAYS)),
        db.prepare('DELETE FROM command_runs WHERE day < ?1').bind(longCutoff),
        db.prepare('DELETE FROM active_totals WHERE day < ?1').bind(longCutoff),
    ]);
}

async function handleReport(env: Env, now: Date): Promise<Response> {
    const since = daysBefore(utcDay(now), REPORT_WINDOW_DAYS);
    // Column names come only from this fixed list, never from the request.
    async function runsBy(column: 'version' | 'channel' | 'os' | 'arch' | 'country') {
        return (
            await env.DB.prepare(
                `SELECT ${column} AS key, SUM(runs) AS runs FROM command_runs WHERE day >= ?1
                 GROUP BY ${column} ORDER BY runs DESC`,
            )
                .bind(since)
                .all()
        ).results;
    }
    const commands = (
        await env.DB.prepare(
            `SELECT command, outcome, SUM(runs) AS runs, SUM(duration_ms) / SUM(runs) AS mean_ms, MAX(max_ms) AS max_ms
             FROM command_runs WHERE day >= ?1 GROUP BY command, outcome ORDER BY runs DESC`,
        )
            .bind(since)
            .all()
    ).results;
    const active = (
        await env.DB.prepare('SELECT day, daily, weekly, monthly FROM active_totals WHERE day >= ?1 ORDER BY day DESC')
            .bind(since)
            .all()
    ).results;
    return json({
        windowDays: REPORT_WINDOW_DAYS,
        active,
        commands,
        byVersion: await runsBy('version'),
        byChannel: await runsBy('channel'),
        byOs: await runsBy('os'),
        byArch: await runsBy('arch'),
        byCountry: await runsBy('country'),
    });
}

export async function handle(request: Request, env: Env, now: Date = new Date()): Promise<Response> {
    const { pathname } = new URL(request.url);
    if (pathname === '/v1/events') {
        return request.method === 'POST'
            ? await handleEvent(request, env, now)
            : json({ error: 'method not allowed' }, 405, { allow: 'POST' });
    }
    if (pathname === '/v1/report' && request.method === 'GET') {
        return reportAllowed(request, env.REPORT_TOKEN)
            ? await handleReport(env, now)
            : json({ error: 'unauthorized' }, 401);
    }
    if (pathname === '/health' && request.method === 'GET') {
        return json({ ok: true });
    }
    return json({ error: 'not found' }, 404);
}
