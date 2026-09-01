import { HubBase, MCPCard, SkillCard } from '../src/hub';

const httpConfig = { type: 'http_mcp' as const, url: 'https://example.com/sse' };

describe('Python hub card identity parity', () => {
    test('accepts a route-safe hub id and defaults its description', () => {
        const hub = new HubBase({ hubId: 'claw_hub-1', displayName: 'ClawHub' });
        expect(hub.hubId).toBe('claw_hub-1');
        expect(hub.description).toBe('');
    });

    test.each(['claw:hub', ''])('rejects an unusable hub id: %p', hubId => {
        expect(() => new HubBase({ hubId, displayName: 'ClawHub' })).toThrow(TypeError);
    });

    test('defaults an MCP card id to its name', () => {
        const card = new MCPCard({ hubId: 'testhub', name: 'notion', configTemplate: httpConfig });
        expect(card.id).toBe('notion');
    });

    test('preserves an explicit MCP card id independently of its name', () => {
        const card = new MCPCard({
            hubId: 'testhub',
            id: 'srv_01ab',
            name: 'notion',
            configTemplate: httpConfig,
        });
        expect([card.id, card.name]).toEqual(['srv_01ab', 'notion']);
    });

    test('defaults a skill card id to its name', () => {
        expect(new SkillCard({ hubId: 'clawhub', name: 'gifgrep' }).id).toBe('gifgrep');
    });

    test('allows opaque card ids containing a colon', () => {
        const id = 'clawhub:kd75911hf60t9b6fr5pn61x0fx80t3xw';
        expect(new SkillCard({ hubId: 'clawhub', id, name: 'git' }).id).toBe(id);
    });

    test('disambiguates equal names by the hub-id/card-id pair', () => {
        const a = new SkillCard({ hubId: 'clawhub', name: 'git' });
        const b = new SkillCard({ hubId: 'otherhub', name: 'git' });
        expect(a.name).toBe(b.name);
        expect([a.hubId, a.id]).not.toEqual([b.hubId, b.id]);
    });

    test('renaming a card preserves its provenance', () => {
        const card = new MCPCard({ hubId: 'clawhub', name: 'git', configTemplate: httpConfig });
        card.name = 'git-2';
        expect([card.hubId, card.id]).toEqual(['clawhub', 'git']);
    });
});
