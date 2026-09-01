/* eslint-disable jsdoc/require-jsdoc */

import type { ReplyOptions } from '../agent';
import {
    EventType,
    createEvent,
    type AgentEvent,
    type UserConfirmResultEvent,
    type UserInterruptEvent,
} from '../event';
import { AssistantMsg, ToolCallBlock, UserMsg, getTextContent, type Msg } from '../message';
import { ReplyFinishedReason } from '../type';
import { GoalPipeline, type GoalPipelineAgent } from './goal';

function report(text = '已完成，见 main.py'): Msg {
    return AssistantMsg({
        name: 'executor',
        content: [],
        finished_reason: ReplyFinishedReason.COMPLETED,
        structured_output: { report: text },
    });
}

function verdict(result: string, message = ''): Msg {
    return AssistantMsg({
        name: 'verifier',
        content: [],
        finished_reason: ReplyFinishedReason.COMPLETED,
        structured_output: { result, message },
    });
}

function noOutput(name: string): Msg {
    return AssistantMsg({
        name,
        content: [],
        finished_reason: ReplyFinishedReason.COMPLETED,
    });
}

function confirmRequest(replyId = 'executor-reply'): AgentEvent {
    return createEvent({
        type: EventType.REQUIRE_USER_CONFIRM,
        reply_id: replyId,
        tool_calls: [ToolCallBlock({ id: 'call-1', name: 'write_file', input: '{}' })],
    });
}

class StubAgent implements GoalPipelineAgent {
    readonly state: { replyId: string };
    readonly received: ReplyOptions['inputs'][] = [];
    readonly schemas: unknown[] = [];

    constructor(
        readonly name: string,
        private readonly script: Array<Array<AgentEvent | Msg>>
    ) {
        this.state = { replyId: name + '-reply' };
    }

    async *replyStream(
        options: ReplyOptions & { yieldFinalMsg: true }
    ): AsyncGenerator<AgentEvent | Msg> {
        this.received.push(options.inputs);
        this.schemas.push(options.structuredSchema);
        const index = Math.min(this.received.length - 1, this.script.length - 1);
        for (const chunk of this.script[index]) {
            if (!isMessage(chunk) || options.yieldFinalMsg) yield chunk;
        }
    }
}

