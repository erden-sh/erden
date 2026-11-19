// The Erden CLI telemetry Worker (telemetry.erden.sh), modeled on PaceBar's: the CLI posts one anonymous event per
// command it ran, and the Worker keeps a per-day rollup in D1 (schema.sql). Every field is checked against a closed
// vocabulary or format before anything is stored, and a body that is not exactly the documented event is refused, so a
// changed or hostile client cannot make it store free text. docs/telemetry.md is the public description of all of it.
//
//   POST /v1/events   one event; 204 when stored, 400 when refused
//   GET  /v1/report   aggregate counts for the last 30 days; needs the X-Report-Token secret (REPORT_TOKEN)
//   GET  /health      {"ok":true}
//
// A daily scheduled run deletes rows older than RETENTION_DAYS.
import { coarseCountry, json, reportAllowed, utcDay, type D1Database } from '../../shared/http.js';

export interface Env {
    readonly DB: D1Database;
    /** Secret; GET /v1/report is refused unless the request's X-Report-Token equals it. */
    readonly REPORT_TOKEN?: string;
}

export const RETENTION_DAYS = 730;
const REPORT_WINDOW_DAYS = 30;
const MAXIMUM_BODY_BYTES = 1024;
const MAXIMUM_DURATION_MS = 86_400_000;

export const EVENT_SCHEMA = 'erden.telemetry-event/v1';
export const CHANNELS = Object.freeze(['stable', 'canary'] as const);
export const OPERATING_SYSTEMS = Object.freeze(['linux', 'darwin', 'win32'] as const);
export const ARCHITECTURES = Object.freeze(['x64', 'arm64'] as const);
export const OUTCOMES = Object.freeze(['success', 'failure', 'usage-error', 'operational-error', 'crash'] as const);
/** A command's fixed name: one or two lowercase words, never anything a user typed (the CLI sends `unknown` then). */
const COMMAND = /^[a-z][a-z-]{0,23}(?: [a-z][a-z-]{0,23})?$/u;
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
        !matches(command, COMMAND) ||
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

/** Stores one event: refreshes its install's row and adds the run to its day's rollup. */
export async function storeEvent(db: D1Database, event: TelemetryEvent, country: string, day: string): Promise<void> {
    await db.batch([
        db
            .prepare(
                `INSERT INTO installs (id, first_day, last_day, version, channel, os, arch, country)
                 VALUES (?1, ?2, ?2, ?3, ?4, ?5, ?6, ?7)
                 ON CONFLICT (id) DO UPDATE SET
                     last_day = ?2, version = ?3, channel = ?4, os = ?5, arch = ?6, country = ?7`,
            )
            .bind(event.installId, day, event.version, event.channel, event.os, event.arch, country),
        db
            .prepare(
                `INSERT INTO command_runs
                     (day, install_id, command, outcome, version, channel, os, arch, country, runs, duration_ms, max_ms)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 1, ?10, ?10)
                 ON CONFLICT (day, install_id, command, outcome, version, channel, os, arch, country) DO UPDATE SET
                     runs = runs + 1, duration_ms = duration_ms + ?10, max_ms = max(max_ms, ?10)`,
            )
            .bind(
                day,
                event.installId,
                event.command,
                event.outcome,
                event.version,
                event.channel,
                event.os,
                event.arch,
                country,
                event.durationMs,
            ),
    ]);
}

async function handleEvent(request: Request, env: Env, now: Date): Promise<Response> {
    const event = parseEvent(await readBody(request));
    if (event === null) {
        return json({ error: 'not an erden.telemetry-event/v1 event' }, 400);
    }
    await storeEvent(env.DB, event, coarseCountry(request), utcDay(now));
    return new Response(null, { status: 204, headers: { 'cache-control': 'no-store' } });
}

async function handleReport(env: Env, now: Date): Promise<Response> {
    const since = utcDay(new Date(now.getTime() - REPORT_WINDOW_DAYS * 86_400_000));
    // Column names come only from these fixed lists, never from the request.
    async function installsBy(column: 'version' | 'channel' | 'os' | 'arch' | 'country') {
        return (
            await env.DB.prepare(
                `SELECT ${column} AS key, COUNT(*) AS installs FROM installs WHERE last_day >= ?1
                 GROUP BY ${column} ORDER BY installs DESC`,
            )
                .bind(since)
                .all()
        ).results;
    }
    const active = await env.DB.prepare('SELECT COUNT(*) AS n FROM installs WHERE last_day >= ?1').bind(since).first();
    const commands = (
        await env.DB.prepare(
            `SELECT command, outcome, SUM(runs) AS runs, COUNT(DISTINCT install_id) AS installs,
                    SUM(duration_ms) / SUM(runs) AS mean_ms, MAX(max_ms) AS max_ms
             FROM command_runs WHERE day >= ?1 GROUP BY command, outcome ORDER BY runs DESC`,
        )
            .bind(since)
            .all()
    ).results;
    const perDay = (
        await env.DB.prepare(
            `SELECT day, COUNT(DISTINCT install_id) AS installs, SUM(runs) AS runs FROM command_runs
             WHERE day >= ?1 GROUP BY day ORDER BY day DESC`,
        )
            .bind(since)
            .all()
    ).results;
    return json({
        windowDays: REPORT_WINDOW_DAYS,
        activeInstalls: active?.n ?? 0,
        byVersion: await installsBy('version'),
        byChannel: await installsBy('channel'),
        byOs: await installsBy('os'),
        byArch: await installsBy('arch'),
        byCountry: await installsBy('country'),
        commands,
        perDay,
    });
}

/** Deletes everything older than the retention period. */
export async function prune(db: D1Database, now: Date): Promise<void> {
    const cutoff = utcDay(new Date(now.getTime() - RETENTION_DAYS * 86_400_000));
    await db.batch([
        db.prepare('DELETE FROM command_runs WHERE day < ?1').bind(cutoff),
        db.prepare('DELETE FROM installs WHERE last_day < ?1').bind(cutoff),
    ]);
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
