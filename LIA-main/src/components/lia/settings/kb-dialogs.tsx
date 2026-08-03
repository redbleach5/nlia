'use client';

// ============================================================================
// KB dialogs — modal dialogs for adding sources.
// ============================================================================
//
// Extracted from KbTab. Each dialog is a self-contained component that
// manages its own form state and calls the corresponding hook action.
//
// Shared ModalShell provides consistent styling: backdrop, close button,
// max-width container. Renders via createPortal(document.body) so nested
// dialogs are not clipped by Settings DialogContent (transform/overflow).

import { useState, useRef, useEffect } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import {
  Loader2, Plus, FolderOpen, Link as LinkIcon, Upload,
  FileText, CheckCircle2, X,
} from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { folderBasename, type KbSource } from './use-kb-sources';

// ── Shared modal shell ──

interface ModalShellProps {
  title: string;
  icon?: React.ReactNode;
  onClose: () => void;
  children: React.ReactNode;
  maxWidth?: 'md' | 'lg';
  /** @deprecated Always scrolls when content exceeds viewport. Kept for call-site compat. */
  scrollable?: boolean;
}

function ModalShell({ title, icon, onClose, children, maxWidth = 'md' }: ModalShellProps) {
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
  }, []);

  // Capture-phase Escape so the parent Settings Dialog does not also close.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      onClose();
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  if (!mounted) return null;

  // Portal to body: nested inside Settings DialogContent (which uses transform)
  // would otherwise clip position:fixed and overflow.
  // pointer-events-auto: Radix Dialog sets body { pointer-events: none }; without
  // this, clicks fall through the overlay and the close button appears dead.
  return createPortal(
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4 pointer-events-auto"
      role="presentation"
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn(
          'bg-popover border border-border rounded-lg w-full shadow-lg pointer-events-auto',
          'flex flex-col max-h-[min(90vh,760px)]',
          maxWidth === 'lg' ? 'max-w-lg' : 'max-w-md',
        )}
      >
        <div className="flex items-center justify-between shrink-0 px-6 pt-5 pb-3">
          <h3 className="text-sm font-medium flex items-center gap-2">
            {icon}
            {title}
          </h3>
          <button
            type="button"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onClose();
            }}
            className="inline-flex items-center justify-center size-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted transition-colors"
            aria-label="Закрыть"
          >
            <X className="size-4" />
          </button>
        </div>
        <div className="px-6 pb-6 space-y-4 overflow-y-auto min-h-0">
          {children}
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Upload Document Dialog ──

interface UploadDialogProps {
  onClose: () => void;
  onUpload: (file: File, name: string) => Promise<KbSource | null>;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Strip extension for display name: "API Reference.pdf" → "API Reference". */
function fileStem(filename: string): string {
  const base = filename.split(/[/\\]/).pop() ?? filename;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function UploadDialog({ onClose, onUpload }: UploadDialogProps) {
  const [name, setName] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (selected: File | null) => {
    setFile(selected);
    // Same pattern as Folder/Project dialogs: fill empty name from selection.
    if (selected) {
      setName(prev => prev.trim() || fileStem(selected.name));
    }
  };

  const handleUpload = async () => {
    if (!file || !name.trim()) {
      toast.error('Укажите имя и выберите файл');
      return;
    }
    // UI-H11 fix: client-side file size check. The label says "до 50 MB" but
    // there was no check — the user waited for the upload to fail server-side.
    const MAX_SIZE = 50 * 1024 * 1024;
    if (file.size > MAX_SIZE) {
      toast.error(`Файл слишком большой (${formatBytes(file.size)}). Максимум 50 MB.`);
      return;
    }
    setUploading(true);
    const result = await onUpload(file, name.trim());
    setUploading(false);
    if (result) onClose();
  };

  const canUpload = Boolean(file && name.trim()) && !uploading;

  return (
    <ModalShell title="Добавить документ" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="kb-upload-name" className="text-xs">Имя источника</Label>
          <Input
            id="kb-upload-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Подставится из имени файла"
            className="mt-1"
          />
        </div>

        <div>
          <Label className="text-xs">Файл (.md, .txt, .pdf, .docx, до 50 MB)</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5 mb-1">
            Индексация запускается автоматически после загрузки — кнопка «Переиндексировать» нужна только для обновления.
          </p>
          <input
            ref={fileInputRef}
            type="file"
            accept=".md,.markdown,.txt,.text,.pdf,.docx,.doc,text/markdown,text/plain,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/msword"
            onChange={(e) => handleFileChange(e.target.files?.[0] ?? null)}
            className="hidden"
          />
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            className="mt-1 w-full border border-dashed border-border rounded-md p-4 text-center hover:bg-surface-2 transition-colors"
          >
            {file ? (
              <div className="text-xs">
                <FileText className="w-5 h-5 mx-auto mb-1 text-accent" />
                <div className="font-medium">{file.name}</div>
                <div className="text-muted-foreground">{formatBytes(file.size)}</div>
              </div>
            ) : (
              <div className="text-xs text-muted-foreground">
                <Upload className="w-5 h-5 mx-auto mb-1" />
                Нажмите чтобы выбрать файл
              </div>
            )}
          </button>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="outline" onClick={onClose} disabled={uploading}>
          Отмена
        </Button>
        <Button size="sm" onClick={() => void handleUpload()} disabled={!canUpload}>
          {uploading ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Загрузка…
            </>
          ) : (
            'Загрузить'
          )}
        </Button>
      </div>
    </ModalShell>
  );
}

// ── Folder Dialog ──

interface FolderDialogProps {
  onClose: () => void;
  onAddFolder: (path: string, name: string) => Promise<KbSource | null>;
}

export function FolderDialog({ onClose, onAddFolder }: FolderDialogProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [fileCount, setFileCount] = useState<number | null>(null);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);

