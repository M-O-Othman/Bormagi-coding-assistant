// ─── Project state builder ───────────────────────────────────────────────────
//
// Generates a compact project state bundle from the workspace.
// Scans for high-value files (README, package.json, configs, docs)
// and produces a Markdown summary + JSON structured data.
// Stored at .bormagi/project-state.md and .bormagi/project-state.json

import * as fs from 'fs';
import * as path from 'path';

/** Files to consider high-value for the project state. */
const HIGH_VALUE_PATTERNS: RegExp[] = [
    /^readme\.md$/i,
    /^package\.json$/i,
    /^tsconfig\.json$/i,
    /^\.env\.example$/i,
    /^dockerfile$/i,
    /^docker-compose\.ya?ml$/i,
    /^\.bormagi\/project\.json$/i,
];

/** Directories containing documentation. */
const DOC_DIRS = ['docs', 'doc', 'documentation'];

/** Max chars to include from each file. */
const MAX_FILE_CHARS = 3000;

export interface ProjectState {
    name: string;
    description: string;
    techStack: string[];
    dependencies: string[];
    scripts: Record<string, string>;
    fileStructure: string[];
    documentation: string[];
    builtAt: string;
}

export class ProjectStateBuilder {
    constructor(private readonly workspaceRoot: string) { }

    /**
     * Build the project state bundle and write to disk.
     */
    async build(): Promise<ProjectState> {
        const state: ProjectState = {
            name: path.basename(this.workspaceRoot),
            description: '',
            techStack: [],
            dependencies: [],
            scripts: {},
            fileStructure: [],
            documentation: [],
            builtAt: new Date().toISOString(),
        };

        // 1. Read package.json for project metadata
        const pkgPath = path.join(this.workspaceRoot, 'package.json');
        if (fs.existsSync(pkgPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                state.name = pkg.name || state.name;
                state.description = pkg.description || '';
                state.dependencies = [
                    ...Object.keys(pkg.dependencies || {}),
                    ...Object.keys(pkg.devDependencies || {}),
                ];
                state.scripts = pkg.scripts || {};
                state.techStack = this.inferTechStack(state.dependencies);
            } catch { /* ignore */ }
        }

        // 2. Scan top-level file structure
        try {
            const entries = fs.readdirSync(this.workspaceRoot, { withFileTypes: true });
            state.fileStructure = entries
                .filter(e => !e.name.startsWith('.') || e.name === '.bormagi')
                .map(e => e.isDirectory() ? `${e.name}/` : e.name)
                .slice(0, 50);
        } catch { /* ignore */ }

        // 3. Read README
        const readmePath = this.findFile('readme.md');
        if (readmePath) {
            state.description = fs.readFileSync(readmePath, 'utf-8').slice(0, MAX_FILE_CHARS);
        }

        // 4. Scan docs/ directory
        for (const docDir of DOC_DIRS) {
            const docPath = path.join(this.workspaceRoot, docDir);
            if (fs.existsSync(docPath) && fs.statSync(docPath).isDirectory()) {
                try {
                    const docs = fs.readdirSync(docPath).filter(f => f.endsWith('.md'));
                    state.documentation = docs.map(f => `${docDir}/${f}`);
                } catch { /* ignore */ }
            }
        }

        // 5. Write bundle files
        await this.writeBundle(state);

        return state;
    }

    /**
     * Get the last built project state (or null if not built).
     */
    getExisting(): ProjectState | null {
        const jsonPath = path.join(this.workspaceRoot, '.bormagi', 'project-state.json');
        if (!fs.existsSync(jsonPath)) { return null; }
        try {
            return JSON.parse(fs.readFileSync(jsonPath, 'utf-8'));
        } catch {
            return null;
        }
    }

    /**
     * Get the markdown summary (or empty string if not built).
     */
    getMarkdownSummary(): string {
        const mdPath = path.join(this.workspaceRoot, '.bormagi', 'project-state.md');
        if (!fs.existsSync(mdPath)) { return ''; }
        try {
            return fs.readFileSync(mdPath, 'utf-8');
        } catch {
            return '';
        }
    }

    // ─── Private ───────────────────────────────────────────────────────────

    private async writeBundle(state: ProjectState): Promise<void> {
        const dir = path.join(this.workspaceRoot, '.bormagi');
        fs.mkdirSync(dir, { recursive: true });

        // JSON bundle
        fs.writeFileSync(
            path.join(dir, 'project-state.json'),
            JSON.stringify(state, null, 2),
            'utf-8'
        );

        // Markdown bundle
        const md = this.generateMarkdown(state);
        fs.writeFileSync(path.join(dir, 'project-state.md'), md, 'utf-8');
    }

    private generateMarkdown(state: ProjectState): string {
        const lines: string[] = [
            `# Project State: ${state.name}`,
            '',
            `> Built: ${state.builtAt}`,
            '',
        ];

        if (state.description) {
            lines.push('## Description', '', state.description.split('\n').slice(0, 10).join('\n'), '');
        }

        if (state.techStack.length > 0) {
            lines.push('## Tech Stack', '', state.techStack.map(t => `- ${t}`).join('\n'), '');
        }

        if (Object.keys(state.scripts).length > 0) {
            lines.push('## Available Scripts', '');
            for (const [name, cmd] of Object.entries(state.scripts)) {
                lines.push(`- \`npm run ${name}\` → \`${cmd}\``);
            }
            lines.push('');
        }

        if (state.fileStructure.length > 0) {
            lines.push('## File Structure', '', '```', ...state.fileStructure, '```', '');
        }

        if (state.documentation.length > 0) {
            lines.push('## Documentation', '', state.documentation.map(d => `- ${d}`).join('\n'), '');
        }

        return lines.join('\n');
    }

    private inferTechStack(deps: string[]): string[] {
        const stack: string[] = [];
        const depSet = new Set(deps);

        if (depSet.has('typescript') || depSet.has('ts-loader')) { stack.push('TypeScript'); }
        if (depSet.has('react') || depSet.has('react-dom')) { stack.push('React'); }
        if (depSet.has('next')) { stack.push('Next.js'); }
        if (depSet.has('vue')) { stack.push('Vue.js'); }
        if (depSet.has('express') || depSet.has('fastify')) { stack.push('Node.js Server'); }
        if (depSet.has('jest') || depSet.has('vitest')) { stack.push('Testing'); }
        if (depSet.has('webpack') || depSet.has('vite')) { stack.push('Bundler'); }
        if (depSet.has('eslint')) { stack.push('Linting'); }

        return stack;
    }

    private findFile(name: string): string | null {
        const candidates = fs.readdirSync(this.workspaceRoot);
        const match = candidates.find(f => f.toLowerCase() === name.toLowerCase());
        return match ? path.join(this.workspaceRoot, match) : null;
    }
}
