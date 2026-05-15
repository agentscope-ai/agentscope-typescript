import * as readline from 'readline';

import { Agent } from './agent';
import { createMsg } from '../message';
import { DashScopeChatModel } from '../model';
import { Bash, Glob, Grep, Toolkit } from '../tool';

// Enable debug logging
process.env.DEBUG = '*';
console.debug('Debug logging enabled');

const agent = new Agent({
    name: 'Friday',
    sysPrompt: 'You are a helpful assistant named Friday.',
    model: new DashScopeChatModel({
        modelName: 'qwen3-max',
        apiKey: process.env.DASHSCOPE_API_KEY || '',
    }),
    toolkit: new Toolkit({
        tools: [Bash(), Glob(), Grep()],
    }),
    compressionConfig: {
        enabled: true,
        triggerThreshold: 2100,
    },
});

const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
});

const getUserInput = (): Promise<string> => {
    return new Promise(resolve => {
        rl.question('User: ', answer => {
            resolve(answer);
        });
    });
};

/**
 * The main functions run a compression test for the agent.
 */
async function main() {
    console.log('Compression test started. Type "exit" to quit.\n');

    while (true) {
        const userInput = await getUserInput();
        if (userInput.toLowerCase() === 'exit') {
            rl.close();
            break;
        } else if (userInput.toLowerCase() === '/context') {
            console.log(JSON.stringify(agent.context, null, 2));
            continue;
        }

        const res = agent.replyStream({
            msgs: createMsg({
                name: 'user',
                content: [{ id: crypto.randomUUID(), type: 'text', text: userInput }],
                role: 'user',
            }),
        });

        for await (const event of res) {
            console.log(event);
        }
        console.log('\n');
    }
}

main().catch(console.error);
