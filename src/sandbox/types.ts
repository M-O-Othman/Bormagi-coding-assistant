export interface SandboxCreateRequest {
    taskId: string;
    repoPathOrRemote: string;
    baseRef: string;
    isolationMode: string;
    policyBundleId: string;
    writable: boolean;
    networkMode: "deny_all" | "localhost_only" | "allowlist" | "full";
    allowedHosts?: string[];
    injectedSecrets?: string[];
}

export interface SandboxHandle {
    sandboxId: string;
    workspacePath: string;
    manifestPath: string;
    checkpointDir: string;
}

export interface SandboxManifest {
    sandboxId: string;
    taskId: string;
    createdAt: string;
    sourceRepo: string;
    baseRef: string;
    workspacePath: string;
    isolationMode: string;
    policyBundleId: string;
    status: string;
}

export type ActionKind = "read_file" | "write_file" | "exec_command" | "network_request" | "install_package" | "git_push" | "open_pr" | "mcp_call";

export type ApprovalScope = "once" | "task" | "session" | "project" | "org-policy";

export interface PolicyContext {
    taskId: string;
    repoId: string;
    isolationMode: string;
    userId: string;
    command?: string;
    path?: string;
    host?: string;
    toolName?: string;
    actionKind: ActionKind;
}

export interface PolicyResult {
    decision: "allow" | "ask" | "deny";
    matchedRule?: string;
    reason: string;
    requiresApproval: boolean;
}