describe('GoalPipeline Python parity', () => {
    const query = (): Msg => UserMsg({ name: 'user', content: '写一个爬虫' });

    test('passes on the first round and gives verifier goal plus report', async () => {
        const executor = new StubAgent('executor', [[report('见 main.py')]]);
        const verifier = new StubAgent('verifier', [[verdict('pass')]]);
        const pipeline = new GoalPipeline(executor, verifier);

        const yielded = await collect(pipeline.replyStream(query()));

        expect(yielded.map(item => (isMessage(item) ? item.structured_output : null))).toEqual([
            { report: '见 main.py' },
        ]);
        expect(getTextContent(verifier.received[0] as Msg)).toContain('写一个爬虫');
        expect(getTextContent(verifier.received[0] as Msg)).toContain('见 main.py');
        expect(executor.schemas[0]).toBeDefined();
        expect(verifier.schemas[0]).toBeDefined();
        expect(pipeline.verifier_reset_context).toBe(true);
        expect(pipeline.max_iters).toBe(10);
        expect(pipeline.max_retries).toBe(3);
    });

    test('feeds refusal back verbatim and retries', async () => {
        const executor = new StubAgent('executor', [[report()], [report()]]);
        const verifier = new StubAgent('verifier', [
            [verdict('fail', '缺 requirements.txt')],
            [verdict('pass')],
        ]);
        const pipeline = new GoalPipeline({ executor, verifier });

        await collect(pipeline.replyStream({ inputs: query() }));

        expect(executor.received).toHaveLength(2);
        expect(getTextContent(executor.received[1] as Msg)).toContain('缺 requirements.txt');
    });

    test('stops at maxIters', async () => {
        const executor = new StubAgent('executor', [[report()]]);
        const verifier = new StubAgent('verifier', [[verdict('fail', '还是不行')]]);
        const pipeline = new GoalPipeline({ executor, verifier, maxIters: 2 });

        await collect(pipeline.replyStream(query()));

        expect(executor.received).toHaveLength(2);
        expect(verifier.received).toHaveLength(2);
    });

    test('impossible settles without retrying', async () => {
        const executor = new StubAgent('executor', [[report()]]);
        const verifier = new StubAgent('verifier', [[verdict('impossible', '目标自相矛盾')]]);
        await collect(new GoalPipeline(executor, verifier).replyStream(query()));
        expect(executor.received).toHaveLength(1);
        expect(verifier.received).toHaveLength(1);
    });

    test('reprompts verifier when structured output is missing', async () => {
        const executor = new StubAgent('executor', [[report()]]);
        const verifier = new StubAgent('verifier', [[noOutput('verifier')], [verdict('pass')]]);
        await collect(new GoalPipeline(executor, verifier).replyStream(query()));

        expect(verifier.received).toHaveLength(2);
        expect(getTextContent(verifier.received[1] as Msg)).toContain('GenerateStructuredOutput');
        expect(executor.received).toHaveLength(1);
    });

    test('reprompts executor when execution report is missing', async () => {
        const executor = new StubAgent('executor', [[noOutput('executor')], [report()]]);
        const verifier = new StubAgent('verifier', [[verdict('pass')]]);
        await collect(new GoalPipeline(executor, verifier).replyStream(query()));

        expect(executor.received).toHaveLength(2);
        expect(getTextContent(executor.received[1] as Msg)).toContain('GenerateStructuredOutput');
        expect(verifier.received).toHaveLength(1);
    });

    test('parked executor is not verified', async () => {
        const request = confirmRequest();
        const executor = new StubAgent('executor', [[request]]);
        const verifier = new StubAgent('verifier', [[verdict('pass')]]);
        const yielded = await collect(new GoalPipeline(executor, verifier).replyStream(query()));

        expect(yielded).toEqual([request]);
        expect(verifier.received).toEqual([]);
    });

    test('routes a confirmation result back to the parked agent', async () => {
        const request = confirmRequest() as Extract<
            AgentEvent,
            { type: EventType.REQUIRE_USER_CONFIRM }
        >;
        const executor = new StubAgent('executor', [[request], [report()]]);
        const verifier = new StubAgent('verifier', [[verdict('pass')]]);
        const pipeline = new GoalPipeline(executor, verifier);
        await collect(pipeline.replyStream(query()));
        const answer = createEvent({
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: 'executor-reply',
            confirm_results: [{ confirmed: true, tool_call: request.tool_calls[0] }],
        }) as UserConfirmResultEvent;

        await collect(pipeline.replyStream(answer));

        expect(executor.received[1]).toBe(answer);
        expect(verifier.received).toHaveLength(1);
    });

    test('HITL resume keeps the existing iteration budget', async () => {
        const executor = new StubAgent('executor', [[report()], [confirmRequest()], [report()]]);
        const verifier = new StubAgent('verifier', [
            [verdict('fail', '不行')],
            [verdict('fail', '还是不行')],
        ]);
        const pipeline = new GoalPipeline({ executor, verifier, max_iters: 2 });
        await collect(pipeline.replyStream(query()));
        await collect(
            pipeline.replyStream(
                createEvent({
                    type: EventType.USER_CONFIRM_RESULT,
                    reply_id: 'executor-reply',
                    confirm_results: [],
                }) as UserConfirmResultEvent
            )
        );

        expect(executor.received).toHaveLength(3);
        expect(verifier.received).toHaveLength(2);
    });

    test('rejects a continuation with an unknown reply id', async () => {
        const pipeline = new GoalPipeline(
            new StubAgent('executor', [[report()]]),
            new StubAgent('verifier', [[verdict('pass')]])
        );
        const answer = createEvent({
            type: EventType.USER_CONFIRM_RESULT,
            reply_id: 'nobody',
            confirm_results: [],
        }) as UserConfirmResultEvent;

        await expect(collect(pipeline.replyStream(answer))).rejects.toThrow(
            'Invalid inputs with reply_id: nobody'
        );
    });

    test('routes user interruption to whichever agent is parked', async () => {
        const executor = new StubAgent('executor', [[report()]]);
        const interrupted = AssistantMsg({
            name: 'verifier',
            content: 'interrupted',
            finished_reason: ReplyFinishedReason.INTERRUPTED,
        });
        const verifier = new StubAgent('verifier', [[interrupted]]);
        const pipeline = new GoalPipeline(executor, verifier);
        const event = createEvent({
            type: EventType.USER_INTERRUPT,
            reply_id: 'verifier-reply',
        }) as UserInterruptEvent;

        const yielded = await collect(pipeline.replyStream(event));

        expect(verifier.received).toEqual([event]);
        expect(yielded).toEqual([interrupted]);
        expect(executor.received).toEqual([]);
    });
});

async function collect(
    stream: AsyncGenerator<AgentEvent | Msg, void>
): Promise<Array<AgentEvent | Msg>> {
    const values: Array<AgentEvent | Msg> = [];
    for await (const value of stream) values.push(value);
    return values;
}

function isMessage(value: AgentEvent | Msg): value is Msg {
    return 'role' in value && 'content' in value;
}
