/* eslint-disable jsdoc/require-jsdoc */

import { EventType, type AgentEvent } from '../event';
import {
    AssistantMsg,
    appendEvent,
    type DataBlock,
    type Msg,
    type ToolCallBlock,
    type ToolResultBlock,
} from '../message';
import { FinishedReason } from '../model';
import { ReplyFinishedReason } from '../type';

export type ConsoleVerbosity = 'quiet' | 'default' | 'debug';

export interface ConsoleWriter {
    write(text: string): void;
}

export interface ConsoleRendererOptions {
    verbosity?: ConsoleVerbosity;
    maxToolResultLines?: number | null;
    max_tool_result_lines?: number | null;
    writer?: ConsoleWriter;
}

const VERBOSITY_LEVELS: Record<ConsoleVerbosity, number> = {
    quiet: 0,
    default: 1,
    debug: 2,
};

const RESULT_STATE_ICONS: Record<string, string> = {
    success: '✓',
    error: '✗',
    denied: '⊘',
    interrupted: '⚠',
    running: '…',
};

/** Render AgentScope event streams as readable line-based terminal output. */
export class ConsoleRenderer {
    verbosity: ConsoleVerbosity;
    maxToolResultLines: number | null;
    readonly writer: ConsoleWriter;
    private message: Msg | null = null;
    private midStream = false;

    constructor(options?: ConsoleRendererOptions);
    constructor(
        verbosity?: ConsoleVerbosity,
        maxToolResultLines?: number | null,
        writer?: ConsoleWriter
    );
    constructor(
        optionsOrVerbosity: ConsoleRendererOptions | ConsoleVerbosity = {},
        positionalMaxToolResultLines: number | null = 20,
        positionalWriter?: ConsoleWriter
    ) {
        const options: ConsoleRendererOptions =
            typeof optionsOrVerbosity === 'string'
                ? {
                      verbosity: optionsOrVerbosity,
                      maxToolResultLines: positionalMaxToolResultLines,
                      writer: positionalWriter,
                  }
                : optionsOrVerbosity;
        this.verbosity = options.verbosity ?? 'default';
        this.maxToolResultLines = options.maxToolResultLines ?? options.max_tool_result_lines ?? 20;
        this.writer = options.writer ?? { write: text => process.stdout.write(text) };
    }

    get lastMsg(): Msg | null {
        return this.message;
    }

    get last_msg(): Msg | null {
        return this.lastMsg;
    }

    get max_tool_result_lines(): number | null {
        return this.maxToolResultLines;
    }

    set max_tool_result_lines(value: number | null) {
        this.maxToolResultLines = value;
    }

    render(event: AgentEvent): void {
        this.accumulate(event);
        switch (event.type) {
            case EventType.REPLY_START:
                if (this.show(1)) this.line('──────── ' + event.name + ' ────────');
                break;
            case EventType.THINKING_BLOCK_START:
                if (this.show(1)) {
                    this.breakLine();
                    this.line('✻ Thinking…');
                }
                break;
            case EventType.THINKING_BLOCK_DELTA:
                this.stream(event.delta);
                break;
            case EventType.THINKING_BLOCK_END:
                if (this.show(1)) {
                    this.breakLine();
                    this.line();
                }
                break;
            case EventType.TEXT_BLOCK_DELTA:
                this.stream(event.delta, true);
                break;
            case EventType.TEXT_BLOCK_END:
                this.breakLine(true);
                break;
            case EventType.TOOL_CALL_END:
                this.renderToolCall(event.tool_call_id);
                break;
            case EventType.TOOL_RESULT_END:
                this.renderToolResult(event.tool_call_id, event.metadata);
                break;
            case EventType.DATA_BLOCK_END:
                this.renderDataBlock(event.block_id);
                break;
            case EventType.MODEL_CALL_START:
                this.debugLine('model call → ' + event.model_name);
                break;
            case EventType.MODEL_CALL_END:
                this.renderModelCallEnd(event);
                break;
            case EventType.HINT_BLOCK:
                this.renderHint(event.hint, event.source);
                break;
            case EventType.REQUIRE_USER_CONFIRM:
                this.renderHitl(event.tool_calls, 'Tool calls awaiting user confirmation:');
                break;
            case EventType.REQUIRE_EXTERNAL_EXECUTION:
                this.renderHitl(event.tool_calls, 'Tool calls awaiting external execution:');
                break;
            case EventType.REPLY_END:
                this.renderReplyEnd(event);
                break;
            default:
                if (!event.type.endsWith('_DELTA')) this.debugLine(event.type);
        }
    }

