<p align="center">
  <img
    src="https://img.alicdn.com/imgextra/i1/O1CN01nTg6w21NqT5qFKH1u_!!6000000001621-55-tps-550-550.svg"
    alt="AgentScope Logo"
    width="200"
  />
</p>

<p align="center">
    <a href="https://arxiv.org/abs/2402.14034">
        <img
            src="https://img.shields.io/badge/cs.MA-2402.14034-B31C1C?logo=arxiv&logoColor=B31C1C"
            alt="arxiv"
        />
    </a>
    <a href="https://pypi.org/project/agentscope/">
        <img
            src="https://img.shields.io/badge/node-20.0.0+-blue?logo=node.js"
            alt="npm"
        />
    </a>
    <a href="./LICENSE">
        <img
            src="https://img.shields.io/badge/license-Apache--2.0-black"
            alt="license"
        />
    </a>
</p>

## What is AgentScope?

AgentScope is a production-ready, easy-to-use agent framework with essential abstractions that work with rising model capability and built-in support for finetuning.

We design for increasingly agentic LLMs.
Our approach leverages the models' reasoning and tool use abilities
rather than constraining them with strict prompts and opinionated orchestrations.

## Why use AgentScope?

- **Simple**: start building your agents in 5 minutes with built-in ReAct agent, tools, skills, human-in-the-loop steering, memory, planning, realtime voice, evaluation and model finetuning
- **Extensible**: large number of ecosystem integrations for tools, memory and observability; built-in support for MCP and A2A; message hub for flexible multi-agent orchestration and workflows
- **Production-ready**: deploy and serve your agents locally, as serverless in the cloud, or on your K8s cluster with built-in OTel support

## Requirements

- **Node.js**: 20.0.0 or higher
- **Package Manager**: pnpm 9.0.0+ (recommended) or npm

## Features

- **Human-in-the-loop**: Built-in support for user confirmation and external execution, allowing seamless human intervention in agent workflows.

- **Event System**: Multi-agent oriented event-driven architecture for tracking agent lifecycle, tool calls, and streaming responses, designed to be frontend-friendly.

- **MCP Support**: Full integration with Model Context Protocol via both HTTP and stdio transports, enabling standardized tool communication.

- **Skill System**: Extensible skill system for adding custom capabilities with automatic schema generation and hot-reloading support.

## Quick Start

```bash
pnpm install @agentscope-ai/agentscope
# or
# npm install @agentscope-ai/agentscope
```

A quick example for using AgentScope

```typescript
import { Agent } from '@agentscope-ai/agentscope/agent';
import { OpenAIModel } from '@agentscope-ai/agentscope/model';
import { Toolkit, Bash, Read, Write } from '@agentscope-ai/agentscope/tool';

// Create a model
const model = new OpenAIModel({
    apiKey: process.env.OPENAI_API_KEY,
    model: 'gpt-4o',
});

// Create a toolkit with built-in tools
const toolkit = new Toolkit({
    tools: [Bash(), Read(), Write()],
    skills: ['/path/to/your/skills'],
    skillDirs: ['/path/to/your/skillDirs'], // Monitoring these directories
});

// Initialize an agent
const agent = new Agent({
    name: 'Friday',
    sysPrompt: 'You are a helpful assistant named Friday.',
    model: model,
    toolkit: toolkit,
});

// Use the agent
const res = await agent.reply();
console.log(res.text);

// Or, get streaming events from the agent reply
let name = '';
for await (const event of agent.replyStream({})) {
    switch (event.type) {
        case EventType.RUN_STARTED:
            name = event.name;
            break;
        case EventType.TEXT_BLOCK_START:
            process.stdout.write(`${name}: `);
            break;
        case EventType.TEXT_BLOCK_DELTA:
            process.stdout.write(event.delta);
            break;
        case EventType.TEXT_BLOCK_END:
            process.stdout.write('\n\n');
            break;
    }
}
```

## Project Structure

This is a monorepo containing:

- `packages/agentscope`: Core AgentScope library
- `packages/agentscope-service`: Node.js Agent Service runtime
- `apps/desktop`: Electron desktop application built with AgentScope

## License

AgentScope is released under Apache License 2.0.

## Contributors

All thanks to our contributors:

<a href="https://github.com/agentscope-ai/agentscope-typescript/graphs/contributors">
  <img src="https://contrib.rocks/image?repo=agentscope-ai/agentscope-typescirpt&max=999&columns=12&anon=1" />
</a>
