import { z } from 'zod';

import type {
    ExternalExecutionResultEvent,
    UserConfirmResultEvent,
    UserInterruptEvent,
} from '../event';
import type { ToolCallBlock } from '../message/block';
import type { Msg } from '../message/message';
import type { ToolChoice } from '../type';

export interface ReplyOptions {
    inputs?:
        | Msg
        | Msg[]
        | UserConfirmResultEvent
        | UserInterruptEvent
        | ExternalExecutionResultEvent
        | null;
    msgs?: Msg | Msg[];
    event?: UserConfirmResultEvent | UserInterruptEvent | ExternalExecutionResultEvent;
    structuredSchema?: z.ZodObject | Record<string, unknown> | null;
    structuredModel?: z.ZodObject;
    yieldFinalMsg?: boolean;
}

export interface ReasoningOptions {
    toolChoice?: ToolChoice;
}

export interface ActingOptions {
    toolCall: ToolCallBlock;
}

export interface ObserveOptions {
    msg?: Msg | Msg[];
}