    private accumulate(event: AgentEvent): void {
        if (!('reply_id' in event)) return;
        if (event.type === EventType.REPLY_START) {
            this.message = AssistantMsg({ name: event.name, content: [], id: event.reply_id });
        } else if (!this.message || this.message.id !== event.reply_id) {
            this.message = AssistantMsg({ name: 'agent', content: [], id: event.reply_id });
        }
        appendEvent(this.message, event);
    }

    private show(level: number): boolean {
        return VERBOSITY_LEVELS[this.verbosity] >= level;
    }

    private write(text: string): void {
        this.writer.write(text);
    }

    private line(text = ''): void {
        this.write(text + '\n');
    }

    private breakLine(quietOk = false): void {
        if (!(quietOk || this.show(1))) return;
        if (this.midStream) {
            this.line();
            this.midStream = false;
        }
    }

    private stream(delta: string, quietOk = false): void {
        if (!(quietOk || this.show(1))) return;
        this.write(delta);
        this.midStream = true;
    }

    private debugLine(text: string): void {
        if (!this.show(2)) return;
        this.breakLine();
        this.line('· ' + text);
    }

    private findBlock(type: string, id: string): Msg['content'][number] | null {
        return this.message?.content.find(block => block.type === type && block.id === id) ?? null;
    }

    private renderToolCall(toolCallId: string): void {
        if (!this.show(1)) return;
        const block = this.findBlock('tool_call', toolCallId) as ToolCallBlock | null;
        if (!block || block.type !== 'tool_call') return;
        this.breakLine();
        const input = formatToolInput(block.input);
        if (input.includes('\n')) {
            this.line('→ ' + block.name);
            for (const line of input.split('\n')) this.line('  ' + line);
        } else {
            this.line('→ ' + block.name + ' ' + input);
        }
    }

    private renderToolResult(toolCallId: string, metadata?: Record<string, unknown>): void {
        if (!this.show(1)) return;
        const block = this.findBlock('tool_result', toolCallId) as ToolResultBlock | null;
        if (!block || block.type !== 'tool_result') return;
        this.breakLine();
        this.line(
            (RESULT_STATE_ICONS[block.state] ?? '•') + ' ' + block.name + ' · ' + block.state
        );
        const text = this.formatResultOutput(block);
        let lines = text.split('\n');
        if (!text) lines = [];
        let truncated = 0;
        if (this.maxToolResultLines !== null && lines.length > this.maxToolResultLines) {
            truncated = lines.length - this.maxToolResultLines;
            lines = lines.slice(0, this.maxToolResultLines);
        }
        for (const line of lines) this.line('  ' + line);
        if (truncated) this.line('  … (+' + truncated + ' more lines)');
        if (this.show(2) && metadata && Object.keys(metadata).length) {
            this.line('  metadata: ' + inspectValue(metadata));
        }
        this.line();
    }

    private formatResultOutput(block: ToolResultBlock): string {
        if (typeof block.output === 'string') return block.output;
        return block.output
            .map(item => (item.type === 'text' ? item.text : this.dataPlaceholder(item)))
            .join('\n');
    }

    private dataPlaceholder(block: DataBlock): string {
        if (block.source.type === 'base64') {
            const size = humanSize(Math.floor((block.source.data.length * 3) / 4));
            return '[data: ' + block.source.media_type + ', ~' + size + ']';
        }
        return '[data: ' + block.source.media_type + ', ' + block.source.url + ']';
    }

