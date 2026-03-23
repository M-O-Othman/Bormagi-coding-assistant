import * as fs from 'fs';
import * as path from 'path';

export interface ExecutionContextData {
  createdFiles: Set<string>;
  os: 'win32' | 'linux' | 'darwin';
  recentErrors: string[];
  goal: string;
}

export class ExecutionContext {
  private static singleton: ExecutionContext;
  private data: ExecutionContextData;
  private readonly contextFilePath = path.join('.bormagi', 'context.json');

  private constructor() {
    this.data = this.load();
  }

  public static get(): ExecutionContext {
    if (!this.singleton) {
      this.singleton = new ExecutionContext();
    }
    return this.singleton;
  }

  private load(): ExecutionContextData {
    const defaultData: ExecutionContextData = {
      createdFiles: new Set<string>(),
      os: process.platform as 'win32' | 'linux' | 'darwin',
      recentErrors: [],
      goal: ''
    };

    try {
      if (fs.existsSync(this.contextFilePath)) {
        const fileContent = fs.readFileSync(this.contextFilePath, 'utf-8');
        const parsed = JSON.parse(fileContent);
        
        return {
          createdFiles: new Set<string>(parsed.createdFiles || []),
          os: parsed.os || defaultData.os,
          recentErrors: parsed.recentErrors || [],
          goal: parsed.goal || ''
        };
      }
    } catch (e) {
      console.error(`Failed to load execution context from ${this.contextFilePath}:`, e);
    }
    
    return defaultData;
  }

  public save(): void {
    try {
      const serializableData = {
        createdFiles: Array.from(this.data.createdFiles),
        os: this.data.os,
        recentErrors: this.data.recentErrors,
        goal: this.data.goal
      };
      const dir = path.dirname(this.contextFilePath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(this.contextFilePath, JSON.stringify(serializableData, null, 2), 'utf-8');
    } catch (e) {
      console.error(`Failed to save execution context to ${this.contextFilePath}:`, e);
    }
  }

  public markFileCreated(filePath: string): void {
    this.data.createdFiles.add(path.resolve(filePath));
    this.save();
  }

  public hasFile(filePath: string): boolean {
    return this.data.createdFiles.has(path.resolve(filePath));
  }

  public rememberError(errorMsg: string): void {
    this.data.recentErrors.unshift(errorMsg);
    // Keep only the most recent 10 errors
    if (this.data.recentErrors.length > 10) {
      this.data.recentErrors.pop();
    }
    this.save();
  }

  public getRecentErrors(): string[] {
    return this.data.recentErrors;
  }

  public clearErrors(): void {
    this.data.recentErrors = [];
    this.save();
  }

  public setGoal(goal: string): void {
    this.data.goal = goal;
    this.save();
  }

  public getGoal(): string {
    return this.data.goal;
  }

  public getOs(): 'win32' | 'linux' | 'darwin' {
    return this.data.os;
  }
}
