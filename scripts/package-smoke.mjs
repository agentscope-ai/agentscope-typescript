import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const packageRoot = path.join(repositoryRoot, 'packages/agentscope');
const packageJson = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
const packageSpecifiers = Object.keys(packageJson.exports).map(subpath => {
    return `${packageJson.name}${subpath.slice(1)}`;
});
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentscope-package-smoke-'));

/**
 * Run an npm command in the isolated package consumer directory.
 *
 * @param {string[]} arguments_ npm arguments.
 * @returns {string} Standard output.
 */
function runNpm(arguments_) {
    return execFileSync('npm', arguments_, {
        cwd: temporaryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
}

/**
 * Run a Node.js expression in the isolated package consumer directory.
 *
 * @param {string[]} arguments_ Node.js arguments.
 */
function runNode(arguments_) {
    execFileSync(process.execPath, arguments_, {
        cwd: temporaryRoot,
        stdio: 'inherit',
    });
}

try {
    const packOutput = runNpm(['pack', '--json', '--pack-destination', temporaryRoot, packageRoot]);
    const packResult = JSON.parse(packOutput);
    const tarballPath = path.join(temporaryRoot, packResult[0].filename);

    runNpm(['init', '--yes']);
    runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', tarballPath]);

    const specifiersJson = JSON.stringify(packageSpecifiers);
    runNode([
        '-e',
        `for (const specifier of ${specifiersJson}) { ` +
            `const value = require(specifier); ` +
            `if (!value || typeof value !== 'object') throw new Error(specifier); }`,
    ]);
    runNode([
        '--input-type=module',
        '-e',
        `for (const specifier of ${specifiersJson}) { ` +
            `const value = await import(specifier); ` +
            `if (!value || typeof value !== 'object') throw new Error(specifier); }`,
    ]);

    process.stdout.write(
        `Package smoke test passed for ${packageSpecifiers.length} ESM and CJS exports.\n`
    );
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}
