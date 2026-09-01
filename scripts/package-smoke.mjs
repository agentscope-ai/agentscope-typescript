import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const packageRoots = [
    path.join(repositoryRoot, 'packages/agentscope'),
    path.join(repositoryRoot, 'packages/agentscope-service'),
];
const packageMetadata = await Promise.all(
    packageRoots.map(async packageRoot => {
        const packageJson = JSON.parse(
            await readFile(path.join(packageRoot, 'package.json'), 'utf8')
        );
        return {
            packageRoot,
            bins: Object.keys(packageJson.bin ?? {}),
            specifiers: Object.keys(packageJson.exports).map(subpath => {
                return `${packageJson.name}${subpath.slice(1)}`;
            }),
        };
    })
);
const packageSpecifiers = packageMetadata.flatMap(metadata => metadata.specifiers);
const packageBins = packageMetadata.flatMap(metadata => metadata.bins);
const temporaryRoot = await mkdtemp(path.join(os.tmpdir(), 'agentscope-package-smoke-'));
const npmExecutable = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const pnpmExecutable = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';

/**
 * Run an npm command in the isolated package consumer directory.
 *
 * @param {string[]} arguments_ npm arguments.
 * @returns {string} Standard output.
 */
function runNpm(arguments_) {
    return execFileSync(npmExecutable, arguments_, {
        cwd: temporaryRoot,
        encoding: 'utf8',
        shell: process.platform === 'win32',
        stdio: ['ignore', 'pipe', 'inherit'],
    });
}

/**
 * Pack a workspace package with publish-time workspace dependency rewriting.
 *
 * @param {string} packageRoot Package directory.
 * @returns {string} Absolute tarball path.
 */
function packWorkspacePackage(packageRoot) {
    const output = execFileSync(
        pnpmExecutable,
        ['pack', '--json', '--pack-destination', temporaryRoot],
        {
            cwd: packageRoot,
            encoding: 'utf8',
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'inherit'],
        }
    );
    const filename = JSON.parse(output).filename;
    return path.isAbsolute(filename) ? filename : path.join(temporaryRoot, filename);
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

/** Verify the installed dedicated index-worker CLI and its configuration error contract. */
function testIndexWorkerCli() {
    if (!packageBins.includes('agentscope-index-worker')) {
        throw new Error('agentscope-index-worker is missing from the packed service package.');
    }
    const executable = path.join(
        temporaryRoot,
        'node_modules',
        '.bin',
        process.platform === 'win32' ? 'agentscope-index-worker.cmd' : 'agentscope-index-worker'
    );
    try {
        execFileSync(executable, [], {
            cwd: temporaryRoot,
            encoding: 'utf8',
            env: { ...process.env, AGENTSCOPE_WORKER_BOOTSTRAP: '' },
            shell: process.platform === 'win32',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
    } catch (error) {
        const stderr = String(error.stderr ?? '');
        if (error.status === 2 && stderr.includes('AGENTSCOPE_WORKER_BOOTSTRAP is required')) {
            return;
        }
        throw error;
    }
    throw new Error('agentscope-index-worker should exit with status 2 without a bootstrap.');
}

try {
    const tarballPaths = packageMetadata.map(metadata => {
        return packWorkspacePackage(metadata.packageRoot);
    });

    runNpm(['init', '--yes']);
    runNpm(['install', '--ignore-scripts', '--no-audit', '--no-fund', ...tarballPaths]);

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
    testIndexWorkerCli();

    process.stdout.write(
        `Package smoke test passed for ${packageSpecifiers.length} ESM/CJS exports and ` +
            `${packageBins.length} CLI.\n`
    );
} finally {
    await rm(temporaryRoot, { recursive: true, force: true });
}
