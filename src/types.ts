// ─── Project & Agent configuration types ──────────────────────────────────────

export interface ProjectConfig {
  project: {
    name: string;
    created_at: string;
  };
  agents: string[];
  defaultProvider?: ProviderConfig;
}

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'qwen';
export type AuthMethod = 'api_key' | 'gcp_adc';

export interface ProviderConfig {
  type: ProviderType;
  model: string;
  base_url: string | null;
  proxy_url: string | null;
  auth_method: AuthMethod;
}

export interface MCPServerConfig {
  name: string;
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface ContextFilter {
  include_extensions: string[];
  exclude_patterns: string[];
}

export type AgentCategory =
  | 'Solution Architect Agent'
  | 'Data Architect Agent'
  | 'Business Analyst Agent'
  | 'Cloud Architect Agent'
  | 'Software QA / Testing Agent'
  | 'Front-End Designer Agent'
  | 'Advanced Coder Agent'
  | 'Security Engineer Agent'
  | 'DevOps Engineer Agent'
  | 'Technical Writer Agent'
  | 'AI / LLM Engineer Agent'
  | 'Custom Agent';

export interface AgentConfig {
  id: string;
  name: string;
  category: AgentCategory;
  description: string;
  enabled: boolean;
  provider: ProviderConfig;
  useDefaultProvider?: boolean;
  system_prompt_files: string[];
  mcp_servers: MCPServerConfig[];
  context_filter: ContextFilter;
}

// ─── Chat / messaging types ────────────────────────────────────────────────────

export type MessageRole = 'user' | 'assistant' | 'system';

export interface ChatMessage {
  role: MessageRole;
  content: string;
}

export type ThoughtEventType = 'thinking' | 'tool_call' | 'tool_result' | 'error';

export interface ThoughtEvent {
  type: ThoughtEventType;
  label: string;
  detail?: string;
  timestamp: Date;
}

// ─── MCP types ─────────────────────────────────────────────────────────────────

export interface MCPToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface MCPToolCall {
  name: string;
  input: Record<string, unknown>;
}

export interface MCPToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}

// ─── Undo types ────────────────────────────────────────────────────────────────

export type UndoActionType = 'write_file' | 'run_command';

export interface UndoAction {
  type: UndoActionType;
  filePath?: string;
  previousContent?: string;
  description: string;
  timestamp: Date;
}

// ─── Provider streaming ────────────────────────────────────────────────────────

export interface LLMStreamOptions {
  messages: ChatMessage[];
  tools?: MCPToolDefinition[];
  maxTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export type StreamEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_use'; id: string; name: string; input: Record<string, unknown> }
  | { type: 'token_usage'; usage: TokenUsage }
  | { type: 'done' };
