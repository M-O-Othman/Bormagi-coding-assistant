import * as fs from 'fs';
import * as path from 'path';
import { PolicyContext, PolicyResult } from './types';

interface PolicyConfig {
    commands: {
        deny: string[];
        allow: string[];
    }
}

export class PolicyEngine {
    private config: PolicyConfig;

    constructor(workspaceRoot: string) {
        this.config = this.loadConfig(workspaceRoot);
    }

    private loadConfig(workspaceRoot: string): PolicyConfig {
        const customPath = path.join(workspaceRoot, '.bormagi', 'policies', 'sandbox.policy.json');
        const defaultPath = path.join(__dirname, '..', '..', 'data', 'default-sandbox-policy.json');

        if (fs.existsSync(customPath)) {
            try {
                return JSON.parse(fs.readFileSync(customPath, 'utf-8'));
            } catch (err) {
                console.warn(`Failed to parse custom policy at ${customPath}. Falling back to default.`);
            }
        }

        if (fs.existsSync(defaultPath)) {
            try {
                return JSON.parse(fs.readFileSync(defaultPath, 'utf-8'));
            } catch (err) {
                console.warn(`Failed to parse default policy at ${defaultPath}. Using hardcoded fallback.`);
            }
        }

        return { commands: { deny: ["\\brm\\s+-rf\\b", "\\bsudo\\b"], allow: ["^git status", "^git diff"] } };
    }

    async evaluate(ctx: PolicyContext): Promise<PolicyResult> {
        if (ctx.actionKind === 'exec_command' && ctx.command) {
            const denyPatterns = this.config.commands.deny.map(p => new RegExp(p, 'i'));
            if (denyPatterns.some(re => re.test(ctx.command!))) {
                return { decision: 'deny', matchedRule: 'HIGH_RISK_COMMAND', reason: 'Command matches known high-risk destructive patterns.', requiresApproval: false };
            }

            const allowPatterns = this.config.commands.allow.map(p => new RegExp(p, 'i'));
            if (allowPatterns.some(re => re.test(ctx.command!))) {
                return { decision: 'allow', matchedRule: 'SAFE_READONLY_COMMAND', reason: 'Command is a known safe read-only operation.', requiresApproval: false };
            }

            return { decision: 'ask', matchedRule: 'UNKNOWN_COMMAND', reason: 'Command requires user approval before execution.', requiresApproval: true };
        }

        if (ctx.actionKind === 'write_file') {
            return {
                decision: 'ask',
                reason: 'File modifications require user approval',
                requiresApproval: true
            };
        }

        return {
            decision: 'allow',
            reason: 'Default allow policy',
            requiresApproval: false
        };
    }
}