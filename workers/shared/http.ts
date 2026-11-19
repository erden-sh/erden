// What both Workers share: the D1 and Cache API shapes they use (declared here, so the code needs no Cloudflare type
// package and its tests run under Node), JSON responses, the coarse country Cloudflare derives from the client's IP,
// and the report token check. Neither Worker stores an IP address, a header value or any other request detail beyond
// the fields each schema.sql names.

/** The part of a D1 prepared statement the Workers use. */
export interface D1PreparedStatement {
    bind(...values: ReadonlyArray<string | number | null>): D1PreparedStatement;
    run(): Promise<unknown>;
    first(): Promise<Record<string, unknown> | null>;
    all(): Promise<{ results: Array<Record<string, unknown>> }>;
}

/** The part of a D1 database binding the Workers use. */
export interface D1Database {
    prepare(query: string): D1PreparedStatement;
    batch(statements: ReadonlyArray<D1PreparedStatement>): Promise<unknown>;
}

/** The part of a Worker's execution context the Workers use. */
export interface WorkerContext {
    waitUntil(promise: Promise<unknown>): void;
}

/** The part of the Cache API (`caches.default`) the release Worker uses. */
export interface EdgeCache {
    match(request: Request): Promise<Response | undefined>;
    put(request: Request, response: Response): Promise<void>;
}

export function json(data: unknown, status = 200, headers: Readonly<Record<string, string>> = {}): Response {
    return new Response(`${JSON.stringify(data)}\n`, {
        status,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
            'x-content-type-options': 'nosniff',
            ...headers,
        },
    });
}

/**
 * The two-letter country Cloudflare derives from the client's IP address, or '' when it is absent or not a plain
 * country code (Cloudflare uses `T1` for Tor and `XX` for unknown). The address itself is never read or stored.
 */
export function coarseCountry(request: Request): string {
    const country = (request as Request & { cf?: { country?: unknown } }).cf?.country;
    return typeof country === 'string' && /^[A-Z]{2}$/u.test(country) && country !== 'XX' && country !== 'T1'
        ? country
        : '';
}

/** Today's UTC date, YYYY-MM-DD: every stored time is a day, not an instant. */
export function utcDay(now: Date): string {
    return now.toISOString().slice(0, 10);
}

/** Constant-time comparison of the report token; a Worker with no token configured refuses every report. */
export function reportAllowed(request: Request, token: string | undefined): boolean {
    const offered = request.headers.get('x-report-token');
    if (token === undefined || token.length < 32 || offered === null) {
        return false;
    }
    const left = new TextEncoder().encode(offered);
    const right = new TextEncoder().encode(token);
    let difference = left.length ^ right.length;
    for (let index = 0; index < right.length; index += 1) {
        difference |= (left[index] ?? 0) ^ (right[index] as number);
    }
    return difference === 0;
}
