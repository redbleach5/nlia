'use client';

// ============================================================================
// PanelErrorBoundary — React Error Boundary для изоляции сбоев в panel'ах.
// ============================================================================
//
// Если компонент в panel крашится (например, VRM загрузка падает), ошибка
// не уносит весь UI — показываем fallback с кнопкой "попробовать снова".
//
// Используется:
//   - AvatarColumn (VRM краш)
//   - ChatPanel (markdown render краш)
//   - AgentWorkbench (панель агента)

import { Component, type ReactNode } from 'react';
import { AlertCircle, RotateCcw } from 'lucide-react';

type Props = {
  children: ReactNode;
  fallbackTitle?: string;
};

type State = {
  hasError: boolean;
  error: Error | null;
};

export class PanelErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error) {
    console.error('[PanelErrorBoundary]', error);
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null });
  };

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex flex-col items-center justify-center h-full p-6 gap-3">
          <AlertCircle className="w-8 h-8 text-warning" />
          <div className="text-sm font-medium text-foreground">
            {this.props.fallbackTitle ?? 'Что-то сломалось'}
          </div>
          <div className="text-xs text-text-dim text-center max-w-xs">
            Можно попробовать снова — обычно этого достаточно.
          </div>
          <button
            type="button"
            onClick={this.handleRetry}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border hover:border-accent hover:bg-accent/5 text-xs transition-colors"
          >
            <RotateCcw className="w-3 h-3" />
            Попробовать снова
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
