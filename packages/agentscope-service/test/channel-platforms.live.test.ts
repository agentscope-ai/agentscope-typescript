/* eslint-disable jsdoc/require-jsdoc */

import {
    NativeDingTalkStreamTransport,
    OfficialDiscordDriver,
    OfficialFeishuDriver,
    type DingTalkStreamTransport,
    type DiscordPlatformDriver,
    type FeishuPlatformDriver,
} from '../src/channel';

jest.setTimeout(45_000);

const describeDingTalk =
    process.env.DINGTALK_CLIENT_ID && process.env.DINGTALK_CLIENT_SECRET ? describe : describe.skip;
const describeFeishu =
    process.env.FEISHU_APP_ID && process.env.FEISHU_APP_SECRET ? describe : describe.skip;
const describeDiscord =
    process.env.DISCORD_BOT_TOKEN && process.env.DISCORD_APPLICATION_ID ? describe : describe.skip;

describeDingTalk('DingTalk live connection', () => {
    test('authenticates and opens the Stream gateway', async () => {
        const transport = new NativeDingTalkStreamTransport({
            clientId: process.env.DINGTALK_CLIENT_ID!,
            clientSecret: process.env.DINGTALK_CLIENT_SECRET!,
        });
        await expectDingTalkConnected(transport);
    });
});

describeFeishu('Feishu live connection', () => {
    test('authenticates and opens the official SDK WebSocket', async () => {
        const driver = new OfficialFeishuDriver({
            appId: process.env.FEISHU_APP_ID!,
            appSecret: process.env.FEISHU_APP_SECRET!,
            onlyAtReply: true,
        });
        await expectFeishuConnected(driver);
    });
});

describeDiscord('Discord live connection', () => {
    test('authenticates and reaches gateway ready', async () => {
        const driver = new OfficialDiscordDriver(
            process.env.DISCORD_BOT_TOKEN!,
            process.env.DISCORD_APPLICATION_ID!
        );
        await expectDiscordConnected(driver);
    });
});

async function expectDingTalkConnected(transport: DingTalkStreamTransport): Promise<void> {
    const controller = new AbortController();
    let markConnected: () => void = () => {};
    const connected = new Promise<void>(resolve => {
        markConnected = resolve;
    });
    const listening = transport.listen(
        {
            onMessage: async () => {},
            onCardAction: async () => {},
            onState: state => {
                if (state === 'connected') markConnected();
            },
        },
        controller.signal
    );
    try {
        await Promise.race([connected, failAfter(30_000), rejectIfEnded(listening)]);
    } finally {
        controller.abort();
        await transport.close();
        await listening.catch(() => {});
    }
}

async function expectFeishuConnected(driver: FeishuPlatformDriver): Promise<void> {
    const controller = new AbortController();
    let markConnected: () => void = () => {};
    const connected = new Promise<void>(resolve => {
        markConnected = resolve;
    });
    const listening = driver.listen(
        {
            onMessage: async () => {},
            onCardAction: async () => ({}),
            onState: state => {
                if (state === 'connected') markConnected();
            },
        },
        controller.signal
    );
    try {
        await Promise.race([connected, failAfter(30_000), rejectIfEnded(listening)]);
    } finally {
        controller.abort();
        await driver.close();
        await listening.catch(() => {});
    }
}

async function expectDiscordConnected(driver: DiscordPlatformDriver): Promise<void> {
    const controller = new AbortController();
    let markConnected: () => void = () => {};
    const connected = new Promise<void>(resolve => {
        markConnected = resolve;
    });
    const listening = driver.listen(
        {
            onMessage: async () => {},
            onApproval: async () => {},
            onReady: markConnected,
        },
        controller.signal
    );
    try {
        await Promise.race([connected, failAfter(30_000), rejectIfEnded(listening)]);
    } finally {
        controller.abort();
        await driver.close();
        await listening.catch(() => {});
    }
}

function failAfter(milliseconds: number): Promise<never> {
    return new Promise((_, reject) => {
        const timer = setTimeout(
            () => reject(new Error(`Platform did not connect within ${milliseconds}ms`)),
            milliseconds
        );
        timer.unref();
    });
}

async function rejectIfEnded(listening: Promise<void>): Promise<never> {
    await listening;
    throw new Error('Platform listener ended before connecting');
}
