import { z } from 'zod';

import {
    AgentScopeHTTPRouter,
    emptyResponse,
    jsonResponse,
    quoteHeaderFilename,
} from '../src/http';

const app = {} as ConstructorParameters<typeof AgentScopeHTTPRouter>[0];

describe('Web Standards HTTP router', () => {
    test('matches parameters, query values, trailing slashes, and methods', async () => {
        const router = new AgentScopeHTTPRouter(app).get('/items/{item_id}', context => {
            const query = context.query(z.object({ limit: z.coerce.number().int() })) as {
                limit: number;
            };
            return jsonResponse({ id: context.params.item_id, limit: query.limit });
        });
        const response = await router.fetch(new Request('http://service/items/a%20b/?limit=2'));
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ id: 'a b', limit: 2 });
        expect(
            (await router.fetch(new Request('http://service/items/a', { method: 'POST' }))).status
        ).toBe(405);
        expect((await router.fetch(new Request('http://service/missing'))).status).toBe(404);
        const missingQuery = await router.fetch(new Request('http://service/items/a'));
        expect(await missingQuery.json()).toEqual({
            detail: [
                {
                    type: 'missing',
                    loc: ['query', 'limit'],
                    msg: 'Field required',
                    input: null,
                },
            ],
        });
    });

    test('returns FastAPI-shaped header, JSON, and Zod validation failures', async () => {
        const router = new AgentScopeHTTPRouter(app).post('/items', async context => {
            const body = (await context.json(z.object({ name: z.string().min(1) }))) as {
                name: string;
            };
            return jsonResponse({ user: context.userId(), name: body.name }, 201);
        });
        const missingHeader = await router.fetch(
            new Request('http://service/items', {
                method: 'POST',
                body: JSON.stringify({ name: 'ok' }),
            })
        );
        expect(missingHeader.status).toBe(422);
        expect(await missingHeader.json()).toMatchObject({
            detail: [{ loc: ['header', 'x-user-id'] }],
        });
        const invalid = await router.fetch(
            new Request('http://service/items', {
                method: 'POST',
                headers: { 'x-user-id': 'alice' },
                body: JSON.stringify({ name: '' }),
            })
        );
        expect(invalid.status).toBe(422);
        expect(await invalid.json()).toMatchObject({ detail: [{ loc: ['body', 'name'] }] });
    });

    test('composes middleware and returns empty 204 responses', async () => {
        const seen: string[] = [];
        const router = new AgentScopeHTTPRouter(app)
            .use(async (request, next) => {
                seen.push('before');
                const response = await next(request);
                seen.push('after');
                return response;
            })
            .delete('/items/{item_id}', () => emptyResponse());
        const response = await router.fetch(
            new Request('http://service/items/one', { method: 'DELETE' })
        );
        expect(response.status).toBe(204);
        expect(seen).toEqual(['before', 'after']);
    });

    test('quotes content-disposition filenames like Python urllib', () => {
        expect(quoteHeaderFilename("a b'c(1)!.txt")).toBe('a%20b%27c%281%29%21.txt');
    });
});
