/** JSON schema node used by tool schema helpers. */
export type JSONSchemaNode = Record<string, unknown>;

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
