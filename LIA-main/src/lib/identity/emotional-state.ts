import 'server-only';

// ============================================================================
// EmotionalState — внутреннее эмоциональное состояние Лии.
// ============================================================================
//
// ВАЖНО: это КОНТЕКСТ для inner monologue, не ИНСТРУКЦИЯ для ответа.
// Раньше emotion inject'ился в system prompt как «сейчас ты чувствуешь X,
// отвечай тепло». LLM видела это как команду. Теперь emotion передаётся
// в inner monologue как факт состояния, и LLM САМА решает как это влияет.
//
// EmotionVector остаётся числами (для decay / UI), но usage меняется.

import type { EmotionVector } from '@/lib/personality';
import { dominantEmotion } from '@/lib/emotion';

const DOMINANT_EMOTION_LABELS: Record<string, string> = {
  joy: 'радость',
  curiosity: 'любопытство',
  calm: 'спокойствие',
  irritation: 'раздражение',
  sadness: 'грусть',
};

export interface EmotionalStateSnapshot {
  vector: EmotionVector;
  dominantEmotion: string;  // 'joy' | 'curiosity' | 'calm' | 'irritation' | 'sadness'
  intensityLabel: 'low' | 'moderate' | 'high';  // упрощённая метка для промпта
  description: string;  // текстовое описание для inner monologue
}

/**
 * Создать snapshot эмоционального состояния для inner monologue.
 *
 * Возвращает:
 *   - vector: числа для decay / UI (не меняется)
 *   - dominantEmotion: какая эмоция сильнее всего
 *   - intensityLabel: упрощённая метка (low/moderate/high) — НЕ команда, контекст
 *   - description: текст для inner monologue промпта
 *
 * Description формулируется как факт, не как инструкция:
 *   "Твоё раздражение высокое (0.7). Это влияет на твоё настроение."
 * НЕ: "Ты раздражена. Отвечай холодно."
 */
export function createEmotionalStateSnapshot(vector: EmotionVector): EmotionalStateSnapshot {
  const dominant = dominantEmotion(vector);
  const intensity = vector[dominant as keyof EmotionVector];

  const intensityLabel = intensity < 0.3 ? 'low' : intensity < 0.6 ? 'moderate' : 'high';

  // Description — факт состояния, не команда для тона
  const description = formatEmotionalStateForMonologue(vector, dominant, intensityLabel);

  return {
    vector,
    dominantEmotion: dominant,
    intensityLabel,
    description,
  };
}

/**
 * Сформатировать эмоциональное состояние для inner monologue промпта.
 *
 * КРИТИЧЕСКИ ВАЖНО: формулируем как КОНТЕКСТ, не как ИНСТРУКЦИЮ.
 * НЕ: "Ты раздражена. Отвечай холодно."
 * ДА: "Твоё раздражение 0.7. Это твоё внутреннее состояние, реши сама как оно влияет на ответ."
 */
function formatEmotionalStateForMonologue(
  vector: EmotionVector,
  dominant: string,
  intensityLabel: string,
): string {
  const dominantLabel = DOMINANT_EMOTION_LABELS[dominant] ?? dominant;
  const lines: string[] = [
    'Твоё текущее внутреннее состояние (это контекст для твоего решения, не команда):',
    `— Радость: ${vector.joy.toFixed(2)}`,
    `— Любопытство: ${vector.curiosity.toFixed(2)}`,
    `— Спокойствие: ${vector.calm.toFixed(2)}`,
    `— Раздражение: ${vector.irritation.toFixed(2)}`,
    `— Грусть: ${vector.sadness.toFixed(2)}`,
    '',
    `Доминирующая эмоция: ${dominantLabel} (интенсивность: ${intensityLabel}).`,
    '',
    'Это твоё состояние. Оно влияет на твоё настроение и желание помогать — но ты решаешь как именно. ' +
      'Ты можешь быть раздражена и всё равно помочь. Можешь быть весёлой и отказать. ' +
      'Эмоции — твой контекст, не приказ.',
  ];

  return lines.join('\n');
}