    private renderDataBlock(blockId: string): void {
        if (!this.show(1)) return;
        const block = this.findBlock('data', blockId);
        if (block?.type !== 'data') return;
        this.breakLine();
        this.line(this.dataPlaceholder(block));
    }

    private renderModelCallEnd(
        event: Extract<AgentEvent, { type: EventType.MODEL_CALL_END }>
    ): void {
        if (!this.show(1)) return;
        let note = 'tokens: ' + event.input_tokens + ' in / ' + event.output_tokens + ' out';
        if (event.finished_reason && event.finished_reason !== FinishedReason.COMPLETED) {
            note += ' · ' + event.finished_reason;
        }
        this.breakLine();
        this.line('· ' + note);
    }

    private renderHint(
        hint: Extract<AgentEvent, { type: EventType.HINT_BLOCK }>['hint'],
        source?: string | null
    ): void {
        if (!this.show(1)) return;
        const text =
            typeof hint === 'string'
                ? hint
                : hint
                      .map(item => (item.type === 'text' ? item.text : this.dataPlaceholder(item)))
                      .join('\n');
        this.breakLine();
        this.line('┌─ ◈ hint' + (source ? ' from ' + source : ''));
        for (const line of text.split('\n')) this.line('│ ' + line);
        this.line('└─');
    }

    private renderHitl(toolCalls: ToolCallBlock[], title: string): void {
        if (!this.show(1)) return;
        this.breakLine();
        this.line('⚠ ' + title);
        for (const toolCall of toolCalls) {
            this.line('  • ' + toolCall.name + ' ' + formatToolInput(toolCall.input));
            for (const rule of toolCall.suggested_rules ?? []) {
                const pattern = rule.rule_content ? '(' + rule.rule_content + ')' : '';
                this.line('    suggested rule: ' + rule.behavior + ' ' + rule.tool_name + pattern);
            }
        }
    }

    private renderReplyEnd(event: Extract<AgentEvent, { type: EventType.REPLY_END }>): void {
        this.breakLine(true);
        if (event.error) {
            this.line('✗ Error (' + event.error.type + '): ' + event.error.message);
        } else if (event.finished_reason === ReplyFinishedReason.INTERRUPTED && this.show(1)) {
            this.line('⚠ Reply interrupted by the user.');
        } else if (event.finished_reason === ReplyFinishedReason.EXCEED_MAX_ITERS && this.show(1)) {
            this.line('⚠ Exceeded the maximum reasoning-acting iterations.');
        }
        this.debugLine('reply end · ' + event.finished_reason);
    }
}

export function humanSize(bytes: number): string {
    let size = bytes;
    for (const unit of ['B', 'KB', 'MB']) {
        if (size < 1024) return Math.round(size) + unit;
        size /= 1024;
    }
    return size.toFixed(1) + 'GB';
}

export function formatToolInput(rawInput: string): string {
    const raw = rawInput.trim();
    if (!raw) return '{}';
    let value: unknown;
    try {
        value = JSON.parse(raw);
    } catch {
        return raw;
    }
    const compact = pythonStyleJson(value);
    return compact.length <= 72 ? compact : JSON.stringify(value, null, 2);
}

function pythonStyleJson(value: unknown): string {
    const raw = JSON.stringify(value);
    let output = '';
    let inString = false;
    let escaped = false;
    for (const character of raw) {
        output += character;
        if (escaped) {
            escaped = false;
        } else if (character === '\\' && inString) {
            escaped = true;
        } else if (character === '"') {
            inString = !inString;
        } else if (!inString && (character === ':' || character === ',')) {
            output += ' ';
        }
    }
    return output;
}

function inspectValue(value: unknown): string {
    try {
        return JSON.stringify(value);
    } catch {
        return String(value);
    }
}
