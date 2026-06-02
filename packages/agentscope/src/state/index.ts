/**
 * Task represents a unit of work tracked in an agent's task context.
 * Mirrors the Python `agentscope.state.Task` model.
 */
export interface Task {
    id: string;
    subject: string;
    description: string;
    metadata: Record<string, unknown>;
    created_at: string;
    state: 'pending' | 'in_progress' | 'completed';
    owner: string | null;
    blocks: string[];
    blocked_by: string[];
}

/**
 * TaskContext holds the list of tasks associated with an agent session.
 * Mirrors the Python `agentscope.state.TaskContext` model.
 */
export interface TaskContext {
    tasks: Task[];
}
