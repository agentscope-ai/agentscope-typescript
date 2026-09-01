/* eslint-disable jsdoc/require-jsdoc */

import { parseAgentEvent, type AgentEvent } from '@agentscope-ai/agentscope/event';

export abstract class ProtocolMiddlewareBase<TProtocol extends Record<string, unknown>> {
    async *convertStream(
        originalStream: AsyncIterable<string | Uint8Array>
    ): AsyncIterable<Uint8Array> {
        const encoder = new TextEncoder();
        const decoder = new TextDecoder();
        for await (const chunk of originalStream) {
            const chunkString = typeof chunk === 'string' ? chunk : decoder.decode(chunk);
            const convertedFrame = this.convertSseFrame(chunkString);
            if (convertedFrame) {
                yield encoder.encode(convertedFrame);
                continue;
            }
            const convertedEvent = this.convertEventJson(chunkString);
            if (convertedEvent) {
                yield encoder.encode(`${JSON.stringify(convertedEvent)}\n`);
                continue;
            }
            yield typeof chunk === 'string' ? encoder.encode(chunk) : chunk;
        }
    }

    convertSseFrame(frame: string): string | null {
        const lines = splitLinesKeepingEndings(frame);
        let convertedAny = false;
        const converted = lines.map(line => {
            if (!line.content.startsWith('data:')) return line.content + line.ending;
            let payload = line.content.slice('data:'.length);
            if (payload.startsWith(' ')) payload = payload.slice(1);
            const event = this.convertEventJson(payload);
            if (!event) return line.content + line.ending;
            convertedAny = true;
            return `data: ${JSON.stringify(event)}${line.ending}`;
        });
        return convertedAny ? converted.join('') : null;
    }

    convertEventJson(payload: string): TProtocol | null {
        try {
            return this.convertToProtocol(parseAgentEvent(JSON.parse(payload)));
        } catch {
            return null;
        }
    }

    async transformResponse(response: Response): Promise<Response> {
        const contentType = response.headers.get('content-type') ?? '';
        if (!contentType.startsWith('text/event-stream') || !response.body) return response;
        const source = response.body;
        const converted = this.convertStream(source);
        const iterator = converted[Symbol.asyncIterator]();
        const body = new ReadableStream<Uint8Array>({
            async pull(controller) {
                const next = await iterator.next();
                if (next.done) controller.close();
                else controller.enqueue(next.value);
            },
            async cancel() {
                await iterator.return?.();
            },
        });
        return new Response(body, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    }

    abstract convertToProtocol(event: AgentEvent): TProtocol;
}

function splitLinesKeepingEndings(value: string): Array<{ content: string; ending: string }> {
    const result: Array<{ content: string; ending: string }> = [];
    const expression = /(.*?)(\r\n|\n|\r|$)/gs;
    for (const match of value.matchAll(expression)) {
        if (match[0] === '') break;
        result.push({ content: match[1], ending: match[2] });
    }
    return result;
}
