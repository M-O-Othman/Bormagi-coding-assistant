/**
 * Normalize to a canonical workspace-relative path:
 * - Convert backslashes to forward slashes (Windows compat)
 * - Strip absolute workspace root prefix if the model sends one
 * - Strip leading slashes
 */
export function normalizeWorkspacePath(input: string, workspaceRoot: string): string {
    let p = input.replace(/\\/g, '/');
    const root = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
    if (p.startsWith(root + '/')) {
        p = p.slice(root.length + 1);
    }
    return p.replace(/^\/+/, '');
}