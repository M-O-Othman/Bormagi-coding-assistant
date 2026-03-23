import * as fs from 'fs/promises';
import { existsSync } from 'fs';
import * as path from 'path';
import { ExecutionContext } from '../context/ExecutionContext';
import { diffLines, Change } from 'diff';

export class FsOpsError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message);
    this.name = 'FsOpsError';
  }
}

export class FsOps {
  private static get context(): ExecutionContext {
    return ExecutionContext.get();
  }

  /**
   * Ensures a directory exists, creating it if necessary.
   * Safe across platforms, uses fs.promises.mkdir with recursive: true.
   */
  public static async ensureDir(dirPath: string): Promise<void> {
    try {
      const resolved = path.resolve(dirPath);
      await fs.mkdir(resolved, { recursive: true });
    } catch (error: any) {
      this.context.rememberError(`ensureDir failed for ${dirPath}: ${error.message}`);
      throw new FsOpsError(`Failed to ensure directory ${dirPath}: ${error.message}`, 'MKDIR_FAILED');
    }
  }

  /**
   * Writes content to a file. 
   * If the file already exists and overwrite is false (default), it will throw an error.
   */
  public static async writeUnique(filePath: string, content: string, overwrite: boolean = false): Promise<void> {
    const resolved = path.resolve(filePath);
    
    try {
      if (!overwrite && existsSync(resolved)) {
        throw new Error('File already exists. Use patchText or set overwrite to true.');
      }
      
      // Ensure the parent directory exists
      await this.ensureDir(path.dirname(resolved));
      
      await fs.writeFile(resolved, content, 'utf-8');
      this.context.markFileCreated(resolved);
    } catch (error: any) {
      this.context.rememberError(`writeUnique failed for ${filePath}: ${error.message}`);
      throw new FsOpsError(`Failed to write file ${filePath}: ${error.message}`, 'WRITE_FAILED');
    }
  }

  /**
   * Reads a file. Throws if missing.
   */
  public static async readFile(filePath: string): Promise<string> {
    try {
      const resolved = path.resolve(filePath);
      return await fs.readFile(resolved, 'utf-8');
    } catch (error: any) {
      this.context.rememberError(`readFile failed for ${filePath}: ${error.message}`);
      throw new FsOpsError(`Failed to read file ${filePath}: ${error.message}`, 'READ_FAILED');
    }
  }

  /**
   * Concept for diff-based patching (basic replace or apply diff)
   * A true agent patcher would apply diff or search/replace logic.
   * For simplicity here we implement a simple string replacement patch.
   */
  public static async patchText(filePath: string, searchStr: string, replaceStr: string): Promise<void> {
    const resolved = path.resolve(filePath);
    try {
      if (!existsSync(resolved)) {
        throw new Error('File does not exist. Cannot patch.');
      }
      
      let content = await fs.readFile(resolved, 'utf-8');
      if (!content.includes(searchStr)) {
        throw new Error('Search string not found in file.');
      }
      
      content = content.replace(searchStr, replaceStr);
      await fs.writeFile(resolved, content, 'utf-8');
    } catch (error: any) {
      this.context.rememberError(`patchText failed for ${filePath}: ${error.message}`);
      throw new FsOpsError(`Failed to patch file ${filePath}: ${error.message}`, 'PATCH_FAILED');
    }
  }
}
