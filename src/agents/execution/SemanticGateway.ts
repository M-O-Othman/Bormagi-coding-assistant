import * as path from 'path';
import { ExecutionContext } from '../../context/ExecutionContext.js';
import { FsOps } from '../../utils/fsOps.js';

export class SemanticGateway {
  private workspaceRoot: string;

  constructor(workspaceRoot: string) {
    this.workspaceRoot = workspaceRoot;
  }

  public async ensureDir(targetPath: string): Promise<string> {
    await FsOps.ensureDir(targetPath);
    return `Directories ensured via FsOps for: ${targetPath}`;
  }

  public async writeOrPatch(targetPath: string, content: string): Promise<string> {
    const fullPath = path.isAbsolute(targetPath) ? targetPath : path.join(this.workspaceRoot, targetPath);
    const ctx = ExecutionContext.get();
    
    // Simplistic patch or write logic based on PEC context
    if (ctx.hasFile(targetPath)) {
        await FsOps.writeUnique(fullPath, content, true); // fallback to overwrite patched
        return `Patched/overwrote existing file: ${targetPath}`;
    } else {
        await FsOps.writeUnique(fullPath, content, false);
        return `Created new file: ${targetPath}`;
    }
  }

  public async safeExec(command: string, execWrapperCmd: (cmd: string) => Promise<any>): Promise<string> {
      // Basic block of raw Unix commands
      if (/ls\s+-|cat\s+|grep/i.test(command)) {
          throw new Error('Raw inspection commands are restricted. Use appropriate list_dir or grep tools.');
      }
      const res = await execWrapperCmd(command);
      return `Exit Code: ${res.exitCode}\nSTDOUT:\n${res.stdout}\nSTDERR:\n${res.stderr}`;
  }
}
