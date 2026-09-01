/* eslint-disable jsdoc/require-jsdoc */

import { Agent } from '../agent';
import type { AgentStream, ModelCallHookInput, ReasoningStream } from './base';
import { MiddlewareBase } from './base';
import { ReplyBudgetControlMiddleware } from './budget';
import { TTSMiddleware } from './tts';
import { QueueModel, TestTool, response } from '../agent/test-helpers';
import type { CredentialBase } from '../credential';
import { EventType } from '../event';
import { Base64Source, DataBlock, TextBlock, ToolCallBlock } from '../message';
import { ChatUsage } from '../model';
import { createPermissionDecision, PermissionBehavior } from '../permission';
import { Toolkit, ToolChoice } from '../tool';
import { TTSModelBase, TTSResponse } from '../tts';

describe('Agent middleware Python parity', () => {
    test('reply hooks follow onion order around the full event stream', async () => {
        const order: string[] = [];
        class Outer extends MiddlewareBase {
            override async *onReply(
                _agent: Agent,
                input: Parameters<MiddlewareBase['onReply']>[1],
                next: Parameters<MiddlewareBase['onReply']>[2]
            ): AgentStream {
                order.push('outer-before');
                for await (const item of next(input)) {
                    order.push(`outer-${'type' in item ? item.type : 'msg'}`);
                    yield item;
                }
                order.push('outer-after');
            }
        }
        class Inner extends MiddlewareBase {
            override async *onReply(
                _agent: Agent,
                input: Parameters<MiddlewareBase['onReply']>[1],
                next: Parameters<MiddlewareBase['onReply']>[2]
            ): AgentStream {
                order.push('inner-before');
                yield* next(input);
                order.push('inner-after');
            }
        }
        const model = new QueueModel();
        model.responses.push(response([TextBlock({ text: 'done' })]));
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            middlewares: [new Outer(), new Inner()],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply();
        expect(order.slice(0, 2)).toEqual(['outer-before', 'inner-before']);
        expect(order.slice(-2)).toEqual(['inner-after', 'outer-after']);
        expect(order).toContain(`outer-${EventType.REPLY_END}`);
    });

    test('reasoning and model-call hooks can rewrite forwarded arguments', async () => {
        class Rewrite extends MiddlewareBase {
            override async *onReasoning(
                _agent: Agent,
                _input: Parameters<MiddlewareBase['onReasoning']>[1],
                next: Parameters<MiddlewareBase['onReasoning']>[2]
            ): ReasoningStream {
                yield* next({ toolChoice: new ToolChoice({ mode: 'none' }) });
            }

            override async onModelCall(
                _agent: Agent,
                input: ModelCallHookInput,
                next: Parameters<MiddlewareBase['onModelCall']>[2]
            ) {
                const messages = structuredClone(input.messages);
                messages[0].content = [TextBlock({ text: 'rewritten' })];
                return next({ messages });
            }
        }
        const model = new QueueModel();
        model.responses.push(response([TextBlock({ text: 'done' })]));
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'original',
            model,
            middlewares: [new Rewrite()],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply();
        expect(model.calls[0].normalizedToolChoice).toEqual(new ToolChoice({ mode: 'none' }));
        expect(model.calls[0].messages).toMatchObject([
            { content: [{ type: 'text', text: 'rewritten' }] },
        ]);
    });

    test('system prompt transformers compose sequentially', async () => {
        class Suffix extends MiddlewareBase {
            constructor(private readonly suffix: string) {
                super();
            }

            override async onSystemPrompt(_agent: Agent, prompt: string): Promise<string> {
                return `${prompt}${this.suffix}`;
            }
        }
        const model = new QueueModel();
        model.responses.push(response([TextBlock({ text: 'done' })]));
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'base',
            model,
            middlewares: [new Suffix('-one'), new Suffix('-two')],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply();
        expect(model.calls[0].messages).toMatchObject([{ content: [{ text: 'base-one-two' }] }]);
    });

    test('permission middleware can short-circuit and acting middleware observes execution', async () => {
        const seen: string[] = [];
        class Hooks extends MiddlewareBase {
            override async onCheckPermission() {
                return createPermissionDecision({
                    behavior: PermissionBehavior.ALLOW,
                    message: 'middleware allow',
                });
            }

            override async *onActing(
                _agent: Agent,
                input: Parameters<MiddlewareBase['onActing']>[1],
                next: Parameters<MiddlewareBase['onActing']>[2]
            ) {
                seen.push(input.toolCall.id);
                yield* next(input);
            }
        }
        const tool = new TestTool('Ask', { decision: PermissionBehavior.ASK });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'call', name: 'Ask', input: '{"value":"ok"}' })]),
            response([TextBlock({ text: 'done' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [tool] }),
            middlewares: [new Hooks()],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply();
        expect(tool.calls).toEqual(['ok']);
        expect(seen).toEqual(['call']);
    });

    test('compression middleware can short-circuit without calling the model', async () => {
        class SkipCompression extends MiddlewareBase {
            calls = 0;
            override async onCompressContext(): Promise<void> {
                this.calls += 1;
            }
        }
        const middleware = new SkipCompression();
        const model = new QueueModel({ contextSize: 1 });
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'oversized',
            model,
            middlewares: [middleware],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.compressContext();
        expect(middleware.calls).toBe(1);
        expect(model.calls).toEqual([]);
    });

    test('budget middleware accumulates weighted usage and forces wrap-up', async () => {
        const tool = new TestTool('ReadOnly', { readOnly: true });
        const model = new QueueModel();
        model.responses.push(
            response([ToolCallBlock({ id: 'call', name: 'ReadOnly', input: '{}' })], {
                usage: new ChatUsage({ inputTokens: 3, outputTokens: 2, time: 0 }),
            }),
            response([TextBlock({ text: 'wrapped' })])
        );
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            toolkit: new Toolkit({ tools: [tool] }),
            middlewares: [
                new ReplyBudgetControlMiddleware({
                    tokenBudget: 7,
                    inputTokenWeight: 1,
                    outputTokenWeight: 2,
                }),
            ],
            injectionConfig: { injectRuntimeState: false },
        });
        await agent.reply();
        expect(model.calls.at(-1)?.normalizedToolChoice).toEqual(new ToolChoice({ mode: 'none' }));
        const hints = agent.context.flatMap(message =>
            message.content.filter(block => block.type === 'hint')
        );
        expect(hints).toHaveLength(1);
        expect(agent.state.middleContext.ReplyBudgetControlMiddleware).toEqual({});
    });

    test('TTS middleware emits one incremental audio block after assistant text', async () => {
        class FakeTTS extends TTSModelBase {
            inputs: Array<string | null | undefined> = [];
            constructor() {
                super({
                    credential: {} as CredentialBase,
                    model: 'fake',
                    parameters: {},
                    stream: false,
                    realtime: false,
                });
            }

            async synthesize(text?: string | null): Promise<TTSResponse> {
                this.inputs.push(text);
                return new TTSResponse({
                    content: DataBlock({
                        source: Base64Source({
                            data: Buffer.from('audio').toString('base64'),
                            media_type: 'audio/pcm',
                        }),
                    }),
                });
            }
        }
        const tts = new FakeTTS();
        const model = new QueueModel();
        model.responses.push(response([TextBlock({ text: 'speak' })]));
        const agent = new Agent({
            name: 'a',
            systemPrompt: 'p',
            model,
            middlewares: [new TTSMiddleware(tts)],
            injectionConfig: { injectRuntimeState: false },
        });
        const types = [];
        for await (const event of agent.replyStream()) types.push(event.type);
        expect(tts.inputs).toEqual(['speak']);
        expect(types).toEqual(
            expect.arrayContaining([
                EventType.DATA_BLOCK_START,
                EventType.DATA_BLOCK_DELTA,
                EventType.DATA_BLOCK_END,
            ])
        );
        expect(types.indexOf(EventType.DATA_BLOCK_START)).toBeGreaterThan(
            types.indexOf(EventType.TEXT_BLOCK_END)
        );
    });
});