  const validatePath = async (pathToValidate?: string, silent = false): Promise<boolean> => {
    const target = (pathToValidate ?? path).trim();
    if (!target) return false;
    try {
      const res = await fetch('/api/kb/validate-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'invalid folder');
      setPath(data.folderPath);
      setFileCount(data.fileCount);
      setName(prev => prev.trim() || folderBasename(data.folderPath));
      if (!silent) {
        if (data.fileCount === 0) {
          toast.error('Нет поддерживаемых файлов (.md, .txt, .pdf, .docx). Формат .doc не поддерживается.');
        } else {
          const hint = data.hint ? ` ${data.hint}` : '';
          toast.success(`Найдено ${data.fileCount} файлов — каталог имён создаётся за секунды.${hint}`);
        }
      }
      return data.fileCount > 0;
    } catch (e) {
      setFileCount(null);
      if (!silent) {
        toast.error(e instanceof Error ? e.message : 'Некорректный путь к папке');
      }
      return false;
    }
  };

  const pickFolder = async () => {
    setPicking(true);
    try {
      const res = await fetch('/api/kb/pick-folder');
      const data = await res.json();
      if (data.path) {
        const base = folderBasename(data.path);
        setPath(data.path);
        setName(prev => prev.trim() || base);
        await validatePath(data.path, true);
      } else if (data.message) {
        toast.info(data.message);
      }
    } catch {
      toast.error('Не удалось открыть выбор папки');
    } finally {
      setPicking(false);
    }
  };

  const pickAndAdd = async () => {
    setPicking(true);
    setAdding(true);
    try {
      const pickRes = await fetch('/api/kb/pick-folder');
      const pickData = await pickRes.json();
      if (!pickData.path) {
        if (pickData.message) toast.info(pickData.message);
        return;
      }
      const validateRes = await fetch('/api/kb/validate-folder', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ folderPath: pickData.path }),
      });
      const validateData = await validateRes.json();
      if (!validateRes.ok) throw new Error(validateData.error || 'invalid folder');
      if (validateData.fileCount === 0) {
        const hint = validateData.hint ?? validateData.legacyDocCount > 0
          ? `Найдено ${validateData.legacyDocCount} файлов .doc — сохраните как .docx или .pdf.`
          : 'В папке нет поддерживаемых файлов (.md, .txt, .pdf, .docx).';
        toast.error(hint);
        setPath(validateData.folderPath ?? pickData.path);
        setFileCount(0);
        return;
      }
      const folderName = folderBasename(validateData.folderPath ?? pickData.path);
      setName(folderName);
      setPath(validateData.folderPath ?? pickData.path);
      setFileCount(validateData.fileCount);
      const result = await onAddFolder(validateData.folderPath ?? pickData.path, folderName);
      if (result) onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить папку');
    } finally {
      setPicking(false);
      setAdding(false);
    }
  };

  const handleAdd = async () => {
    if (!path.trim()) {
      toast.error('Укажите путь к папке');
      return;
    }
    if (fileCount === 0) {
      toast.error('В папке нет поддерживаемых файлов для индексации');
      return;
    }
    // UI-H12 fix: if validation is still in flight (fileCount === null),
    // block — the user may have typed a path and immediately clicked the
    // button before onBlur's validatePath completed. Previously the
    // `fileCount === 0` check passed (null !== 0) and the request went
    // through with an unvalidated path.
    if (fileCount === null) {
      toast.info('Проверяю папку… подожди секунду.');
      // Trigger validation now; if it succeeds the user can click again.
      void validatePath(path, true);
      return;
    }
    setAdding(true);
    const result = await onAddFolder(path, name);
    setAdding(false);
    if (result) onClose();
  };

  return (
    <ModalShell
      title="Добавить папку"
      icon={<FolderOpen className="w-4 h-4" />}
      onClose={onClose}
      maxWidth="lg"
    >
      <div className="space-y-3">
        <Button
          type="button"
          className="w-full"
          onClick={() => void pickAndAdd()}
          disabled={picking || adding}
        >
          {picking || adding ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Выбор и индексация…
            </>
          ) : (
            <>
              <FolderOpen className="w-3 h-3 mr-1.5" />
              Выбрать папку и проиндексировать
            </>
          )}
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">или укажите путь вручную</p>
        <div>
          <Label htmlFor="folder-name" className="text-xs">Имя источника *</Label>
          <Input
            id="folder-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Документация проекта"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="folder-path" className="text-xs">Путь к папке *</Label>
          <div className="flex gap-2 mt-1">
            <Input
              id="folder-path"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setFileCount(null);
              }}
              onBlur={() => { if (path.trim()) void validatePath(); }}
              placeholder="C:\Users\...\Documents\my-project"
              className="font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void pickFolder()}
              disabled={picking}
              title="Выбрать папку"
            >
              {picking ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Обзор…'}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Поддерживаются .md, .txt, .pdf, .docx (рекурсивно).
            Старый .doc не читается — сохраните как .docx или .pdf.
          </p>
          {fileCount != null && (
            <p className="text-[11px] text-emerald-600 mt-1">
              Найдено {fileCount} поддерживаемых файлов
            </p>
          )}
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="outline" onClick={onClose} disabled={adding}>
          Отмена
        </Button>
        <Button
          size="sm"
          onClick={() => void handleAdd()}
          disabled={adding || !path.trim() || fileCount === null || fileCount === 0}
        >
          {adding ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Индексация…
            </>
          ) : (
            'Проиндексировать'
          )}
        </Button>
      </div>
    </ModalShell>
  );
}

