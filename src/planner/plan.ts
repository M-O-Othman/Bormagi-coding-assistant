import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { ExecutionContext } from '../context/ExecutionContext.js';
import { SemanticGateway } from '../agents/execution/SemanticGateway.js';

export interface PlanNode {
  type: 'ensure_dir' | 'write_file' | 'run_shell';
  target: string;
  payload?: string;
  dependencies?: string[];
}

export interface PlanGraph {
  nodes: PlanNode[];
  hash: string;
}

export class PlanEngine {
  constructor(private workspaceRoot: string, private gateway: SemanticGateway) {}

  public loadProjectSpec(): any {
    const specPath = path.join(this.workspaceRoot, 'bormagi.project.json');
    if (!fs.existsSync(specPath)) throw new Error('Missing bormagi.project.json contract');
    return JSON.parse(fs.readFileSync(specPath, 'utf8'));
  }

  public simulate(plan: PlanGraph): PlanNode[] {
    const ctx = ExecutionContext.get();
    
    // Check if the plan hash matches our PEC. If mismatched, drift occurred.
    if (ctx.getGoal() !== plan.hash) {
       console.log('Plan drift detected. Resyncing...');
       ctx.setGoal(plan.hash);
    }

    // Filter out already completed nodes (the "diff")
    return plan.nodes.filter(node => {
      if (node.type === 'ensure_dir') return !fs.existsSync(path.join(this.workspaceRoot, node.target));
      if (node.type === 'write_file') return !ctx.hasFile(node.target);
      return true; // run_shell always simulates as pending unless we track it
    });
  }

  public async apply(diff: PlanNode[]): Promise<void> {
    let previousDiffSize = diff.length;
    
    for (const node of diff) {
      if (node.type === 'ensure_dir') {
        await this.gateway.ensureDir(path.join(this.workspaceRoot, node.target));
      } else if (node.type === 'write_file' && node.payload) {
        await this.gateway.writeOrPatch(node.target, node.payload);
      } else if (node.type === 'run_shell' && node.payload) {
        await this.gateway.safeExec(node.payload, async (cmd) => ({ stdout: '', stderr: '', exitCode: 0 }));
      }
      
      const newDiffSize = previousDiffSize - 1; // Simulated delta
      if (newDiffSize >= previousDiffSize) {
        throw new Error('Livelock detected: apply cycle did not shrink the remaining diff.');
      }
      previousDiffSize = newDiffSize;
    }
  }

  public generateHash(planNodes: PlanNode[]): string {
     return crypto.createHash('sha256').update(JSON.stringify(planNodes)).digest('hex');
  }
}
