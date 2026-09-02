import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeFiles, hashFileSet, validateManifest, walkFiles } from './manifest-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

/**
 * Read an optional CLI argument.
 *
 * @param {string} name Option name.
 * @returns {string | undefined} Option value.
 */
function readOption(name) {
    const index = process.argv.indexOf(name);
    return index === -1 ? undefined : process.argv[index + 1];
}

/**
 * Compare manifest entries with files from the Python checkout.
 *
 * @param {object} manifest Parsed manifest.
 * @param {string} pythonRoot Python repository root.
 * @returns {Promise<string[]>} Verification errors.
 */
async function verifyPythonCheckout(manifest, pythonRoot) {
    const errors = [];
    const commit = execFileSync('git', ['-C', pythonRoot, 'rev-parse', 'HEAD'], {
        encoding: 'utf8',
    }).trim();
    if (commit !== manifest.pythonCommit) {
        errors.push(`Python checkout is ${commit}, expected ${manifest.pythonCommit}.`);
    }

    const allSourcePaths = await walkFiles(path.join(pythonRoot, 'src/agentscope'));
    const collections = [
        {
            name: 'sourceFiles',
            paths: allSourcePaths.filter(filePath => !filePath.endsWith('.yaml')),
        },
        {
            name: 'contractDataFiles',
            paths: allSourcePaths.filter(filePath => filePath.endsWith('.yaml')),
        },
        {
            name: 'testFiles',
            paths: await walkFiles(path.join(pythonRoot, 'tests')),
        },
    ];

    for (const collection of collections) {
        const actualFiles = await describeFiles(pythonRoot, collection.paths);
        const actualByPath = new Map(actualFiles.map(file => [file.path, file.sha256]));
        const expectedEntries = manifest[collection.name];
        const expectedByPath = new Map(expectedEntries.map(entry => [entry.path, entry.sha256]));

        for (const [filePath, digest] of actualByPath) {
            if (!expectedByPath.has(filePath)) {
                errors.push(`${collection.name} is missing ${filePath}.`);
            } else if (expectedByPath.get(filePath) !== digest) {
                errors.push(`${collection.name} digest mismatch for ${filePath}.`);
            }
        }
        for (const filePath of expectedByPath.keys()) {
            if (!actualByPath.has(filePath)) {
                errors.push(`${collection.name} contains stale path ${filePath}.`);
            }
        }

        const aggregateDigest = hashFileSet(actualFiles);
        if (aggregateDigest !== manifest.summary[collection.name].sha256) {
            errors.push(`${collection.name} aggregate digest mismatch.`);
        }
    }

    return errors;
}

const manifestPath = path.resolve(
    readOption('--manifest') ?? path.join(repositoryRoot, 'parity/agentscope-python-de163b34.json')
);
const pythonRootOption = readOption('--python-root');
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const errors = validateManifest(manifest);

if (pythonRootOption) {
    errors.push(...(await verifyPythonCheckout(manifest, path.resolve(pythonRootOption))));
}

if (errors.length > 0) {
    process.stderr.write(`${errors.join('\n')}\n`);
    process.exitCode = 1;
} else {
    process.stdout.write(
        `Parity manifest is valid for ${manifest.pythonCommit}: ` +
            `${manifest.sourceFiles.length} source files, ` +
            `${manifest.contractDataFiles.length} contract data files, ` +
            `${manifest.testFiles.length} test files.\n`
    );
}