// ── Project Dialog (unified docs + code) ──

export type ProjectAddMode = 'auto' | 'docs' | 'code' | 'both';

interface ProjectDialogProps {
  onClose: () => void;
  onAddProject: (params: {
    path: string;
    name: string;
    mode: ProjectAddMode;
  }) => Promise<KbSource[] | null>;
}

type ProjectProbeUi = {
  path: string;
  docFiles: number;
  codeFiles: number;
  suggestedModes: Array<'docs' | 'code'>;
  hint?: string;
};

export function ProjectDialog({ onClose, onAddProject }: ProjectDialogProps) {
  const [name, setName] = useState('');
  const [path, setPath] = useState('');
  const [probe, setProbe] = useState<ProjectProbeUi | null>(null);
  const [includeDocs, setIncludeDocs] = useState(true);
  const [includeCode, setIncludeCode] = useState(true);
  const [adding, setAdding] = useState(false);
  const [picking, setPicking] = useState(false);

  const applyProbe = (data: ProjectProbeUi) => {
    setProbe(data);
    setPath(data.path);
    setName(prev => prev.trim() || folderBasename(data.path));
    setIncludeDocs(data.suggestedModes.includes('docs'));
    setIncludeCode(data.suggestedModes.includes('code'));
  };

  const validatePath = async (pathToValidate?: string, silent = false): Promise<boolean> => {
    const target = (pathToValidate ?? path).trim();
    if (!target) return false;
    try {
      const res = await fetch('/api/kb/validate-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: target }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'invalid project path');
      applyProbe({
        path: data.path,
        docFiles: data.docFiles ?? 0,
        codeFiles: data.codeFiles ?? 0,
        suggestedModes: data.suggestedModes ?? [],
        hint: data.hint,
      });
      if (!silent) {
        if ((data.suggestedModes ?? []).length === 0) {
          toast.error(data.hint || 'Нет документов и исходников для индексации');
        } else {
          toast.success(
            `Найдено: ${data.docFiles} док. · ${data.codeFiles} исходников`,
          );
        }
      }
      return (data.suggestedModes ?? []).length > 0;
    } catch (e) {
      setProbe(null);
      if (!silent) {
        toast.error(e instanceof Error ? e.message : 'Некорректный путь');
      }
      return false;
    }
  };

  const resolveMode = (): ProjectAddMode | null => {
    const docs = includeDocs && (probe?.docFiles ?? 0) > 0;
    const code = includeCode && (probe?.codeFiles ?? 0) > 0;
    if (docs && code) return 'both';
    if (docs) return 'docs';
    if (code) return 'code';
    return null;
  };

  const pickFolder = async () => {
    setPicking(true);
    try {
      const res = await fetch('/api/kb/pick-folder');
      const data = await res.json();
      if (data.path) {
        setPath(data.path);
        setName(prev => prev.trim() || folderBasename(data.path));
        await validatePath(data.path, true);
      } else if (data.message) {
        toast.info(data.message);
      }
    } catch {
      toast.error('Не удалось открыть выбор папки');
    } finally {
      setPicking(false);
    }
  };

  const pickAndAdd = async () => {
    setPicking(true);
    setAdding(true);
    try {
      const pickRes = await fetch('/api/kb/pick-folder');
      const pickData = await pickRes.json();
      if (!pickData.path) {
        if (pickData.message) toast.info(pickData.message);
        return;
      }
      const ok = await validatePath(pickData.path, true);
      if (!ok) {
        toast.error('В папке нет документов и исходников для индексации');
        return;
      }
      // Re-read checkboxes after applyProbe — use probe from validate response via state is async.
      // Validate again returns boolean; call onAddProject with auto so server picks modes.
      const folderName = folderBasename(pickData.path);
      setName(folderName);
      const result = await onAddProject({
        path: pickData.path,
        name: folderName,
        mode: 'auto',
      });
      if (result && result.length > 0) onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить проект');
    } finally {
      setPicking(false);
      setAdding(false);
    }
  };

  const handleAdd = async () => {
    if (!path.trim()) {
      toast.error('Укажите путь к проекту');
      return;
    }
    if (!probe) {
      toast.info('Проверяю папку…');
      void validatePath(path, true);
      return;
    }
    const mode = resolveMode();
    if (!mode) {
      toast.error('Выберите хотя бы один тип: документы или код');
      return;
    }
    setAdding(true);
    const result = await onAddProject({ path, name, mode });
    setAdding(false);
    if (result && result.length > 0) onClose();
  };

  return (
    <ModalShell
      title="Добавить проект"
      icon={<FolderOpen className="w-4 h-4" />}
      onClose={onClose}
      maxWidth="lg"
    >
      <div className="space-y-3">
        <Button
          type="button"
          className="w-full"
          onClick={() => void pickAndAdd()}
          disabled={picking || adding}
        >
          {picking || adding ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Выбор и индексация…
            </>
          ) : (
            <>
              <FolderOpen className="w-3 h-3 mr-1.5" />
              Выбрать папку и проиндексировать
            </>
          )}
        </Button>
        <p className="text-[11px] text-muted-foreground text-center">или укажите путь вручную</p>
        <div>
          <Label htmlFor="project-name" className="text-xs">Имя проекта *</Label>
          <Input
            id="project-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Мой проект"
            className="mt-1"
          />
        </div>
        <div>
          <Label htmlFor="project-path" className="text-xs">Путь к папке *</Label>
          <div className="flex gap-2 mt-1">
            <Input
              id="project-path"
              value={path}
              onChange={(e) => {
                setPath(e.target.value);
                setProbe(null);
              }}
              onBlur={() => { if (path.trim()) void validatePath(); }}
              placeholder="C:\Users\...\my-project"
              className="font-mono text-xs"
            />
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => void pickFolder()}
              disabled={picking}
              title="Выбрать папку"
            >
              {picking ? <Loader2 className="w-3 h-3 animate-spin" /> : 'Обзор…'}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground mt-1.5">
            Документы (.md/.txt/.pdf/.docx) и код (.ts/.js/.py) индексируются разными движками.
            Можно включить оба.
          </p>
        </div>

        {probe && (
          <div className="rounded-md border border-border bg-surface/40 p-3 space-y-2">
            <p className="text-[11px] text-muted-foreground">
              Найдено: {probe.docFiles} документов · {probe.codeFiles} исходников
            </p>
            <label className={cn(
              'flex items-center gap-2 text-xs',
              probe.docFiles === 0 && 'opacity-50',
            )}>
              <input
                type="checkbox"
                checked={includeDocs && probe.docFiles > 0}
                disabled={probe.docFiles === 0}
                onChange={(e) => setIncludeDocs(e.target.checked)}
              />
              Документы (каталог имён / поиск по KB)
            </label>
            <label className={cn(
              'flex items-center gap-2 text-xs',
              probe.codeFiles === 0 && 'opacity-50',
            )}>
              <input
                type="checkbox"
                checked={includeCode && probe.codeFiles > 0}
                disabled={probe.codeFiles === 0}
                onChange={(e) => setIncludeCode(e.target.checked)}
              />
              Код (семантический индекс для агента)
            </label>
            {probe.hint && (
              <p className="text-[11px] text-amber-600">{probe.hint}</p>
            )}
          </div>
        )}
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="outline" onClick={onClose} disabled={adding}>
          Отмена
        </Button>
        <Button
          size="sm"
          onClick={() => void handleAdd()}
          disabled={adding || !path.trim() || !probe || resolveMode() === null}
        >
          {adding ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Индексация…
            </>
          ) : (
            'Добавить проект'
          )}
        </Button>
      </div>
    </ModalShell>
  );
}

