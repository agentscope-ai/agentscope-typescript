import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { format, resolveConfig } from 'prettier';

import { updateParityEntry, validateManifest } from './manifest-lib.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '../..');

/**
 * Read every value supplied for a repeatable CLI option.
 *
 * @param {string} name Option name.
 * @returns {string[]} Option values.
 */
function readOptions(name) {
    return process.argv.flatMap((value, index) => {
        return value === name && process.argv[index + 1] ? [process.argv[index + 1]] : [];
    });
}

const manifestPath = path.resolve(
    readOptions('--manifest')[0] ??
        path.join(repositoryRoot, 'parity/agentscope-python-de163b34.json')
);
const status = readOptions('--status')[0];
const sourcePaths = readOptions('--source');
const contractDataPaths = readOptions('--contract-data');
const pythonTests = readOptions('--python-test');
const typescriptTests = readOptions('--typescript-test');

if (!status || sourcePaths.length + contractDataPaths.length === 0) {
    throw new Error(
        'A status and at least one --source or --contract-data path are required.'
    );
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
const sourceByPath = new Map(manifest.sourceFiles.map(entry => [entry.path, entry]));
const contractDataByPath = new Map(
    manifest.contractDataFiles.map(entry => [entry.path, entry])
);

for (const sourcePath of sourcePaths) {
    const entry = sourceByPath.get(sourcePath);
    if (!entry) throw new Error(`Manifest source entry not found: ${sourcePath}.`);
    updateParityEntry(entry, status, pythonTests, typescriptTests);
}

for (const contractDataPath of contractDataPaths) {
    const entry = contractDataByPath.get(contractDataPath);
    if (!entry) {
        throw new Error(`Manifest contract-data entry not found: ${contractDataPath}.`);
    }
    updateParityEntry(entry, status, pythonTests, typescriptTests);
}

const errors = validateManifest(manifest);
if (errors.length > 0) throw new Error(`Updated manifest is invalid:\n${errors.join('\n')}`);

const prettierOptions = (await resolveConfig(manifestPath)) ?? {};
const manifestContent = await format(JSON.stringify(manifest), {
    ...prettierOptions,
    parser: 'json',
});
await writeFile(manifestPath, manifestContent, 'utf8');
process.stdout.write(
    `Updated ${sourcePaths.length} source and ${contractDataPaths.length} contract-data entries to ${status}.\n`
);
