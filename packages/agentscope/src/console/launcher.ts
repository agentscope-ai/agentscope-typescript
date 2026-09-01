/* eslint-disable jsdoc/require-jsdoc */

import type { ReplyOptions } from '../agent';
import {
    EventType,
    createEvent,
    type AgentEvent,
    type RequireUserConfirmEvent,
    type UserConfirmResultEvent,
    type UserInterruptEvent,
} from '../event';
import { UserMsg, type Msg } from '../message';
import { ConsoleRenderer, type ConsoleVerbosity } from './renderer';

export interface ConsoleReplyTarget {
    replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent | Msg, unknown>;
}

export interface ConsoleInput {
    question(prompt: string): Promise<string>;
    close(): void | Promise<void>;
}

export interface LaunchConsoleOptions {
    userName?: string;
    user_name?: string;
    verbosity?: ConsoleVerbosity;
    maxToolResultLines?: number | null;
    max_tool_result_lines?: number | null;
    renderer?: ConsoleRenderer;
    input?: ConsoleInput;
}

export async function runConsoleReply(
    target: ConsoleReplyTarget,
    renderer: ConsoleRenderer,
    inputs: NonNullable<ReplyOptions['inputs']>,
    signal?: AbortSignal
): Promise<RequireUserConfirmEvent | null> {
    let pending: RequireUserConfirmEvent | null = null;
    const iterator = target.replyStream({ inputs, signal });
    try {
        while (true) {
            const item = await iterator.next();
            if (item.done) break;
            if (isMessage(item.value)) continue;
            renderer.render(item.value);
            if (item.value.type === EventType.REQUIRE_USER_CONFIRM) pending = item.value;
        }
    } catch (error) {
        if (!signal?.aborted && !isCancellationError(error)) throw error;
    } finally {
        await iterator.return(undefined);
    }
    return pending;
}

export async function confirmToolCalls(
    pending: RequireUserConfirmEvent,
    input: ConsoleInput
): Promise<UserConfirmResultEvent> {
    const results: UserConfirmResultEvent['confirm_results'] = [];
    for (const toolCall of pending.tool_calls) {
        const suggestedRules = toolCall.suggested_rules ?? [];
        let prompt = "Allow '" + toolCall.name + "'? [y]es / [N]o";
        if (suggestedRules.length) prompt += ' / [a]lways';
        const answer = (await input.question(prompt + ' ')).trim().toLowerCase();
        const always = suggestedRules.length > 0 && (answer === 'a' || answer === 'always');
        results.push({
            confirmed: always || answer === 'y' || answer === 'yes',
            tool_call: toolCall,
            rules: always ? suggestedRules : null,
        });
    }
    return createEvent({
        type: EventType.USER_CONFIRM_RESULT,
        reply_id: pending.reply_id,
        confirm_results: results,
    }) as UserConfirmResultEvent;
}

/**
 * Run a lightweight interactive terminal chat for an agent or pipeline.
 * @param target Agent or pipeline reply-stream producer.
 * @param options Terminal I/O and rendering options.
 * @returns A promise that resolves when the user exits.
 */
export function launchConsole(
    target: ConsoleReplyTarget,
    options?: LaunchConsoleOptions
): Promise<void>;
export function launchConsole(
    target: ConsoleReplyTarget,
    userName?: string,
    verbosity?: ConsoleVerbosity,
    maxToolResultLines?: number | null
): Promise<void>;
export async function launchConsole(
    target: ConsoleReplyTarget,
    optionsOrUserName: LaunchConsoleOptions | string = {},
    positionalVerbosity: ConsoleVerbosity = 'default',
    positionalMaxToolResultLines: number | null = 20
): Promise<void> {
    const options: LaunchConsoleOptions =
        typeof optionsOrUserName === 'string'
            ? {
                  userName: optionsOrUserName,
                  verbosity: positionalVerbosity,
                  maxToolResultLines: positionalMaxToolResultLines,
              }
            : optionsOrUserName;
    const userName = options.userName ?? options.user_name ?? 'user';
    const renderer =
        options.renderer ??
        new ConsoleRenderer({
            verbosity: options.verbosity,
            maxToolResultLines: options.maxToolResultLines ?? options.max_tool_result_lines ?? 20,
        });
    const input = options.input ?? (await createReadlineInput());
    renderer.writer.write("Chat with the agent. Type 'exit' (or Ctrl+D) to quit.\n");

    try {
        while (true) {
            let query: string;
            try {
                query = (await input.question('\n' + userName + '> ')).trim();
            } catch (error) {
                if (isInputClosed(error)) break;
                throw error;
            }
            if (query === 'exit' || query === 'quit') break;
            if (!query) continue;

            let inputs: Msg | UserConfirmResultEvent | UserInterruptEvent = UserMsg({
                name: userName,
                content: query,
            });
            while (true) {
                const controller = new AbortController();
                const onSigint = (): void => controller.abort();
                process.once('SIGINT', onSigint);
                let pending: RequireUserConfirmEvent | null;
                try {
                    pending = await runConsoleReply(target, renderer, inputs, controller.signal);
                } finally {
                    process.removeListener('SIGINT', onSigint);
                }
                if (!pending) break;
                try {
                    inputs = await confirmToolCalls(pending, input);
                } catch (error) {
                    if (!isInputClosed(error)) throw error;
                    inputs = createEvent({
                        type: EventType.USER_INTERRUPT,
                        reply_id: pending.reply_id,
                    }) as UserInterruptEvent;
                }
            }
        }
    } finally {
        await input.close();
    }
}

async function createReadlineInput(): Promise<ConsoleInput> {
    const readline = await import('node:readline/promises');
    return readline.createInterface({ input: process.stdin, output: process.stdout });
}

function isMessage(value: AgentEvent | Msg): value is Msg {
    return 'role' in value && 'content' in value;
}

function isCancellationError(error: unknown): boolean {
    return (
        error instanceof Error && (error.name === 'AbortError' || error.name === 'CancelledError')
    );
}

function isInputClosed(error: unknown): boolean {
    return (
        error instanceof Error &&
        (error.name === 'AbortError' ||
            error.name === 'EOFError' ||
            error.message.includes('closed'))
    );
}
