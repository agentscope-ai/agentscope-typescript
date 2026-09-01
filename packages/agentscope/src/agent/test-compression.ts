import * as readline from 'readline';

import { Agent } from './agent';
import { _generateId, _generateTimestamp } from '../_utils/common';
import { createMsg } from '../message/message';
import { DashScopeChatModel } from '../model/dashscope-model';
import { Bash } from '../tool/bash';
import { Glob } from '../tool/glob';
import { Grep } from '../tool/grep';
import { Toolkit } from '../tool/toolkit';

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
                content: [
                    {
                        id: _generateId(),
                        type: 'text',
                        text: userInput,
                        created_at: _generateTimestamp(),
                    },
                ],
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
