import { exec } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs';

const execAsync = promisify(exec);

export interface ValidationDiagnostic {
    source: "eslint" | "tsc" | "pytest" | "custom" | "npm test";
    severity: "error" | "warning" | "info";
    file?: string;
    line?: number;
    column?: number;
    code?: string;
    message: string;
}

export interface ValidationResult {
    ok: boolean;
    diagnostics: ValidationDiagnostic[];
    rawOutput: string;
}

export class ValidationService {
    constructor(private workspaceRoot: string) { }

    /** Find known testing frameworks in the ecosystem */
    private autoDetectCommands(): string[] {
        const commands: string[] = [];
        const packageJsonPath = path.join(this.workspaceRoot, 'package.json');

        if (fs.existsSync(packageJsonPath)) {
            try {
                const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
                if (pkg.scripts) {
                    if (pkg.scripts.lint) commands.push('npm run lint');
                    if (pkg.scripts.test) commands.push('npm run test');
                    if (pkg.scripts.typecheck) commands.push('npm run typecheck');
                }
            } catch (e) {
                // Ignore parse errors
            }
        }
        return commands;
    }

    /** Run validation commands. FR-054/055 */
    public async run(changedFiles: string[]): Promise<ValidationResult> {
        const commands = this.autoDetectCommands();
        if (commands.length === 0) {
            return {
                ok: true,
                diagnostics: [{
                    source: "custom",
                    severity: "info",
                    message: "No standard validation commands auto-detected (e.g. package.json scripts missing)."
                }],
                rawOutput: ""
            };
        }

        let totalOutput = '';
        const diagnostics: ValidationDiagnostic[] = [];
        let allOk = true;

        for (const cmd of commands) {
            try {
                const { stdout, stderr } = await execAsync(cmd, { cwd: this.workspaceRoot });
                totalOutput += `\n=== ${cmd} Output ===\n${stdout}\n${stderr}`;
            } catch (err: any) {
                allOk = false;
                const output = err.stdout + '\n' + err.stderr;
                totalOutput += `\n=== ${cmd} Failed ===\n${output}`;

                // Extremely naive diagnostic parsing for now
                diagnostics.push({
                    source: "npm test",
                    severity: "error",
                    message: `Command '${cmd}' failed with exit code ${err.code}. See raw output for details.`
                });
            }
        }

        return {
            ok: allOk,
            diagnostics,
            rawOutput: totalOutput
        };
    }
}
