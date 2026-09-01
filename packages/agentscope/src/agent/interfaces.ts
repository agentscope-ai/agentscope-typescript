import { z } from 'zod';

import type { ExternalExecutionResultEvent, UserConfirmResultEvent } from '../event';
import type { ToolCallBlock } from '../message/block';
import type { Msg } from '../message/message';
import type { ToolChoice } from '../type';

export interface ReplyOptions {
    msgs?: Msg | Msg[];
    event?: UserConfirmResultEvent | ExternalExecutionResultEvent;
    structuredModel?: z.ZodObject;
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
