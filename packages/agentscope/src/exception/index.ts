/** Base class for errors that should be exposed to an agent. */
export class AgentOrientedException extends Error {
    /**
     * Create an agent-oriented exception.
     *
     * @param message Error message.
     */
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** Base class for errors that should be exposed to developers. */
export class DeveloperOrientedException extends Error {
    /**
     * Create a developer-oriented exception.
     *
     * @param message Error message.
     */
    constructor(message: string) {
        super(message);
        this.name = new.target.name;
    }
}

/** Raised when a model does not produce valid structured output. */
export class StructuredOutputError extends DeveloperOrientedException {}

/** Raised when a requested tool is not registered. */
export class ToolNotFoundError extends AgentOrientedException {}

/** Raised when a tool call is interrupted by the user. */
export class ToolInterruptedError extends AgentOrientedException {}

/** Raised when tool arguments cannot be decoded or repaired as JSON. */
export class ToolJSONDecodeError extends AgentOrientedException {}

/** Raised when a tool belongs to an inactive group. */
export class ToolGroupInactiveError extends AgentOrientedException {}
