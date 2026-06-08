import { jsonrepair } from 'jsonrepair';

import { JSONSerializableObject } from '../type';

/**
 * Decode a base64 string to a Uint8Array.
 * Works in both Node.js and browser environments.
 * @param b64
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
    return new Date().toISOString().replace('T', ' ').replace('Z', '').substring(0, 23);
}

/**
 * Attempts to parse a JSON string into a dictionary/Record.
 * This function is used to handle the streaming tool use block from the LLM API.
 *
 * @param input - The JSON string to parse.
 * @returns A dictionary/Record parsed from the JSON string. If parsing fails, returns an empty dictionary.
 */
export function _jsonLoadsWithRepair(input: string): Record<string, JSONSerializableObject> {
    try {
        const jsonObj = JSON.parse(input);
        // Check if the jsonObj is a dictionary/Record
        if (typeof jsonObj === 'object' && jsonObj !== null && !Array.isArray(jsonObj)) {
            return jsonObj as Record<string, JSONSerializableObject>;
        } else {
            // Return an empty dictionary
            return {};
        }
    } catch {
        try {
            const repairedString = jsonrepair(input);
            const jsonObj = JSON.parse(repairedString);
            // Check if the jsonObj is a dictionary/Record
            if (typeof jsonObj === 'object' && jsonObj !== null && !Array.isArray(jsonObj)) {
                return jsonObj as Record<string, JSONSerializableObject>;
            } else {
                // Return an empty dictionary
                return {};
            }
        } catch (e) {
            console.error(`Failed to parse JSON "${input}" with error:`, e);
            return {};
        }
    }
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
