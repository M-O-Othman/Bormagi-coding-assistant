import * as fs from 'fs';
import * as path from 'path';
import { resolveInstructions } from '../../../src/context/InstructionResolver';

describe('InstructionResolver', () => {
    let testCwd: string;

    beforeAll(() => {
        testCwd = path.join(__dirname, 'test-instructions-' + Date.now());
        fs.mkdirSync(testCwd, { recursive: true });

        // Setup .bormagi/instructions
        const bormagiDir = path.join(testCwd, '.bormagi', 'instructions');
        fs.mkdirSync(bormagiDir, { recursive: true });
        fs.writeFileSync(path.join(bormagiDir, 'global.md'), 'Global rules apply anywhere.');

        // Setup .github/instructions
        const githubDir = path.join(testCwd, '.github', 'instructions');
        fs.mkdirSync(githubDir, { recursive: true });

        fs.writeFileSync(path.join(testCwd, '.github', 'copilot-instructions.md'), 'Copilot legacy rules.');

        const scopedYaml = `---
applyTo: ["src/backend/**", "*.ts"]
---
Backend specific rules only for TS modifications.`;
        fs.writeFileSync(path.join(githubDir, 'backend.instructions.md'), scopedYaml);

        const frontendYaml = `---
applyTo: ["src/ui/**"]
---
Frontend specific rules.`;
        fs.writeFileSync(path.join(githubDir, 'frontend.instructions.md'), frontendYaml);
    });

    afterAll(() => {
        if (fs.existsSync(testCwd)) {
            fs.rmSync(testCwd, { recursive: true, force: true });
        }
    });

    it('loads global and copilot instructions when no candidates match', () => {
        const result = resolveInstructions(testCwd, []);
        expect(result.merged).toContain('Global rules apply anywhere.');
        expect(result.merged).toContain('Copilot legacy rules.');
        expect(result.merged).not.toContain('Backend specific rules');
        expect(result.merged).not.toContain('Frontend specific rules');
    });

    it('loads scoped backend instructions when candidate matches', () => {
        const result = resolveInstructions(testCwd, ['src/backend/server.ts']);
        expect(result.merged).toContain('Global rules apply anywhere.');
        expect(result.merged).toContain('Backend specific rules only for TS modifications.');
        expect(result.merged).not.toContain('Frontend specific rules');
    });

    it('loads multiple scoped instructions when multiple candidates match', () => {
        const result = resolveInstructions(testCwd, ['src/backend/server.ts', 'src/ui/Button.tsx']);
        expect(result.merged).toContain('Backend specific rules only for TS modifications.');
        expect(result.merged).toContain('Frontend specific rules.');
    });
});
