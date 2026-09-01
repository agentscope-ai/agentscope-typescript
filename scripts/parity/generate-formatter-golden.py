#!/usr/bin/env python3
"""Generate formatter outputs from the pinned Python implementation."""

import argparse
import asyncio
import json
import re
import subprocess
from pathlib import Path
from typing import Any

from agentscope.formatter import (
    AnthropicChatFormatter,
    AnthropicMultiAgentFormatter,
    DashScopeChatFormatter,
    DashScopeMultiAgentFormatter,
    DeepSeekChatFormatter,
    DeepSeekMultiAgentFormatter,
    GeminiChatFormatter,
    GeminiMultiAgentFormatter,
    MoonshotChatFormatter,
    MoonshotMultiAgentFormatter,
    OllamaChatFormatter,
    OllamaMultiAgentFormatter,
    OpenAIChatFormatter,
    OpenAIMultiAgentFormatter,
    OpenAIResponseFormatter,
    OpenAIResponseMultiAgentFormatter,
)
from agentscope.message import (
    Base64Source,
    DataBlock,
    HintBlock,
    Msg,
    TextBlock,
    ThinkingBlock,
    ToolCallBlock,
    ToolResultBlock,
)

CREATED_AT = "2026-01-02T03:04:05.000Z"


def _normalize(value: Any) -> Any:
    if isinstance(value, str):
        return re.sub(
            r"saved locally at: [^<]+(?=\.</system-reminder>)",
            "saved locally at: <TEMP_FILE>",
            value,
        )
    if isinstance(value, list):
        return [_normalize(item) for item in value]
    if isinstance(value, dict):
        return {key: _normalize(item) for key, item in value.items()}
    return value


def _text(identifier: str, text: str) -> TextBlock:
    return TextBlock(id=identifier, created_at=CREATED_AT, text=text)


def _messages() -> tuple[list[Msg], list[Msg]]:
    image = DataBlock(
        id="image-1",
        created_at=CREATED_AT,
        source=Base64Source(
            media_type="image/png",
            data="aW1hZ2U=",
        ),
    )
    chat = [
        Msg(
            id="msg-system",
            created_at=CREATED_AT,
            name="system",
            role="system",
            content=[_text("text-system", "Follow instructions.")],
        ),
        Msg(
            id="msg-assistant",
            created_at=CREATED_AT,
            name="assistant",
            role="assistant",
            content=[
                ThinkingBlock(
                    id="thinking-1",
                    created_at=CREATED_AT,
                    thinking="Reasoning",
                    signature="signed",
                    reasoning_item_id="reasoning-1",
                ),
                _text("text-answer", "Answer"),
                HintBlock(
                    id="hint-1",
                    created_at=CREATED_AT,
                    finished_at=CREATED_AT,
                    hint="Continue now",
                ),
                ToolCallBlock(
                    id="call-1",
                    created_at=CREATED_AT,
                    name="search",
                    input='{"query":"agent"}',
                ),
                ToolResultBlock(
                    id="call-1",
                    created_at=CREATED_AT,
                    name="search",
                    output=[_text("result-text", "Found"), image],
                ),
            ],
        ),
    ]
    multi = [
        Msg(
            id="multi-system",
            created_at=CREATED_AT,
            name="system",
            role="system",
            content=[_text("multi-system-text", "Coordinate.")],
        ),
        Msg(
            id="multi-alice",
            created_at=CREATED_AT,
            name="alice",
            role="user",
            content=[_text("multi-alice-text", "Question")],
        ),
        Msg(
            id="multi-bob",
            created_at=CREATED_AT,
            name="bob",
            role="assistant",
            content=[_text("multi-bob-text", "Reply")],
        ),
    ]
    return chat, multi


async def _generate() -> dict[str, Any]:
    chat, multi = _messages()
    formatters = {
        "openai_chat": (OpenAIChatFormatter(), chat),
        "openai_multi": (OpenAIMultiAgentFormatter(), multi),
        "anthropic_chat": (AnthropicChatFormatter(), chat),
        "anthropic_multi": (AnthropicMultiAgentFormatter(), multi),
        "gemini_chat": (GeminiChatFormatter(), chat),
        "gemini_multi": (GeminiMultiAgentFormatter(), multi),
        "moonshot_chat": (MoonshotChatFormatter(), chat),
        "moonshot_multi": (MoonshotMultiAgentFormatter(), multi),
        "ollama_chat": (OllamaChatFormatter(), chat),
        "ollama_multi": (OllamaMultiAgentFormatter(), multi),
        "dashscope_chat": (
            DashScopeChatFormatter(
                input_types=[
                    "text/plain",
                    "image/*",
                    "audio/*",
                    "video/*",
                    "application/x-thinking",
                ],
            ),
            chat,
        ),
        "dashscope_multi": (DashScopeMultiAgentFormatter(), multi),
        "deepseek_chat": (DeepSeekChatFormatter(), chat),
        "deepseek_multi": (DeepSeekMultiAgentFormatter(), multi),
        "openai_response": (OpenAIResponseFormatter(), chat),
        "openai_response_multi": (
            OpenAIResponseMultiAgentFormatter(),
            multi,
        ),
    }
    outputs = {}
    for name, (formatter, messages) in formatters.items():
        outputs[name] = _normalize(await formatter.format(messages))
    return {
        "chat_messages": [msg.model_dump(mode="json") for msg in chat],
        "multi_messages": [msg.model_dump(mode="json") for msg in multi],
        "outputs": outputs,
    }


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    payload = asyncio.run(_generate())
    payload["python_commit"] = subprocess.run(
        ["git", "rev-parse", "HEAD"],
        check=True,
        capture_output=True,
        text=True,
    ).stdout.strip()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(
        f"{json.dumps(payload, indent=2, ensure_ascii=False)}\n",
        encoding="utf-8",
    )


if __name__ == "__main__":
    main()
