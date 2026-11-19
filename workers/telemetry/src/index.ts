// The Worker module wrangler deploys: only its handlers. The Workers runtime refuses any other export from the entry
// module, so the logic and its tests live in handler.ts.
import { json, type WorkerContext } from '../../shared/http.js';

import { handle, prune, type Env } from './handler.js';

export default {
    async fetch(request: Request, env: Env): Promise<Response> {
        try {
            return await handle(request, env);
        } catch {
            return json({ error: 'unavailable' }, 503);
        }
    },
    scheduled(_controller: unknown, env: Env, context: WorkerContext): void {
        context.waitUntil(prune(env.DB, new Date()));
    },
};
