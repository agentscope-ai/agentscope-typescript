import { HubBase } from '../base';
import type { SkillCard, SkillHubPage } from './card';

export type SkillArchiveFormat = 'zip' | 'tar' | 'tar.gz';

export interface SkillArchive {
    format: SkillArchiveFormat;
    stream: AsyncIterable<Uint8Array>;
}

/** Base contract for skill catalog providers. */
export abstract class SkillHubBase extends HubBase {
    abstract listSkills(
        userId: string,
        query?: string | null,
        cursor?: string | null,
        limit?: number
    ): Promise<SkillHubPage>;

    abstract getSkill(userId: string, cardId: string): Promise<SkillCard>;

    abstract download(
        userId: string,
        cardId: string,
        version?: string | null
    ): Promise<SkillArchive>;
}