// ── URL Add Dialog ──

interface UrlDialogProps {
  onClose: () => void;
  onAddUrl: (name: string, url: string) => Promise<KbSource | null>;
}

export function UrlDialog({ onClose, onAddUrl }: UrlDialogProps) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [adding, setAdding] = useState(false);

  // UI-H10 fix: validate URL format client-side so invalid input is rejected
  // before the request hits the server. Previously any non-empty string was
  // accepted and the user got a confusing server-side error.
  const isUrlValid = (() => {
    if (!url.trim()) return false;
    try {
      const u = new URL(url.trim());
      // Must be http or https — other protocols (file:, data:, javascript:)
      // would either fail server-side or be a security risk.
      return u.protocol === 'http:' || u.protocol === 'https:';
    } catch {
      return false;
    }
  })();

  const handleAdd = async () => {
    if (!isUrlValid) {
      toast.error('Введите корректный URL (начинается с http:// или https://)');
      return;
    }
    setAdding(true);
    const result = await onAddUrl(name, url);
    setAdding(false);
    if (result) onClose();
  };

  return (
    <ModalShell title="Добавить URL" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <Label htmlFor="url-name" className="text-xs">Имя источника *</Label>
          <Input
            id="url-name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Например: React Docs"
            className="mt-1"
          />
        </div>

        <div>
          <Label htmlFor="url-url" className="text-xs">URL *</Label>
          <Input
            id="url-url"
            type="url"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://react.dev/learn"
            className="mt-1"
          />
          <div className="text-[10px] text-muted-foreground mt-1">
            Контент будет извлечён через Readability (main article text).
            JS-rendered страницы могут не работать.
          </div>
        </div>
      </div>

      <div className="flex justify-end gap-2 pt-2">
        <Button size="sm" variant="outline" onClick={onClose} disabled={adding}>
          Отмена
        </Button>
        <Button size="sm" onClick={() => void handleAdd()} disabled={adding || !name.trim() || !isUrlValid}>
          {adding ? (
            <>
              <Loader2 className="w-3 h-3 mr-1.5 animate-spin" />
              Добавление…
            </>
          ) : (
            'Добавить'
          )}
        </Button>
      </div>
    </ModalShell>
  );
}
