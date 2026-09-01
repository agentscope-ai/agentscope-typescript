import { jsonrepair } from 'jsonrepair';
import { v3 as uuidV3, v4 as uuidV4 } from 'uuid';

import { ToolJSONDecodeError } from '../exception';
import type { JSONSerializableObject } from '../type';

export type IdFactory = () => string;
export type TimestampFactory = () => string;

let idFactory: IdFactory = () => uuidV4().replaceAll('-', '');
let timestampFactory: TimestampFactory = () => new Date().toISOString();

/**
 * Describe the JavaScript runtime type of a value.
 *
 * @param value Value to inspect.
 * @returns A stable type name.
 */
function runtimeTypeName(value: unknown): string {
    if (value === null) return 'null';
    if (Array.isArray(value)) return 'array';
    return typeof value;
}

/**
 * Override the factory used to create AgentScope entity IDs.
 *
 * @param factory ID factory.
 */
export function setIdFactory(factory: IdFactory): void {
    if (typeof factory !== 'function') {
        throw new TypeError(`factory must be a callable, got ${runtimeTypeName(factory)}`);
    }
    idFactory = factory;
}

/**
 * Override the factory used to create AgentScope entity timestamps.
 *
 * @param factory Timestamp factory.
 */
export function setTimestampFactory(factory: TimestampFactory): void {
    if (typeof factory !== 'function') {
        throw new TypeError(`factory must be a callable, got ${runtimeTypeName(factory)}`);
    }
    timestampFactory = factory;
}

/**
 * Generate an entity ID with the current global factory.
 *
 * @returns A new entity ID.
 */
export function _generateId(): string {
    return idFactory();
}

/**
 * Generate an entity timestamp with the current global factory.
 *
 * @returns A new entity timestamp.
 */
export function _generateTimestamp(): string {
    return timestampFactory();
}

/**
 * Decode a base64 string to a Uint8Array.
 * Works in both Node.js and browser environments.
 * @param b64
 * @returns The decoded bytes.
 */
export function base64ToBytes(b64: string): Uint8Array {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    return bytes;
}

/**
 * Encode a Uint8Array to a base64 string.
 * Works in both Node.js and browser environments.
 * @param bytes
 * @returns The base64-encoded string.
 */
export function bytesToBase64(bytes: Uint8Array): string {
    let binary = '';
    for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return btoa(binary);
}

/**
 * Creates a timestamp string in the format "YYYY-MM-DD HH:mm:ss.sss"
 * representing the current date and time.
 *
 * @returns {string} The formatted timestamp string.
 */
export function _createTimestamp(): string {
    return _getTimestamp();
}

/**
 * Create a local display timestamp with an optional random suffix.
 *
 * @param addRandomSuffix Whether to append three random bytes as hex.
 * @returns A Python-compatible display timestamp.
 */
export function _getTimestamp(addRandomSuffix = false): string {
    const now = new Date();
    const pad = (value: number, width = 2): string => String(value).padStart(width, '0');
    let timestamp =
        `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ` +
        `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}.` +
        `${pad(now.getMilliseconds(), 3)}`;
    if (addRandomSuffix) {
        const bytes = crypto.getRandomValues(new Uint8Array(3));
        timestamp += `_${[...bytes].map(value => value.toString(16).padStart(2, '0')).join('')}`;
    }
    return timestamp;
}

/**
 * Attempts to parse a JSON string into a dictionary/Record.
 * This function is used to handle the streaming tool use block from the LLM API.
 *
 * @param input - The JSON string to parse.
 * @returns A dictionary/Record parsed from the JSON string. If parsing fails, returns an empty dictionary.
 */
