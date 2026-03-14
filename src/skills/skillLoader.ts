import * as fs from 'fs';
import * as path from 'path';

/** Directory containing skill fragment Markdown files. */
const SKILLS_DIR = path.join(__dirname, '.');

/**
 * Load a skill fragment Markdown file by name.
 *
 * Reads from `src/skills/<skillName>.md` at runtime — not compiled in.
 * This allows users to edit skill fragments without recompiling the extension.
 *
 * @param skillName  Skill identifier, e.g. 'codebase-navigator'. No path separators or `.md` extension.
 * @returns The Markdown content of the skill, or `null` if the skill file does not exist.
 */
export function loadSkillFragment(skillName: string): string | null {
  // Sanitise: only allow alphanumeric and hyphens to prevent path traversal
  if (!/^[a-z0-9-]+$/.test(skillName)) {
    return null;
  }
  const filePath = path.join(SKILLS_DIR, `${skillName}.md`);
  try {
    return fs.readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/** Known skill names for discoverability. */
export const KNOWN_SKILLS = [
  'codebase-navigator',
  'implement-feature',
  'bug-investigator',
  'dependency-auditor',
] as const;

export type SkillName = typeof KNOWN_SKILLS[number];
