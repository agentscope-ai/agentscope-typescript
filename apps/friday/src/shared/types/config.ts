// ============================================
// Model Configurations
// ============================================

/**
 * Supported AI model providers
 */
export type ModelProvider = 'dashscope' | 'openai' | 'ollama' | 'deepseek';

/**
 * Model configuration for AI providers
 *
 * @property provider - The AI provider (dashscope, openai, ollama, deepseek)
 * @property modelName - The specific model name (e.g., 'qwen3-max', 'gpt-4')
 * @property apiKey - API key for authentication
 * @property clientKwargs - Optional client initialization parameters
 * @property generateKwargs - Optional generation parameters (temperature, max_tokens, etc.)
 */
export interface ModelConfig {
    provider: ModelProvider;
    modelName: string;
    apiKey: string;
    clientKwargs?: Record<string, string | number | boolean>;
    generateKwargs?: Record<string, string | number | boolean>;
}

// ============================================
// Agent Configurations
// ============================================

/**
 * Agent configuration
 *
 * @property name - Agent display name
 * @property type - Agent type: 'builtin' agents have a fixed system prompt; 'custom' agents can define their own
 * @property avatar - Avatar identifier (builtin) or filename in user data dir (custom)
 * @property modelKey - Reference to a key in config.models
 * @property instruction - User-defined instruction appended to the system prompt
 * @property systemPrompt - Full system prompt, only applicable for custom agents
 * @property maxIters - Maximum reasoning-acting iterations per reply
 * @property compressionTrigger - Token threshold for triggering context compression
 * @property compressionKeepRecent - Number of recent messages to keep during compression
 */
export interface AgentConfig {
    name: string;
    type: 'builtin' | 'custom';
    avatar?: string;
    modelKey: string;
    instruction: string;
    systemPrompt?: string;
    maxIters: number;
    compressionTrigger: number;
    compressionKeepRecent: number;
}

// ============================================
// Feature Configurations
// ============================================

/**
 * Chat feature configuration
 */
export interface ChatConfig {
    // Empty for now, modelKey will be passed from frontend
    // TODO: more settings here
    placeholder?: string;
}

/**
 * Editor feature configuration
 *
 * @property autoSave - Enable automatic saving
 * @property autoSaveIntervalMs - Auto-save interval in milliseconds
 */
export interface EditorConfig {
    autoSave: boolean;
    autoSaveIntervalMs: number;
}

/**
 * Skill system configuration
 *
 * @property dirs - Directories to search for custom skills
 */
export interface SkillConfig {
    dirs: string[];
}

/**
 * Telemetry and analytics configuration
 *
 * @property enabled - Enable telemetry data collection
 */
export interface TelemetryConfig {
    enabled: boolean;
}

// ============================================
// Main Configuration
// ============================================

/**
 * Main application configuration
 *
 * This is the root configuration object that contains all settings
 * for the application, including user preferences, model configurations,
 * and feature-specific settings.
 *
 * @property onboardingCompleted - Whether the user has completed the onboarding wizard
 * @property tourCompleted - Whether the user has completed the application tour
 * @property username - User's display name
 * @property language - UI language (en or zh)
 * @property models - Named model configurations (e.g., { default: {...}, gpt4: {...} })
 * @property chat - Chat feature settings
 * @property editor - Editor feature settings
 * @property skills - Skill system settings
 * @property telemetry - Telemetry settings
 */
export interface Config {
    onboardingCompleted?: boolean;
    tourCompleted?: boolean;
    username: string;
    language: 'en' | 'zh';
    models: Record<string, ModelConfig>;
    agents: Record<string, AgentConfig>;
    chat: ChatConfig;
    editor: EditorConfig;
    skills: SkillConfig;
    telemetry: TelemetryConfig;
}
