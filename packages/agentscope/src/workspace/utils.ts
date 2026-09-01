/* eslint-disable jsdoc/require-param, jsdoc/require-returns */

/** Standard workspace-relative directory for offloaded data. */
export const DEFAULT_DATA_DIR = 'data';

/** Standard workspace-relative directory for reusable skills. */
export const DEFAULT_SKILLS_DIR = 'skills';

/** Standard workspace-relative directory for session state. */
export const DEFAULT_SESSIONS_DIR = 'sessions';

/** Standard workspace-relative MCP declaration file. */
export const DEFAULT_MCP_FILE = '.mcp';

/** Default partition used by callers that do not provide an agent id. */
export const DEFAULT_SKILL_PARTITION = 'default';

/** Seed template copied into each agent's skill partition. */
export const SKILL_SEED_DIR = '.seed';

/** Maximum uncompressed size accepted for a skill archive. */
export const DEFAULT_MAX_EXTRACTED_BYTES = 500 * 1024 * 1024;

/** Python-compatible workspace system prompt fragment. */
export const DEFAULT_WORKSPACE_INSTRUCTIONS = `<workspace>You have access to a {backend} workspace at {workdir} with the following structure:

\`\`\`
{workdir}
├── data/        # offloaded multimodal files (images, etc.) — system-managed
├── skills/      # reusable skills, grouped by the agent that owns them
└── sessions/    # offloaded session context and tool results — system-managed
\`\`\`

This workspace is your personal working environment. You are responsible for keeping it clean, structured, and easy to navigate over time.

### Project Directory
- Create a dedicated subdirectory for each task or project under the workspace root.
- Name each project subdirectory concisely and descriptively, prefixed with its absolute creation date, e.g. \`20240315_web-scraper\`, so it stays identifiable long after creation.
- Always create a \`README.md\` at the project root documenting:
  - What the project is about
  - Its absolute creation date
  - Key decisions or context that would help you resume work later

### Working Across Sessions
- The same project may be worked on from more than one session at a time. There is no live lock that tells you another session is editing a file — avoid conflicts by isolation, not by hoping:
  - Prefer \`git worktree\` with a session-specific name so parallel work happens on separate trees and never shares the same files.
  - Encode ownership in names (creation date, session identifier) so it is clear which session created what.
- Be conservative about deletion: do not delete anything you did not create in the current session, prefer archiving over deleting, and rely on git so any change can be rolled back. Confirm before destructive cleanup.

### Scratch / Temporary Files
- Put one-off experiments, intermediate data, and anything you would otherwise drop in \`/tmp\` under a \`scratch/\` directory (created on first use), not inside project directories — this keeps projects and their git history clean.
- Treat \`scratch/\` as disposable: exclude it from git, and assume nothing in it is guaranteed to persist. Nothing clears it automatically (it lives inside your persistent workspace, not the OS temp dir), so delete your own scratch files when you are done with them.

### Version Control
- Prefer initializing a \`git\` repository in each project directory to track changes and allow rollbacks.
- If you use git, create a \`.gitignore\` before the first commit to exclude unwanted files (e.g. virtual environments, cache, \`scratch/\`, secrets).
- Never hard-code secrets into project files or commit them — this is a personal environment, but treat credentials as if they could leak.

### Python Environment
- \`uv\` is recommended for managing and isolating Python environments per project:
\`\`\`shell
uv venv && uv pip install ...
- Never install packages into a shared or global environment — each project must manage its own dependencies to avoid conflicts.</workspace>`;

/** Replace Python-style prompt placeholders without interpreting other braces. */
export function formatWorkspaceInstructions(
    template: string,
    values: { backend: string; workdir: string }
): string {
    return template.replaceAll('{backend}', values.backend).replaceAll('{workdir}', values.workdir);
}
