#!/usr/bin/env node

import { runWorkerFromEnvironment } from './index-worker';

void runWorkerFromEnvironment().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
});
