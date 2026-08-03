'use client';

// ============================================================================
// KbTab — management UI for the Knowledge Base (KB Phase 2 + Phase 3).
// ============================================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  FileText, Loader2, FolderOpen, Link2,
} from 'lucide-react';
import { useKbSources } from './use-kb-sources';
import { SourcesList } from './sources-list';
import { UploadDialog, ProjectDialog, UrlDialog } from './kb-dialogs';

type KbTabProps = {
  onRefresh?: () => Promise<void>;
};

const addBtnClass =
  'h-9 justify-start gap-2 px-3 text-xs font-normal whitespace-nowrap';

export function KbTab({ onRefresh }: KbTabProps) {
  const kb = useKbSources(onRefresh);
  const [showUploadDialog, setShowUploadDialog] = useState(false);
  const [showProjectDialog, setShowProjectDialog] = useState(false);
  const [showUrlDialog, setShowUrlDialog] = useState(false);

  if (kb.loading && kb.sources === null) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="w-5 h-5 animate-spin text-accent" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2.5">
        <div className="text-xs text-muted-foreground">
          {kb.sources?.length ?? 0} источник(ов) в базе знаний
        </div>
        <div className="grid grid-cols-2 gap-2">
          <Button
            size="sm"
            variant="outline"
            className={addBtnClass}
            onClick={() => setShowProjectDialog(true)}
            title="Папка проекта: документы и/или код"
          >
            <FolderOpen className="w-3.5 h-3.5 shrink-0" />
            Проект
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={addBtnClass}
            onClick={() => setShowUploadDialog(true)}
            title="Загрузить файл документа"
          >
            <FileText className="w-3.5 h-3.5 shrink-0" />
            Документ
          </Button>
          <Button
            size="sm"
            variant="outline"
            className={addBtnClass}
            onClick={() => setShowUrlDialog(true)}
            title="Индексировать веб-страницу"
          >
            <Link2 className="w-3.5 h-3.5 shrink-0" />
            URL
          </Button>
        </div>
      </div>

      {kb.sources && kb.sources.length === 0 ? (
        <div className="rounded-md border border-dashed border-border p-8 text-center">
          <FileText className="w-8 h-8 mx-auto text-muted-foreground mb-2" />
          <p className="text-sm text-muted-foreground">
            База знаний пуста. Добавьте проект (документы и/или код), загрузите файл
            или укажите URL.
          </p>
        </div>
      ) : kb.sources ? (
        <SourcesList
          sources={kb.sources}
          actionInProgress={kb.actionInProgress}
          onReindex={(id) => void kb.handleReindex(id)}
          onCancel={(id) => void kb.handleCancel(id)}
          onDelete={(id, name) => void kb.handleDelete(id, name)}
        />
      ) : null}

      {showUploadDialog && (
        <UploadDialog
          onClose={() => setShowUploadDialog(false)}
          onUpload={kb.uploadDocument}
        />
      )}

      {showProjectDialog && (
        <ProjectDialog
          onClose={() => setShowProjectDialog(false)}
          onAddProject={kb.addProject}
        />
      )}

      {showUrlDialog && (
        <UrlDialog
          onClose={() => setShowUrlDialog(false)}
          onAddUrl={kb.addUrl}
        />
      )}

      <AlertDialog
        open={kb.pendingDelete !== null}
        onOpenChange={(open) => { if (!open) kb.cancelDelete(); }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Удалить источник?</AlertDialogTitle>
            <AlertDialogDescription>
              {kb.pendingDelete && (
                <>Источник «{kb.pendingDelete.name}» будет удалён вместе со всеми сохранёнными фрагментами. Это нельзя отменить.</>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="flex justify-end gap-2 pt-2">
            <AlertDialogCancel onClick={kb.cancelDelete}>Отмена</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => void kb.confirmDelete()}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              Удалить
            </AlertDialogAction>
          </div>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