export function _jsonLoadsWithRepair(input: string): Record<string, JSONSerializableObject> {
    let errorMessage: string;
    try {
        const jsonObj = JSON.parse(input);
        if (typeof jsonObj === 'object' && jsonObj !== null && !Array.isArray(jsonObj)) {
            return jsonObj as Record<string, JSONSerializableObject>;
        }
        errorMessage =
            `Error: Your argument string is decoded into a ${runtimeTypeName(jsonObj)} ` +
            'object, but a dict object is expected!';
    } catch (error) {
        errorMessage =
            'Error: When decoding your tool arguments from JSON format to a dictionary, ' +
            `a JSONDecodeError was raised with message: ${String(error)}.`;
    }

    try {
        const repaired = JSON.parse(jsonrepair(input));
        if (typeof repaired === 'object' && repaired !== null && !Array.isArray(repaired)) {
            return repaired as Record<string, JSONSerializableObject>;
        }
    } catch {
        // Report the original parsing error because it is more actionable.
    }

    const errorInput =
        input.length > 200 ? `${input.slice(0, 100)}[TRUNCATE]${input.slice(-100)}` : input;
    const ellipsisHint =
        input.length > 200
            ? '(Because the JSON string is too long, a truncated label "[TRUNCATE]" is used ' +
              'here to indicate the truncation)'
            : '';
    throw new ToolJSONDecodeError(
        `<system-reminder>${errorMessage}\n\n` +
            `Your argument string is decoded by the following code snippet${ellipsisHint}:\n` +
            '```javascript\n' +
            `const yourToolArguments = ${JSON.stringify(errorInput)};\n` +
            'JSON.parse(yourToolArguments);\n' +
            '```\n\n' +
            '**You should recorrect the arguments in JSON format.**</system-reminder>'
    );
}

/**
 * Map text to a deterministic namespace-DNS UUID.
 *
 * @param value Text to map.
 * @returns A version 3 UUID.
 */
export function _mapTextToUuid(value: string): string {
    return uuidV3(value, uuidV3.DNS);
}

/**
 * Resolve local JSON Schema references and remove definition sections.
 *
 * @param schema Schema to flatten.
 * @returns The flattened schema.
 */
export function _flattenJsonSchema<T extends Record<string, unknown>>(schema: T): T {
    const hasDefinitions =
        (typeof schema.$defs === 'object' && schema.$defs !== null) ||
        (typeof schema.definitions === 'object' && schema.definitions !== null);
    if (!hasDefinitions) return schema;

    const copied = structuredClone(schema) as Record<string, unknown>;
    const definitions: Record<string, unknown> = {};
    if (copied.$defs && typeof copied.$defs === 'object') {
        Object.assign(definitions, copied.$defs);
        delete copied.$defs;
    }
    if (copied.definitions && typeof copied.definitions === 'object') {
        Object.assign(definitions, copied.definitions);
        delete copied.definitions;
    }

    const resolveReference = (value: unknown, visited = new Set<string>()): unknown => {
        if (Array.isArray(value)) {
            return value.map(item => resolveReference(item, visited));
        }
        if (!value || typeof value !== 'object') return value;

        const objectValue = value as Record<string, unknown>;
        const reference = objectValue.$ref;
        if (
            typeof reference === 'string' &&
            (reference.startsWith('#/$defs/') || reference.startsWith('#/definitions/'))
        ) {
            const definitionName = reference.split('/').at(-1) as string;
            if (visited.has(definitionName)) {
                return {
                    type: 'object',
                    description: `(circular: ${definitionName})`,
                };
            }
            if (definitionName in definitions) {
                const nextVisited = new Set(visited).add(definitionName);
                const resolved = resolveReference(
                    structuredClone(definitions[definitionName]),
                    nextVisited
                ) as Record<string, unknown>;
                for (const [key, item] of Object.entries(objectValue)) {
                    if (key !== '$ref') resolved[key] = resolveReference(item, nextVisited);
                }
                return resolved;
            }
            return objectValue;
        }

        return Object.fromEntries(
            Object.entries(objectValue)
                .filter(([key]) => key !== '$defs' && key !== 'definitions')
                .map(([key, item]) => [key, resolveReference(item, visited)])
        );
    };

    return resolveReference(copied) as T;
}

/**
 * Estimate token count from UTF-8 bytes using the Python heuristic.
 *
 * @param text Text to estimate.
 * @returns Estimated token count.
 */
