import { ClawSkillHub } from '../src/hub';

describe('Python ClawHub card conversion parity', () => {
    const hub = new ClawSkillHub();
    const card = (item: Record<string, unknown> = {}) => hub.toCard({ slug: 'demo', ...item });

    test('renders generated timestamp versions as dates', () => {
        expect(card({ latestVersion: { version: '0.20260729.110214' } }).version).toBe(
            '2026-07-29'
        );
    });

    test('preserves semver and timestamp-shaped invalid dates', () => {
        expect(card({ latestVersion: { version: '1.0.1' } }).version).toBe('1.0.1');
        expect(card({ latestVersion: { version: '0.20261399.110214' } }).version).toBe(
            '0.20261399.110214'
        );
    });

    test('keeps a missing version null', () => {
        expect(card().version).toBeNull();
    });

    test('uses topics rather than the version-tag map', () => {
        expect(
            card({ topics: ['development'], tags: { latest: '0.20260729.110214' } }).tags
        ).toEqual(['development']);
    });

    test('converts updatedAt from milliseconds to seconds', () => {
        expect(card({ updatedAt: 1785300394493 }).updatedAt).toBeCloseTo(1785300394.493, 3);
    });

    test('reads installs from stats and preserves unknown as null', () => {
        expect(card({ stats: { installs: 25, downloads: 888 } }).installs).toBe(25);
        expect(card().installs).toBeNull();
    });

    test('builds a slug URL and prefers a canonical URL', () => {
        expect(card().url).toBe('https://clawhub.ai/skills/demo');
        expect(card({ canonicalUrl: '/someone/skills/demo' }).url).toBe(
            'https://clawhub.ai/someone/skills/demo'
        );
    });

    test('reads author and icon from a detail owner', () => {
        expect(
            card({ owner: { displayName: 'Len', handle: 'lentiancn', image: 'u' } })
        ).toMatchObject({ author: 'Len', iconUrl: 'u' });
    });

    test('falls back from display name to owner handle', () => {
        expect(card({ owner: { handle: 'lentiancn' } }).author).toBe('lentiancn');
    });

    test('reads the search owner shape', () => {
        expect(card({ native: { owner: { handle: 'someone' } } }).author).toBe('someone');
    });

    test('keeps catalog author and icon unknown', () => {
        expect(card({ stats: { downloads: 496 } })).toMatchObject({
            author: null,
            iconUrl: null,
        });
    });

    test('reads downloads from catalog and search shapes', () => {
        expect(card({ stats: { downloads: 496 } }).downloads).toBe(496);
        expect(card({ downloads: 17058 }).downloads).toBe(17058);
    });

    test('owner-scopes an id when the owner is known', () => {
        expect(card({ ownerHandle: 'runware' }).id).toBe('runware/demo');
        expect(card({ owner: { handle: 'runware' } }).id).toBe('runware/demo');
    });

    test('falls back to a bare slug and never adds the owner to name', () => {
        expect(card().id).toBe('demo');
        expect(card({ ownerHandle: 'runware' }).name).toBe('demo');
    });
});

describe('Python ClawHub id and error parity', () => {
    test('splits owner-scoped and bare card ids', () => {
        expect(ClawSkillHub.splitCardId('runware/music')).toEqual([
            'music',
            { ownerHandle: 'runware' },
        ]);
        expect(ClawSkillHub.splitCardId('gifgrep')).toEqual(['gifgrep', {}]);
    });

    test('renders ambiguous slug candidates', () => {
        const body =
            '{"code":"AMBIGUOUS_SKILL_SLUG","slug":"music","matches":' +
            '[{"ref":"@a/music"},{"ref":"@b/music"}]}';
        const message = ClawSkillHub.describeError(409, body);
        expect(message).toContain("'music'");
        expect(message).toContain('@a/music, @b/music');
    });

    test('passes all other error bodies through', () => {
        expect(ClawSkillHub.describeError(500, 'boom')).toBe('boom');
        expect(ClawSkillHub.describeError(409, 'plain')).toBe('plain');
        expect(ClawSkillHub.describeError(409, '{}')).toBe('{}');
    });
});
