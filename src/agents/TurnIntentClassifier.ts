export type TurnIntent =
    | 'continue_task'
    | 'diagnostic_question'
    | 'status_question'
    | 'modify_scope'
    | 'new_task';

export function classifyTurnIntent(text: string): TurnIntent {
    const t = text.trim().toLowerCase();

    if (t === 'continue' || t === 'go on' || t === 'resume implementation') {
        return 'continue_task';
    }

    if (t.includes('why did you stop') || t.includes('what happened') || t.includes('why did it pause')) {
        return 'diagnostic_question';
    }

    if (t.includes('status') || t.includes('what have you done so far')) {
        return 'status_question';
    }

    if (t.includes('instead') || t.includes('change') || t.includes('separate html from js')) {
        return 'modify_scope';
    }

    return 'new_task';
}