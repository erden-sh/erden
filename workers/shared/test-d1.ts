// A D1 binding over Node's built-in SQLite, for the Workers' tests: the same SQL dialect D1 runs, the real schema.sql,
// and the Workers' own statements, without Cloudflare's runtime.
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

import type { D1Database, D1PreparedStatement } from './http.js';

type Value = string | number | null;

class Statement implements D1PreparedStatement {
    constructor(
        private readonly database: DatabaseSync,
        private readonly query: string,
        private readonly values: ReadonlyArray<Value> = [],
    ) {}

    bind(...values: ReadonlyArray<Value>): D1PreparedStatement {
        return new Statement(this.database, this.query, values);
    }

    runNow(): void {
        this.database.prepare(this.query).run(...this.values);
    }

    async run(): Promise<unknown> {
        this.runNow();
        return await Promise.resolve({ success: true });
    }

    async first(): Promise<Record<string, unknown> | null> {
        return await Promise.resolve(
            (this.database.prepare(this.query).get(...this.values) as Record<string, unknown> | undefined) ?? null,
        );
    }

    async all(): Promise<{ results: Array<Record<string, unknown>> }> {
        return await Promise.resolve({
            results: this.database.prepare(this.query).all(...this.values),
        });
    }
}

export interface TestD1 extends D1Database {
    readonly rows: (query: string) => Array<Record<string, unknown>>;
}

/** A fresh in-memory database with `schemaPath` applied. */
export function testD1(schemaPath: string): TestD1 {
    const database = new DatabaseSync(':memory:');
    database.exec(readFileSync(schemaPath, 'utf8'));
    return {
        prepare: (query: string) => new Statement(database, query),
        async batch(statements: ReadonlyArray<D1PreparedStatement>): Promise<unknown> {
            database.exec('BEGIN');
            try {
                for (const statement of statements) {
                    (statement as Statement).runNow();
                }
                database.exec('COMMIT');
            } catch (error) {
                database.exec('ROLLBACK');
                throw error;
            }
            return await Promise.resolve([]);
        },
        rows: (query: string) => database.prepare(query).all(),
    };
}
