/* eslint-disable jsdoc/require-returns */

import { createModelCard } from './card';
import type { AnyModelCard, JSONSchema, ModelCardKind, RawModelCardRecord } from './card';
import { MODEL_CARD_RECORDS } from './cards.generated';

/**
 * Return the immutable raw card records generated from the Python YAML catalog.
 * @param options
 * @param options.kind
 * @param options.provider
 */
export function listRawModelCards(
    options: {
        kind?: ModelCardKind;
        provider?: string;
    } = {}
): readonly RawModelCardRecord[] {
    return MODEL_CARD_RECORDS.filter(record => {
        return (
            (options.kind === undefined || record.kind === options.kind) &&
            (options.provider === undefined || record.provider === options.provider)
        );
    });
}

/**
 * Build validated cards, applying a provider parameter JSON schema.
 * @param options
 * @param options.kind
 * @param options.provider
 * @param options.parameterSchema
 */
export function listModelCards(
    options: {
        kind?: ModelCardKind;
        provider?: string;
        parameterSchema?: JSONSchema;
    } = {}
): AnyModelCard[] {
    return listRawModelCards(options).map(record => {
        return createModelCard(record, options.parameterSchema);
    });
}
