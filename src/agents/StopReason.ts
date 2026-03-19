export type StopReason =
    | 'completed'
    | 'step_budget_reached'
    | 'blocked'
    | 'awaiting_user_decision'
    | 'user_interrupted'
    | 'diagnostic_answer_only';

export function renderStopReason(reason: StopReason): string {
    switch (reason) {
        case 'completed':
            return 'Completed — all planned implementation artifacts are done.';
        case 'step_budget_reached':
            return 'Paused — autonomous step budget reached. Say continue to proceed.';
        case 'blocked':
            return 'Paused — blocked by a missing dependency, input, or tool capability.';
        case 'awaiting_user_decision':
            return 'Paused — waiting for your decision on scope or direction.';
        case 'diagnostic_answer_only':
            return 'Answered your question. No files were modified.';
        default:
            return 'Paused.';
    }
}