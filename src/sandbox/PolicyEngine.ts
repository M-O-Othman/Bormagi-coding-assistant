import * as path from 'path';
import * as fs from 'fs';
import * as yaml from 'js-yaml';
import { PolicyContext, PolicyResult, ActionKind } from './types';

function globToRegex(glob: string): RegExp {
    // Escape special regex chars
    let regexStr = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    // Replace glob syntax with regex syntax
    regexStr = regexStr.replace(/\*\*/g, '.*');
    regexStr = regexStr.replace(/(?<!\.)\*(?!\.)/g, '[^/]*');
    regexStr = regexStr.replace(/\?/g, '.');
    return new RegExp(`^${regexStr}$`);
}

export interface SandboxPolicy {
    name: string;
    mode: string;
    network?: {
        mode: 'deny_all' | 'allowlist';
        allowedHosts?: string[];
    };
    paths?: {
        deny?: string[];
        allow?: string[];
    };
    commands?: {
        allow?: string[];
        ask?: string[];
        deny?: string[];
    };
}

const DEFAULT_POLICY: SandboxPolicy = {
    name: 'standard-coding',
    mode: 'local_worktree_sandbox',
    network: {
        mode: 'deny_all',
    },
    paths: {
        deny: [
            "~/.ssh/**",
            "~/.aws/**",
            "~/.config/gcloud/**",
            "~/.bormagi/**"
        ]
    },
    commands: {
        allow: [
            "git status",
            "git diff *",
            "npm test *",
            "pytest *",
            "ruff check *",
            "eslint *",
            "npm run *"
        ],
        ask: [
            "npm install *",
            "pnpm install *",
            "git push *",
            "git branch *",
            "git commit *"
        ],
        deny: [
            "sudo *",
            "rm -rf /*"
        ]
    }
};

export class PolicyEngine {
    private policy: SandboxPolicy;
    private workspaceRoot: string;

    constructor(workspaceRoot: string) {
        this.workspaceRoot = workspaceRoot;
        this.policy = this.loadProjectPolicy();
    }

    private loadProjectPolicy(): SandboxPolicy {
        const policyPath = path.join(this.workspaceRoot, '.bormagi', 'policies', 'sandbox.policy.yaml');
        if (fs.existsSync(policyPath)) {
            try {
                const content = fs.readFileSync(policyPath, 'utf-8');
                return yaml.load(content) as SandboxPolicy;
            } catch (err) {
                console.error(`Failed to load policy at ${policyPath}, falling back to default.`, err);
            }
        } else {
            // Write out the default policy so it is visible to users
            try {
                const dir = path.dirname(policyPath);
                if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
                fs.writeFileSync(policyPath, yaml.dump(DEFAULT_POLICY));
            } catch (err) {
                // Ignore write errors
            }
        }
        return DEFAULT_POLICY;
    }

    public async evaluate(ctx: PolicyContext): Promise<PolicyResult> {
        // High risk checks
        if (ctx.actionKind === 'exec_command' && ctx.command) {
            const highRisk = this.checkHighRiskCommand(ctx.command);
            if (highRisk) {
                return {
                    decision: 'deny',
                    matchedRule: 'HIGH_RISK_PATTERNS',
                    reason: `Command matches high-risk pattern: ${ctx.command}`,
                    requiresApproval: true
                };
            }

            return this.matchCommandPolicy(ctx.command);
        }

        if (ctx.actionKind === 'read_file' || ctx.actionKind === 'write_file') {
            if (ctx.path) {
                return this.matchPathPolicy(ctx.path, ctx.actionKind);
            }
        }

        if (ctx.actionKind === 'network_request' && ctx.host) {
            return this.matchNetworkPolicy(ctx.host);
        }

        // Implicitly safe fallbacks
        if (['read_file', 'mcp_call'].includes(ctx.actionKind)) {
            return { decision: 'allow', reason: 'Implicitly safe default', requiresApproval: false };
        }

        // Catch-all
        return { decision: 'ask', reason: 'No matching policy rule, require manual approval.', requiresApproval: true };
    }

    private checkHighRiskCommand(cmd: string): boolean {
        const HIGH_RISK_PATTERNS: RegExp[] = [
            /\brm\s+-rf\b/i,
            /\bsudo\b/i,
            /curl\b.*\|\s*(bash|sh|zsh|powershell)/i,
            /wget\b.*\|\s*(bash|sh|zsh|powershell)/i,
            /git\s+push\s+.*--force/i,
            /DROP\s+DATABASE/i,
            /TRUNCATE\s+TABLE/i,
        ];
        return HIGH_RISK_PATTERNS.some((re) => re.test(cmd));
    }

    private matchCommandPolicy(command: string): PolicyResult {
        if (!this.policy.commands) return { decision: 'ask', reason: 'No command policy set.', requiresApproval: true };

        // Test deny first
        if (this.policy.commands.deny) {
            for (const rule of this.policy.commands.deny) {
                if (globToRegex(rule).test(command)) {
                    return { decision: 'deny', matchedRule: rule, reason: 'Command explicitly denied by policy.', requiresApproval: false };
                }
            }
        }

        // Test allow
        if (this.policy.commands.allow) {
            for (const rule of this.policy.commands.allow) {
                if (globToRegex(rule).test(command)) {
                    return { decision: 'allow', matchedRule: rule, reason: 'Command explicitly allowed by policy.', requiresApproval: false };
                }
            }
        }

        // Test ask
        if (this.policy.commands.ask) {
            for (const rule of this.policy.commands.ask) {
                if (globToRegex(rule).test(command)) {
                    return { decision: 'ask', matchedRule: rule, reason: 'Command explicitly requires approval by policy.', requiresApproval: true };
                }
            }
        }

        return { decision: 'ask', reason: 'Command not explicitly allowed or denied. Defaulting to ask.', requiresApproval: true };
    }

    private matchPathPolicy(targetPath: string, actionKind: string): PolicyResult {
        // Simple safety checks
        let normalizedPath = targetPath;
        if (targetPath.startsWith('~')) {
            const homedir = process.env.HOME || process.env.USERPROFILE || '';
            normalizedPath = path.join(homedir, targetPath.slice(1));
        }

        // Deny checks across all IO
        if (this.policy.paths?.deny) {
            for (const rule of this.policy.paths.deny) {
                // Convert wildcard to regex matching any relative traversal
                const ruleRegex = globToRegex(rule);
                if (ruleRegex.test(targetPath) || ruleRegex.test(normalizedPath)) {
                    return { decision: 'deny', matchedRule: rule, reason: `Path access to ${targetPath} is denied by policy.`, requiresApproval: false };
                }
            }
        }

        return { decision: actionKind === 'write_file' ? 'ask' : 'allow', reason: 'Default path policy', requiresApproval: actionKind === 'write_file' };
    }

    private matchNetworkPolicy(host: string): PolicyResult {
        if (!this.policy.network) return { decision: 'deny', reason: 'Network denied by default.', requiresApproval: false };
        if (this.policy.network.mode === 'deny_all') {
            return { decision: 'deny', reason: 'Network denied by strict policy.', requiresApproval: false };
        }
        if (this.policy.network.allowedHosts && this.policy.network.allowedHosts.includes(host)) {
            return { decision: 'allow', matchedRule: host, reason: 'Host is allowlisted.', requiresApproval: false };
        }
        return { decision: 'ask', reason: 'Host not explicitly recognized.', requiresApproval: true };
    }
}
