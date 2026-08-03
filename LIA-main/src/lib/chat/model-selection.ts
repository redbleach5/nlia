import 'server-only';

// ============================================================================
// Auto model selection — secondary for trivial companion turns.
// ============================================================================
//
// Rules:
//   - complexity === 'trivial'  → secondary (small) if available
//   - otherwise                → primary (chat / day)
//
// Heavy escalate is **agent brain only** (plan / replan / loop execute).
// Companion chat keeps day model for liveness (latency + voice) — see
// docs/AGENT-MODEL.md and model-escalate.ts (mode: 'agent').
//
// Secondary unset → fall back to primary (no error).
// Tier micro: skip secondary (primary already small).

import { logger } from '@/lib/logger';
import { checkOllamaHealth, getOllamaSettings, setOllamaSettings } from '@/lib/ollama';
import type { Tier } from '@/lib/capability-profile';
import type { TaskComplexity } from '@/lib/task-complexity';

const TIERS_OK_FOR_SECONDARY: Tier[] = ['standard', 'plus', 'max'];

/**
 * Get the configured secondary (small) model name, if any.
 */
export async function getSecondaryModelName(): Promise<string | null> {
  try {
    const settings = await getOllamaSettings();
    const val = settings.secondaryModel?.trim();
    return val || null;
  } catch {
    return null;
  }
}

/**
 * Set or clear the secondary model. Pass null to disable.
 */
export async function setSecondaryModelName(model: string | null): Promise<void> {
  await setOllamaSettings({ secondaryModel: model ?? '' });
}

export interface ModelChoice {
  /** Final model name to pass to getChatModel() / streamText */
  modelName: string;
  /** Why this model was chosen — for logging/UI */
  reason:
    | 'trivial-use-secondary'
    | 'no-secondary-configured'
    | 'tier-too-small'
    | 'secondary-not-pulled'
    | 'primary';
  /** Whether the secondary model was used */
  usedSecondary: boolean;
  /**
   * Always false for companion chat — heavy is agent-only (brain/face split).
   * Kept on the type so stream/pipeline code stays uniform.
   */
  usedHeavy: boolean;
  /** Configured secondary model name (may differ from chosen if not available) */
  secondaryModelName: string | null;
  /** Configured heavy (null if unset) — informational; not used for chat stream */
  heavyModelName: string | null;
}

function baseChoice(
  modelName: string,
  reason: ModelChoice['reason'],
  extras: Partial<ModelChoice> = {},
): ModelChoice {
  return {
    modelName,
    reason,
    usedSecondary: false,
    usedHeavy: false,
    secondaryModelName: extras.secondaryModelName ?? null,
    heavyModelName: extras.heavyModelName ?? null,
    ...extras,
  };
}

/**
 * Decide which model to use for the companion streamText call.
 * Does not escalate to heavy — that path is agent brain only.
 */
export async function chooseModelForQuery(
  complexity: TaskComplexity,
  tier: Tier,
): Promise<ModelChoice> {
  const settings = await getOllamaSettings();
  const secondary = await getSecondaryModelName();
  const heavyName = settings.heavyModel?.trim() || null;

  if (complexity === 'trivial') {
    if (!TIERS_OK_FOR_SECONDARY.includes(tier)) {
      return baseChoice(settings.model, 'tier-too-small', {
        secondaryModelName: secondary,
        heavyModelName: heavyName,
      });
    }
    if (!secondary) {
      return baseChoice(settings.model, 'no-secondary-configured', {
        secondaryModelName: null,
        heavyModelName: heavyName,
      });
    }
    const health = await checkOllamaHealth({ timeoutMs: 5_000 });
    if (!health.ok || !health.models.includes(secondary)) {
      logger.warn('chat', 'Secondary model not available, falling back to primary', {
        secondary,
        available: health.models.length,
      });
      return baseChoice(settings.model, 'secondary-not-pulled', {
        secondaryModelName: secondary,
        heavyModelName: heavyName,
      });
    }
    return baseChoice(secondary, 'trivial-use-secondary', {
      usedSecondary: true,
      secondaryModelName: secondary,
      heavyModelName: heavyName,
    });
  }

  return baseChoice(settings.model, 'primary', {
    secondaryModelName: secondary,
    heavyModelName: heavyName,
  });
}
