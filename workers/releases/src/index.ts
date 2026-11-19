// The Worker module wrangler deploys: only its handlers. The Workers runtime refuses any other export from the entry
// module, so the logic and its tests live in handler.ts.
import { json, type EdgeCache, type WorkerContext } from '../../shared/http.js';

import { handle, prune, type Env } from './handler.js';

export default {
    async fetch(request: Request, env: Env, context: WorkerContext): Promise<Response> {
        try {
            return await handle(request, env, context, {
                fetch: (input, init) => fetch(input, init),
                cache: (globalThis as unknown as { caches: { default: EdgeCache } }).caches.default,
                now: () => new Date(),
            });
        } catch {
            return json({ error: 'the release index is unavailable' }, 503);
        }
    },
    scheduled(_controller: unknown, env: Env, context: WorkerContext): void {
        context.waitUntil(prune(env.DB, new Date()));
    },
};
