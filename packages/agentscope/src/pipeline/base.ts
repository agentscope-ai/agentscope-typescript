import type { ReplyOptions } from '../agent';
import type { AgentEvent } from '../event';
import type { Msg } from '../message';

/** A reply-stream producer that can be used anywhere an Agent can. */
export interface PipelineProtocol {
    replyStream(options: ReplyOptions): AsyncGenerator<AgentEvent | Msg, void>;
}
