import { createTwoFilesPatch } from 'diff';

/** JSON schema node used by tool schema helpers. */
export type JSONSchemaNode = Record<string, unknown>;

/**
 * Match a path with Python fnmatch semantics across host path separators.
 * @param value Path or glob value.
 * @param pattern Python-style fnmatch pattern.
 * @returns Whether the normalized value matches the pattern.
 */
export function fnmatchPath(value: string, pattern: string): boolean {
    const normalize = (input: string): string => {
        const normalized = input.replace(/\\/g, '/');
        return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
    };
    return new RegExp(`^${translateFnmatch(normalize(pattern))}$`, 's').test(normalize(value));
}

/**
 * Create Python-compatible unified diff headers without filename quoting.
 * @param oldName Old-side filename.
 * @param newName New-side filename.
 * @param oldContent Old content.
 * @param newContent New content.
 * @returns Unified diff text.
 */
export function createPythonUnifiedDiff(
    oldName: string,
    newName: string,
    oldContent: string,
    newContent: string
): string {
    const oldPlaceholder = '__agentscope_old_file__';
    const newPlaceholder = '__agentscope_new_file__';
    return createTwoFilesPatch(oldPlaceholder, newPlaceholder, oldContent, newContent, '', '', {
        context: 3,
    })
        .replace(/^===================================================================\n/, '')
        .replace(`--- ${oldPlaceholder}\n`, `--- ${oldName}\n`)
        .replace(`+++ ${newPlaceholder}\n`, `+++ ${newName}\n`);
}

/**
 * Remove generated title fields recursively from a JSON schema.
 * @param schema Schema mutated in place.
 * @returns The same schema without title fields.
 */
export function removeSchemaTitles<T extends JSONSchemaNode>(schema: T): T {
    delete schema.title;
    for (const key of ['properties', '$defs']) {
        const children = schema[key];
        if (typeof children !== 'object' || children === null || Array.isArray(children)) continue;
        for (const child of Object.values(children)) {
            if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
                removeSchemaTitles(child as JSONSchemaNode);
            }
        }
    }
    for (const key of ['items', 'additionalProperties']) {
        const child = schema[key];
        if (typeof child === 'object' && child !== null && !Array.isArray(child)) {
            removeSchemaTitles(child as JSONSchemaNode);
        }
    }
    return schema;
}

/**
 * Translate a normalized Python fnmatch pattern into a regular expression body.
 * @param pattern Normalized fnmatch pattern.
 * @returns Regular expression body.
 */
function translateFnmatch(pattern: string): string {
    let translated = '';
    for (let index = 0; index < pattern.length; index += 1) {
        const character = pattern[index];
        if (character === '*') {
            while (pattern[index + 1] === '*') index += 1;
            translated += '.*';
        } else if (character === '?') {
            translated += '.';
        } else if (character === '[') {
            const characterClass = translateCharacterClass(pattern, index);
            if (characterClass === null) translated += '\\[';
            else {
                translated += characterClass.value;
                index = characterClass.end;
            }
        } else {
            translated += escapeRegex(character);
        }
    }
    return translated;
}

/**
 * Translate one fnmatch character class and report its closing offset.
 * @param pattern Normalized fnmatch pattern.
 * @param start Opening bracket offset.
 * @returns Translated class and closing offset, or null for an unmatched bracket.
 */
function translateCharacterClass(
    pattern: string,
    start: number
): { value: string; end: number } | null {
    let end = start + 1;
    if (pattern[end] === '!') end += 1;
    if (pattern[end] === ']') end += 1;
    while (end < pattern.length && pattern[end] !== ']') end += 1;
    if (end >= pattern.length) return null;
    let content = pattern.slice(start + 1, end);
    const negated = content.startsWith('!');
    if (negated) content = content.slice(1);
    content = content.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
    if (content.startsWith('^')) content = `\\${content}`;
    return { value: `[${negated ? '^' : ''}${content}]`, end };
}

/**
 * Escape one literal character for use in a regular expression.
 * @param value Literal character.
 * @returns Escaped regular expression fragment.
 */
function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