export function _estimateTokens(text: string): number {
    return Math.floor(new TextEncoder().encode(text).byteLength / 4 + 0.5);
}

/**
 * Estimate UTF-8 byte count from a token count.
 *
 * @param tokens Token count.
 * @returns Estimated byte count.
 */
export function _estimateBytes(tokens: number): number {
    return Math.floor(tokens * 4);
}

/**
 * Render nested errors as a concise list of leaf causes.
 *
 * @param error Error to describe.
 * @returns Human-readable leaf causes.
 */
export function _describeException(error: unknown): string {
    if (error instanceof AggregateError) {
        return error.errors.map(item => _describeException(item)).join('; ');
    }
    if (error instanceof Error) return error.message || error.name;
    return String(error);
}

/**
 * Detect JavaScript async functions, async generators, and promises.
 *
 * @param value Value to inspect.
 * @returns Whether the value represents asynchronous execution.
 */
export function _isAsyncFunction(value: unknown): boolean {
    if (value instanceof Promise) return true;
    if (typeof value !== 'function') return false;
    const constructorName = value.constructor?.name;
    return constructorName === 'AsyncFunction' || constructorName === 'AsyncGeneratorFunction';
}

/**
 * Execute a callable and await either its synchronous or asynchronous result.
 *
 * @param func Callable to execute.
 * @param arguments_ Callable arguments.
 * @returns The resolved callable result.
 */
export async function _executeAsyncOrSyncFunction<Arguments extends unknown[], Result>(
    func: (...arguments_: Arguments) => Result | Promise<Result>,
    ...arguments_: Arguments
): Promise<Result> {
    return await func(...arguments_);
}

/**
 * Fetch bytes and return UTF-8 text or base64 for non-UTF-8 payloads.
 *
 * @param url URL to fetch.
 * @param maxRetries Maximum number of attempts.
 * @returns Decoded text or base64 bytes.
 */
export async function _getBytesFromWebUrl(url: string, maxRetries = 3): Promise<string> {
    for (let attempt = 0; attempt < maxRetries; attempt += 1) {
        try {
            const response = await fetch(url);
            if (!response.ok) {
                throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
            }
            const bytes = new Uint8Array(await response.arrayBuffer());
            try {
                return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
            } catch {
                return bytesToBase64(bytes);
            }
        } catch (error) {
            console.info(
                `Failed to fetch bytes from URL ${url}. Error ${String(error)}. Retrying...`
            );
        }
    }
    throw new Error(`Failed to fetch bytes from URL \`${url}\` after ${maxRetries} retries.`);
}

/**
 * Parses a streamed response from the post request.
 * An async generator that yields parsed JSON objects from the SSE stream.
 *
 * @param response - The fetch response object.
 * @returns An async generator yielding parsed JSON objects.
 */
export async function* _parseStreamedResponse<T>(response: Response): AsyncGenerator<T> {
    const reader = response.body?.getReader();
    if (!reader) {
        throw new Error('Failed to get reader from response body for streaming.');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    try {
        while (true) {
            const { done, value } = await reader.read();

            if (done) break;

            buffer += decoder.decode(value, { stream: true });

            // Handle the completed line
            const lines = buffer.split('\n');
            buffer = lines.pop() || ''; // Keep the last uncompleted line

            for (const line of lines) {
                const trimmedLine = line.trim();
                if (!trimmedLine || trimmedLine.startsWith(':')) {
                    continue; // Skip the empty line and comments
                }

                if (trimmedLine.startsWith('data:')) {
                    const jsonStr = trimmedLine.slice(5).trim(); // Remove "data:" prefix

                    if (jsonStr === '[DONE]') {
                        break;
                    }

                    try {
                        const json = JSON.parse(jsonStr);
                        yield json;
                    } catch (e) {
                        console.error('Failed to parse JSON:', e);
                        throw new Error(`Failed to parse JSON from stream: ${jsonStr}`);
                    }
                }
            }
        }
    } finally {
        reader.releaseLock();
    }
}
