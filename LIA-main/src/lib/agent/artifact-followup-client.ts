/**
 * Client-safe follow-up detectors (no Node / DB).
 * Server helpers live in artifact-followup.ts.
 */

const END = '(?!\\p{L}|\\p{N})';

/** User wants to open / play / show a previously created artifact. */
export function isOpenOrShowArtifactGoal(goal: string): boolean {
  const g = goal.toLowerCase().trim();
  const openVerb = new RegExp(
    `^(можешь\\s+)?(открыть|открой|запустить|запусти|показать|покажи|play|open)${END}`
    + `|\\b(play|open)\\b`
    + `|(открыть|открой|запусти|запустить|покажи|показать)${END}`,
    'iu',
  ).test(g);
  const artifactRef = new RegExp(
    `(игр[уыа]|файл|html|сайт|результат|артефакт|это|эту|этот|её|ее|его|то\\s+что|что\\s+получилось)${END}`
    + `|\\.(html?|css|js)\\b`,
    'iu',
  ).test(g) || g.length < 48;
  return openVerb && artifactRef;
}

/**
 * Debug / fix follow-up about recent work («игра не работает», «разберись почему»).
 */
export function isFixOrDebugArtifactGoal(goal: string): boolean {
  const g = goal.toLowerCase().trim();
  const broken = new RegExp(
    `(не\\s+работает|не\\s+запуска|сломал|баг|ошибк|почини|исправь|разберись|почему\\s+не|fix\\b|debug)${END}`,
    'iu',
  ).test(g);
  if (!broken) return false;
  // Avoid hijacking unrelated «почему не работает wifi» without artifact cues —
  // but short debug lines after an agent task are almost always about last artifact.
  const artifactCue = new RegExp(
    `(игр[уыа]|тетрис|файл|код|html|скрипт|сайт|это|эту|этот|её|ее|его)${END}`
    + `|\\.(html?|css|js)\\b`,
    'iu',
  ).test(g);
  return artifactCue || g.length < 80;
}

/** Goal refers to prior work in this chat. */
export function isReferentialWorkspaceGoal(goal: string): boolean {
  const g = goal.toLowerCase();
  if (isOpenOrShowArtifactGoal(g)) return true;
  if (isFixOrDebugArtifactGoal(g)) return true;
  return new RegExp(
    `(эту|этот|это|её|ее|его|ту\\s+игр|тот\\s+файл|предыдущ|только\\s+что)${END}`,
    'iu',
  ).test(g);
}

/** Follow-ups that should not start a blind KB hunt without sandbox. */
export function isArtifactFollowUpGoal(goal: string): boolean {
  return isOpenOrShowArtifactGoal(goal) || isFixOrDebugArtifactGoal(goal) || isReferentialWorkspaceGoal(goal);
}

/**
 * Whether an agent turn in this episode should reuse the last sandbox with files
 * instead of fsScope=none or a brand-new empty sandbox.
 *
 * Fresh «создай игру с нуля» → false (new tree).
 * Fix / open / «улучши» / referential → true.
 * Unrelated (новости, KB lookup) → false (do not hijack).
 */
export function shouldReuseRecentEpisodeSandbox(goal: string): boolean {
  if (isOpenOrShowArtifactGoal(goal) || isFixOrDebugArtifactGoal(goal) || isReferentialWorkspaceGoal(goal)) {
    return true;
  }
  const g = goal.toLowerCase();
  // Improve / tweak prior artifact without explicit «эту»
  if (/улучш|доработ|передел|перепис|добавь|поменя|измен|обнов|подкрути|polish|improve|tweak/.test(g)) {
    return true;
  }
  // From-scratch creation → new empty sandbox
  const createVerb = /напиш|создай|сделай|реализу|сгенер|implement|write\b|create\b|build\b|scaffold/.test(g);
  const artifact =
    /игр[уыа]|тетрис|tetris|сайт|лендинг|landing|приложен|страниц|html|css|компонент|модул/.test(g)
    || /\.(html?|css|tsx?|jsx?)\b/.test(g);
  if (createVerb && artifact) return false;
  return false;
}
