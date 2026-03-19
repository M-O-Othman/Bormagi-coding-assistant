import * as fs from 'fs/promises';
import * as path from 'path';
import type { ExecutionStateData } from '../ExecutionStateManager';
import { normalizeWorkspacePath } from '../../utils/PathUtils';

export class ArtifactRegistry {
    constructor(private readonly workspaceRoot: string) { }

    private artifactRegistryPath(): string {
        return path.join(this.workspaceRoot, '.bormagi', 'artifact-registry.json');
    }

    async recordArtifact(agentId: string, filePath: string): Promise<void> {
        const normalizedPath = normalizeWorkspacePath(filePath, this.workspaceRoot);
        const registryPath = this.artifactRegistryPath();
        let entries: Array<{ agentId: string; path: string; timestamp: string }> = [];
        try {
            const raw = await fs.readFile(registryPath, 'utf8');
            entries = JSON.parse(raw);
        } catch { /* first run or corrupt — start fresh */ }
        // Avoid duplicate entries for the same path
        if (!entries.some(e => e.path === normalizedPath)) {
            entries.push({ agentId, path: normalizedPath, timestamp: new Date().toISOString() });
            await fs.mkdir(path.dirname(registryPath), { recursive: true });
            await fs.writeFile(registryPath, JSON.stringify(entries, null, 2), 'utf8');
        }
    }

    async loadArtifactPaths(): Promise<Set<string>> {
        try {
            const raw = await fs.readFile(this.artifactRegistryPath(), 'utf8');
            const entries: Array<{ path: string }> = JSON.parse(raw);
            return new Set(entries.map(e => normalizeWorkspacePath(e.path, this.workspaceRoot)));
        } catch {
            return new Set();
        }
    }

    async loadArtifactRegistryNote(): Promise<string> {
        try {
            const raw = await fs.readFile(this.artifactRegistryPath(), 'utf8');
            const entries: Array<{ agentId: string; path: string; timestamp: string }> = JSON.parse(raw);
            const visibleEntries = entries.filter(e => !e.path.replace(/\\/g, '/').startsWith('.bormagi/'));
            if (visibleEntries.length === 0) return '';
            const lines = visibleEntries.map(e => `- ${e.path} (created by ${e.agentId})`).join('\n');
            return `[Artifact Registry — files created in previous sessions]\n${lines}\n\nBefore writing any file, check if it already exists at one of these paths.`;
        } catch {
            return '';
        }
    }

    resolveApprovedPlanPath(execState: ExecutionStateData, registeredArtifactPaths: Set<string>, userMessage: string): string | null {
        const planPathMatch = userMessage.match(/(?:plan|spec)\s+(?:at\s+)?["']?([^\s"']+\.md)["']?/i);
        if (planPathMatch) return normalizeWorkspacePath(planPathMatch[1], this.workspaceRoot);
        for (const artifactPath of registeredArtifactPaths) {
            const norm = artifactPath.replace(/\\/g, '/');
            if (norm.includes('plan') && norm.endsWith('.md')) return norm;
        }
        for (const inputPath of execState.resolvedInputs) {
            const norm = inputPath.replace(/\\/g, '/').toLowerCase();
            if ((norm.includes('plan') || norm.includes('.bormagi/plans/')) && norm.endsWith('.md')) return inputPath;
        }
        return null;
    }
}