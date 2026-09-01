const { createDefaultPreset } = require('ts-jest');

const tsJestTransform = createDefaultPreset({
    tsconfig: 'tsconfig.node.json',
}).transform;

/** @type {import('jest').Config} */
module.exports = {
    testEnvironment: 'node',
    testMatch: ['<rootDir>/test/**/*.test.ts'],
    transform: tsJestTransform,
    moduleNameMapper: {
        '^@shared/(.*)$': '<rootDir>/src/shared/$1',
    },
};
