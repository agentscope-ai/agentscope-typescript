# Python parity baseline

This directory records every file under the AgentScope Python source and test trees. The active
baseline is `agentscope-python-61cdeae4.json`; `agentscope-python-de163b34.json` is retained as the
historical pre-final baseline. YAML model
cards are tracked as contract data; all other source files, including package metadata, Alembic
assets, and Dockerfile templates, are tracked as source. Test fixtures are tracked with test files.

The manifest is not a claim that a mapped file is already implemented. Each source and contract
data entry progresses through these states:

1. `mapped`: a TypeScript destination is assigned.
2. `contracted`: public and behavioral contracts have tests or golden fixtures.
3. `implemented`: the TypeScript implementation passes its focused tests.
4. `verified`: cross-language and integration verification is complete.

No skipped or platform-not-applicable state exists. Platform-specific features are implemented and
verified on their target operating system, while unsupported hosts expose an explicit capability or
error contract.

Schema version 2 sets `requireCompleteParity` for the final baseline. With that gate enabled, every
source file, contract-data file, and Python test must be `verified`; every source and Python test must
also reference an existing TypeScript test. Reverse mappings are derived from source entries, with
standalone test helpers recorded in `test-mapping-overrides.json`.

## Commands

```bash
pnpm parity:generate -- --python-root ../agentscope-python
pnpm parity:check
pnpm parity:check -- --python-root ../agentscope-python
pnpm test:parity
```

The generator intentionally reads a separate Python checkout. The committed manifest allows normal
TypeScript work without requiring Python, while CI checks it against the pinned Python commit.
