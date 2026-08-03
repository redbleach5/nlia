// ============================================================================
// Helper: describe an embed model by its name prefix.
// ============================================================================

export function describeEmbedModel(modelName: string): string {
  const lower = modelName.toLowerCase();
  if (lower.startsWith('nomic-embed-text')) {
    return 'Быстрая и лёгкая. Хорошо для русского и английского. По умолчанию.';
  }
  if (lower.startsWith('bge-m3')) {
    return 'Мультиязычная, поддерживает 100+ языков. Точнее nomic, но медленнее.';
  }
  if (lower.startsWith('bge-')) {
    return 'Серия BGE — хорошие embedding-модели для разных языков.';
  }
  if (lower.startsWith('mxbai-embed-large')) {
    return 'Высокое качество поиска. Точнее nomic, но требует больше памяти.';
  }
  if (lower.startsWith('snowflake-arctic-embed')) {
    return 'Хорошо для поиска по коду и техническим текстам.';
  }
  if (lower.startsWith('e5-')) {
    return 'Серия E5 от Microsoft. Мультиязычная, хорошего качества.';
  }
  return 'Embedding-модель — используется для запоминания смысла текстов.';
}
