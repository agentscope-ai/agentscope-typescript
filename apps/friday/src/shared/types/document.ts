import type { BaseListItem } from './common';

export interface Document extends BaseListItem {
    // If Document has special fields, they can be added here
    // For example: content?: string, tags?: string[], etc.
    // TODO: remove
    tag?: string;
}
