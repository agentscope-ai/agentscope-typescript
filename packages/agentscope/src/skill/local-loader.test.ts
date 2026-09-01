/* eslint-disable jsdoc/require-jsdoc */
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { LocalSkillLoader } from './local-loader';

function writeSkill(directory: string, name: string, description = 'Description'): void {
    mkdirSync(directory, { recursive: true });
    writeFileSync(
        path.join(directory, 'SKILL.md'),
        `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`,
        'utf8'
    );
}

describe('LocalSkillLoader', () => {
    let root: string;

    beforeEach(() => {
        root = mkdtempSync(path.join(tmpdir(), 'agentscope-skills-'));
        writeSkill(root, 'root_skill');
        writeSkill(path.join(root, 'one'), 'one_skill');
        writeSkill(path.join(root, 'one', 'two'), 'two_skill');
    });

    afterEach(() => rmSync(root, { recursive: true, force: true }));

    test('loads only the root by default and emits Python-compatible fields', async () => {
        const skills = await new LocalSkillLoader({ directory: root }).listSkills();
        expect(skills).toHaveLength(1);
        expect(skills[0].toJSON()).toEqual({
            name: 'root_skill',
            description: 'Description',
            dir: root,
            markdown: '\n# root_skill\n',
            updated_at: expect.any(Number),
        });
    });

    test('recursively scans subdirectories when enabled', async () => {
        const skills = await new LocalSkillLoader({
            directory: root,
            scanSubdir: true,
        }).listSkills();
        expect(skills.map(skill => skill.name)).toEqual(['root_skill', 'one_skill', 'two_skill']);
    });

    test('returns the same cached object until mtime changes', async () => {
        const loader = new LocalSkillLoader({ directory: root });
        const first = (await loader.listSkills())[0];
        const second = (await loader.listSkills())[0];
        expect(second).toBe(first);

        writeSkill(root, 'changed_skill', 'Changed');
        const future = new Date(Date.now() + 10_000);
        utimesSync(path.join(root, 'SKILL.md'), future, future);
        const third = (await loader.listSkills())[0];
        expect(third).not.toBe(first);
        expect(third).toMatchObject({ name: 'changed_skill', description: 'Changed' });
    });

    test('skips missing and malformed skills', async () => {
        const empty = path.join(root, 'empty');
        mkdirSync(empty);
        expect(await new LocalSkillLoader({ directory: empty }).listSkills()).toEqual([]);

        writeFileSync(path.join(empty, 'SKILL.md'), '---\nname: missing_description\n---\n');
        expect(await new LocalSkillLoader({ directory: empty }).listSkills()).toEqual([]);
    });
});
