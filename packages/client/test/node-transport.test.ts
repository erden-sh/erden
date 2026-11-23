import { createServer, type Server, type Socket } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import {
    nodeRegistryFetch,
    openRegistryHttpResponse,
    putToSignedUrl,
    readRegistryResponseBody,
    requestRegistryJson,
} from '../src/http.js';
import { RegistryClientError, encodeCanonicalJson } from '../src/wire.js';

const servers: Server[] = [];

afterEach(async () => {
    for (const server of servers.splice(0)) {
        await new Promise<void>((resolve) => {
            server.close(() => {
                resolve();
            });
        });
    }
});

/**
 * A raw TCP server that answers every request with `answer(socket, requestBytes)`, so a test can send exactly the
 * HTTP/1.0 bytes Node's own HTTP server would never write.
 */
async function rawServer(answer: (socket: Socket, request: Buffer) => void): Promise<string> {
    const server = createServer((socket) => {
        socket.on('error', () => undefined);
        let received = Buffer.alloc(0);
        let answered = false;
        socket.on('data', (chunk: Buffer) => {
            received = Buffer.concat([received, chunk]);
            const head = received.indexOf('\r\n\r\n');
            if (answered || head < 0) {
                return;
            }
            const length = /content-length: *(\d+)/iu.exec(received.subarray(0, head).toString('latin1'));
            const chunked = /transfer-encoding: *chunked/iu.test(received.subarray(0, head).toString('latin1'));
            const complete = chunked
                ? received.includes('\r\n0\r\n\r\n')
                : received.length >= head + 4 + Number(length?.[1] ?? 0);
            if (complete) {
                answered = true;
                answer(socket, received);
            }
        });
    });
    servers.push(server);
    await new Promise<void>((resolve) => {
        server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address();
    if (address === null || typeof address === 'string') {
        throw new Error('no port');
    }
    return `http://127.0.0.1:${String(address.port)}`;
}

/** Fails the test if anything escapes as an uncaught exception while `run` is in progress. */
async function withoutUncaught<Value>(run: () => Promise<Value>): Promise<Value> {
    const escaped: unknown[] = [];
    function record(error: unknown): void {
        escaped.push(error);
    }
    process.on('uncaughtException', record);
    try {
        const value = await run();
        await new Promise((resolve) => setTimeout(resolve, 50));
        return value;
    } finally {
        process.off('uncaughtException', record);
        expect(escaped).toEqual([]);
    }
}

describe('node:http registry transport', () => {
    it('reads a large HTTP/1.0 body that ends when the connection closes, slowly, without an internal assertion', async () => {
        const size = 8 * 1024 * 1024;
        const origin = await rawServer((socket) => {
            socket.write('HTTP/1.0 200 OK\r\ncontent-type: application/vnd.erden.package.v1\r\n\r\n');
            socket.end(Buffer.alloc(size, 7));
        });
        const total = await withoutUncaught(async () => {
            const response = await nodeRegistryFetch(`${origin}/archive`, { redirect: 'manual' });
            const reader = (response.body as ReadableStream<Uint8Array>).getReader();
            let read = 0;
            for (;;) {
                const next = await reader.read();
                if (next.done) {
                    return read;
                }
                read += next.value.byteLength;
                await new Promise((resolve) => setTimeout(resolve, 1));
            }
        });
        expect(total).toBe(size);
    }, 60_000);

    it('answers registry JSON over HTTP/1.0, with and without a length, and sends a JSON body', async () => {
        const bodies: string[] = [];
        for (const length of [true, false]) {
            const origin = await rawServer((socket, request) => {
                bodies.push(request.subarray(request.indexOf('\r\n\r\n') + 4).toString('utf8'));
                const body = Buffer.from(encodeCanonicalJson({ ok: true }));
                socket.write(
                    `HTTP/1.0 201 Created\r\ncontent-type: application/json; charset=utf-8\r\n${length ? `content-length: ${String(body.byteLength)}\r\n` : ''}\r\n`,
                );
                socket.end(body);
            });
            const answer = await withoutUncaught(
                async () =>
                    await requestRegistryJson({
                        registryOrigin: origin,
                        path: '/api/v1/auth/device/code',
                        method: 'POST',
                        body: { request_id: 'x' },
                    }),
            );
            expect(answer).toEqual({ status: 201, body: { ok: true } });
        }
        expect(bodies).toEqual(['{"request_id":"x"}\n', '{"request_id":"x"}\n']);
    });

    it('turns a body cut short by a closed connection into a transport error', async () => {
        const origin = await rawServer((socket) => {
            socket.write('HTTP/1.0 200 OK\r\ncontent-type: application/octet-stream\r\ncontent-length: 1000\r\n\r\n');
            socket.end(Buffer.alloc(10));
        });
        const failure = await withoutUncaught(async () => {
            const opened = await openRegistryHttpResponse({
                registryOrigin: origin,
                path: '/archive',
                method: 'GET',
                headers: {},
                timeoutMilliseconds: 10_000,
            });
            try {
                return await readRegistryResponseBody(opened.response, 10_000, opened.signal).then(
                    () => undefined,
                    (error: unknown) => error,
                );
            } finally {
                opened.finish();
            }
        });
        expect(failure).toBeInstanceOf(RegistryClientError);
        expect((failure as RegistryClientError).code).toBe('CLIENT_TRANSPORT');
    });

    it('turns a refused connection into a transport error and a stalled one into a timeout', async () => {
        const closed = await rawServer(() => undefined);
        servers.pop()?.close();
        await expect(
            openRegistryHttpResponse({
                registryOrigin: closed,
                path: '/x',
                method: 'GET',
                headers: {},
                timeoutMilliseconds: 10_000,
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_TRANSPORT' });
        const stalled = await rawServer(() => undefined);
        await expect(
            openRegistryHttpResponse({
                registryOrigin: stalled,
                path: '/x',
                method: 'GET',
                headers: {},
                timeoutMilliseconds: 200,
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_TIMEOUT' });
    });

    it('streams a signed PUT body and reads an HTTP/1.0 answer, never following a redirect', async () => {
        const received: Buffer[] = [];
        const stored = await rawServer((socket, request) => {
            received.push(request);
            socket.end('HTTP/1.0 200 OK\r\n\r\n');
        });
        const body = new Blob([Buffer.alloc(100_000, 1)]).stream();
        expect(
            await withoutUncaught(
                async () =>
                    await putToSignedUrl({
                        url: `${stored}/object`,
                        headers: {},
                        body,
                        idleTimeoutMilliseconds: 10_000,
                    }),
            ),
        ).toBe('stored');
        expect(received[0]?.toString('latin1')).toMatch(/^PUT \/object HTTP\/1\.1\r\n/u);
        const redirect = await rawServer((socket) => {
            socket.end('HTTP/1.0 302 Found\r\nlocation: http://127.0.0.1:9/elsewhere\r\n\r\n');
        });
        await expect(
            putToSignedUrl({
                url: `${redirect}/object`,
                headers: {},
                body: new Blob(['x']).stream(),
                idleTimeoutMilliseconds: 10_000,
            }),
        ).rejects.toMatchObject({ code: 'CLIENT_RESPONSE_INVALID' });
    });
});
