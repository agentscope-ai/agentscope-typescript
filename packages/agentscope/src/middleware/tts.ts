/* eslint-disable jsdoc/require-jsdoc */

import { _generateId } from '../_utils';
import type { Agent } from '../agent';
import { createEvent, EventType } from '../event';
import type { AgentEvent, DataBlockStartEvent } from '../event';
import type { TTSModelBase, TTSResponse } from '../tts';
import { MiddlewareBase } from './base';
import type { AgentStream, ReplyHookInput } from './base';

/** Convert assistant text-stream events into incremental audio events. */
export class TTSMiddleware extends MiddlewareBase {
    readonly tts: TTSModelBase;

    constructor(ttsModel: TTSModelBase) {
        super();
        this.tts = ttsModel;
    }

    override async *onReply(
        agent: Agent,
        input: ReplyHookInput,
        next: (input?: Partial<ReplyHookInput>) => AgentStream
    ): AgentStream {
        let textBuffer = '';
        let audioBlockId: string | null = null;
        let audioMediaType: string | null = null;
        if (this.tts.realtime) await this.tts.connect();
        try {
            for await (const item of next(input)) {
                yield item;
                if (!('type' in item)) continue;
                if (item.type === EventType.TEXT_BLOCK_DELTA) {
                    textBuffer += item.delta;
                    if (this.tts.realtime && item.delta) {
                        const response = await this.tts.push(item.delta);
                        const events = emitChunk(agent, response, audioBlockId, audioMediaType);
                        const start = events.find(
                            (event): event is DataBlockStartEvent =>
                                event.type === EventType.DATA_BLOCK_START
                        );
                        if (start) {
                            audioBlockId = start.block_id;
                            audioMediaType = start.media_type;
                        }
                        for (const event of events) yield event;
                    }
                } else if (item.type === EventType.TEXT_BLOCK_END) {
                    const text = textBuffer;
                    textBuffer = '';
                    if (this.tts.realtime || text.trim()) {
                        const result = await this.tts.synthesize(
                            this.tts.realtime ? undefined : text
                        );
                        for await (const response of normalizeTTSResult(result)) {
                            const events = emitChunk(agent, response, audioBlockId, audioMediaType);
                            const start = events.find(
                                (event): event is DataBlockStartEvent =>
                                    event.type === EventType.DATA_BLOCK_START
                            );
                            if (start) {
                                audioBlockId = start.block_id;
                                audioMediaType = start.media_type;
                            }
                            for (const event of events) yield event;
                        }
                    }
                    if (audioBlockId) {
                        yield createEvent({
                            type: EventType.DATA_BLOCK_END,
                            reply_id: agent.state.replyId,
                            block_id: audioBlockId,
                        });
                    }
                    audioBlockId = null;
                    audioMediaType = null;
                }
            }
        } finally {
            if (this.tts.realtime) await this.tts.close();
        }
    }
}

async function* normalizeTTSResult(
    result: TTSResponse | AsyncGenerator<TTSResponse, void>
): AsyncGenerator<TTSResponse, void> {
    if (isAsyncIterable(result)) yield* result;
    else yield result;
}

function emitChunk(
    agent: Agent,
    response: TTSResponse | null,
    audioBlockId: string | null,
    audioMediaType: string | null
): AgentEvent[] {
    const source = response?.content?.source;
    if (!source || source.type !== 'base64' || !source.data) return [];
    const events: AgentEvent[] = [];
    const blockId = audioBlockId ?? _generateId();
    const mediaType = audioMediaType ?? source.media_type;
    if (!audioBlockId) {
        events.push(
            createEvent({
                type: EventType.DATA_BLOCK_START,
                reply_id: agent.state.replyId,
                block_id: blockId,
                media_type: mediaType,
            })
        );
    }
    events.push(
        createEvent({
            type: EventType.DATA_BLOCK_DELTA,
            reply_id: agent.state.replyId,
            block_id: blockId,
            data: source.data,
            media_type: mediaType,
        })
    );
    return events;
}

function isAsyncIterable(value: unknown): value is AsyncGenerator<TTSResponse, void> {
    return typeof value === 'object' && value !== null && Symbol.asyncIterator in value;
}
