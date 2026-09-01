import { VERSION } from './version';

test('matches the pinned Python package version', () => {
    expect(VERSION).toBe('2.0.7.post1');
});
