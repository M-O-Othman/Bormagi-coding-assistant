/**
 * Finite state machine for the agent execution loop.
 *
 * Enforces that the agent progresses through phases in a deterministic order.
 * The FSM guarantees:
 * - Discovery cannot exceed maxDiscoveryReads without transitioning
 * - Execution cannot start without passing the readiness gate
 * - The agent cannot loop in any phase indefinitely
 */

import type { ExecutionStateData } from '../ExecutionStateManager';

export type AgentPhase =
  | 'ORIENT'           // Load repo map, inject resolved inputs
  | 'DISCOVER'         // Read specific files (capped)
  | 'READINESS_CHECK'  // Verify all needed context is loaded
  | 'PLAN_BATCH'       // Declare file batch
  | 'EXECUTE'          // Write files
  | 'VALIDATE'         // Run lint/test after write
  | 'ADVANCE'          // Move to next batch file
  | 'COMPLETE'         // All work done
  | 'BLOCKED';         // Cannot proceed — needs human input

interface FSMTransition {
  from: AgentPhase;
  to: AgentPhase;
  guard: (state: ExecutionStateData, ctx: FSMContext) => boolean;
  onTransition?: (state: ExecutionStateData, ctx: FSMContext) => void;
}

export interface FSMContext {
  maxDiscoveryReads: number;
  discoveryReadsUsed: number;
  writesThisSession: number;
  batchRemaining: string[];
  readinessResult: { ready: boolean; missing: string[] };
}

const TRANSITIONS: FSMTransition[] = [
  // ORIENT -> DISCOVER: repo map loaded
  {
    from: 'ORIENT',
    to: 'DISCOVER',
    guard: (_s, _ctx) => true, // always transition after orient
  },

  // DISCOVER -> READINESS_CHECK: at least one file read
  {
    from: 'DISCOVER',
    to: 'READINESS_CHECK',
    guard: (s, _ctx) => s.resolvedInputs.length >= 1,
  },

  // DISCOVER -> BLOCKED: exceeded read cap with no progress
  {
    from: 'DISCOVER',
    to: 'BLOCKED',
    guard: (_s, ctx) => ctx.discoveryReadsUsed >= ctx.maxDiscoveryReads,
  },

  // READINESS_CHECK -> PLAN_BATCH: ready to write
  {
    from: 'READINESS_CHECK',
    to: 'PLAN_BATCH',
    guard: (_s, ctx) => ctx.readinessResult.ready,
  },

  // READINESS_CHECK -> DISCOVER: missing files (one more attempt)
  {
    from: 'READINESS_CHECK',
    to: 'DISCOVER',
    guard: (_s, ctx) =>
      !ctx.readinessResult.ready && ctx.discoveryReadsUsed < ctx.maxDiscoveryReads,
  },

  // READINESS_CHECK -> BLOCKED: not ready and out of reads
  {
    from: 'READINESS_CHECK',
    to: 'BLOCKED',
    guard: (_s, ctx) =>
      !ctx.readinessResult.ready && ctx.discoveryReadsUsed >= ctx.maxDiscoveryReads,
  },

  // PLAN_BATCH -> EXECUTE: batch declared (or not needed)
  {
    from: 'PLAN_BATCH',
    to: 'EXECUTE',
    guard: (_s, _ctx) => true,
  },

  // EXECUTE -> VALIDATE: file written
  {
    from: 'EXECUTE',
    to: 'VALIDATE',
    guard: (_s, ctx) => ctx.writesThisSession > 0,
  },

  // VALIDATE -> ADVANCE: validation passed (or not configured)
  {
    from: 'VALIDATE',
    to: 'ADVANCE',
    guard: (_s, _ctx) => true,
  },

  // ADVANCE -> EXECUTE: more batch files remaining
  {
    from: 'ADVANCE',
    to: 'EXECUTE',
    guard: (_s, ctx) => ctx.batchRemaining.length > 0,
  },

  // ADVANCE -> COMPLETE: all batch files done
  {
    from: 'ADVANCE',
    to: 'COMPLETE',
    guard: (_s, ctx) => ctx.batchRemaining.length === 0,
  },
];

export class AgentFSM {
  private _phase: AgentPhase = 'ORIENT';
  private readonly transitions: FSMTransition[];
  private readonly history: Array<{ from: AgentPhase; to: AgentPhase; ts: string }> = [];

  constructor() {
    this.transitions = TRANSITIONS;
  }

  get phase(): AgentPhase {
    return this._phase;
  }

  get phaseHistory(): Array<{ from: AgentPhase; to: AgentPhase; ts: string }> {
    return [...this.history];
  }

  /**
   * Attempt to transition to the next phase based on current state.
   * Returns the new phase, or the current phase if no transition is valid.
   */
  advance(state: ExecutionStateData, ctx: FSMContext): AgentPhase {
    for (const t of this.transitions) {
      if (t.from === this._phase && t.guard(state, ctx)) {
        this.history.push({
          from: this._phase,
          to: t.to,
          ts: new Date().toISOString(),
        });
        this._phase = t.to;
        t.onTransition?.(state, ctx);
        return this._phase;
      }
    }
    return this._phase;
  }

  /**
   * Check if the FSM is in a terminal state.
   */
  isTerminal(): boolean {
    return this._phase === 'COMPLETE' || this._phase === 'BLOCKED';
  }

  /**
   * Force a phase (for recovery scenarios).
   */
  forcePhase(phase: AgentPhase): void {
    this.history.push({
      from: this._phase,
      to: phase,
      ts: new Date().toISOString(),
    });
    this._phase = phase;
  }
}
