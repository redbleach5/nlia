'use client';

// ============================================================================
// AboutTab — до 3 людей в памяти Лии + информация о продукте.
// ============================================================================

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Star, Trash2 } from 'lucide-react';
import { toast } from 'sonner';
import type { SettingsPerson } from './types';

type AboutTabProps = {
  people: SettingsPerson[];
  maxPeople: number;
  onPeopleChanged: () => Promise<void>;
};

export function AboutTab({
  people,
  maxPeople,
  onPeopleChanged,
}: AboutTabProps) {
  const [newName, setNewName] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const callPeople = async (body: Record<string, unknown>) => {
    const res = await fetch('/api/people', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({})) as { error?: string };
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  };

  const addPerson = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      await callPeople({ action: 'create', displayName: name, isDefault: people.length === 0 });
      setNewName('');
      toast.success('Человек добавлен в память Лии');
      await onPeopleChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось добавить');
    } finally {
      setCreating(false);
    }
  };

  const rename = async (id: string, displayName: string) => {
    setBusyId(id);
    try {
      await callPeople({ action: 'update', id, displayName: displayName.trim() });
      toast.success('Имя обновлено');
      await onPeopleChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось сохранить');
    } finally {
      setBusyId(null);
    }
  };

  const makeDefault = async (id: string) => {
    setBusyId(id);
    try {
      await callPeople({ action: 'setDefault', id });
      toast.success('Основной профиль обновлён');
      await onPeopleChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id: string) => {
    setBusyId(id);
    try {
      await callPeople({ action: 'delete', id });
      toast.success('Удалено из памяти');
      await onPeopleChanged();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Не удалось удалить');
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-border bg-surface/50 p-4 space-y-3">
        <div>
          <Label className="text-xs">Кого Лия помнит</Label>
          <p className="text-[10px] text-muted-foreground mt-0.5 mb-2">
            До {maxPeople} человек. В новом чате Лия узнает по имени («я Маша»)
            или спросит, кто пишет. Можно также сказать в чате «меня зовут …».
          </p>

          <ul className="space-y-2">
            {people.map((p) => (
              <PersonRow
                key={`${p.id}:${p.displayName}`}
                person={p}
                busy={busyId === p.id}
                onSave={(name) => void rename(p.id, name)}
                onDefault={() => void makeDefault(p.id)}
                onDelete={() => void remove(p.id)}
              />
            ))}
            {people.length === 0 && (
              <li className="text-xs text-muted-foreground">Пока никого — добавьте имя ниже.</li>
            )}
          </ul>

          {people.length < maxPeople && (
            <div className="flex gap-2 mt-3">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="Имя нового человека"
                maxLength={80}
                className="text-sm"
              />
              <Button
                type="button"
                size="sm"
                onClick={() => void addPerson()}
                disabled={creating || !newName.trim()}
                className="shrink-0"
              >
                {creating ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Добавить'}
              </Button>
            </div>
          )}
        </div>
      </div>

      <div className="rounded-md border border-border bg-surface/50 p-4 space-y-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-md bg-accent flex items-center justify-center">
            <span className="text-base font-bold text-accent-foreground">Л</span>
          </div>
          <div>
            <div className="text-sm font-medium font-display">Лия</div>
            <div className="text-[10px] text-text-dim">тёплый собеседник и помощник</div>
          </div>
        </div>
        <p className="text-xs text-muted-foreground leading-relaxed">
          Лия — персональный компаньон. Разговоры остаются на этом компьютере.
          Она запоминает важное, ищет информацию, помогает с делами и подстраивает
          стиль общения под вас.
        </p>
      </div>

      <details className="rounded-md border border-border bg-surface/50 p-3 text-[11px] text-muted-foreground group">
        <summary className="font-medium text-foreground cursor-pointer list-none flex items-center justify-between">
          Технические детали
          <span className="text-text-dim group-open:hidden">показать</span>
          <span className="text-text-dim hidden group-open:inline">скрыть</span>
        </summary>
        <p className="mt-2 leading-relaxed">
          Next.js, React, локальный движок Ollama, память на SQLite.
          3D-образ — по желанию. База знаний ищет и по смыслу, и по словам.
        </p>
      </details>
    </div>
  );
}

function PersonRow(props: {
  person: SettingsPerson;
  busy: boolean;
  onSave: (name: string) => void;
  onDefault: () => void;
  onDelete: () => void;
}) {
  const { person, busy, onSave, onDefault, onDelete } = props;
  const [draft, setDraft] = useState(person.displayName);

  return (
    <li className="flex flex-wrap items-center gap-2 rounded border border-border/60 bg-background/40 p-2">
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={80}
        className="text-sm h-8 flex-1 min-w-[8rem]"
        disabled={busy}
      />
      <Button
        type="button"
        size="sm"
        variant="secondary"
        className="h-8"
        disabled={busy || draft.trim() === person.displayName || !draft.trim()}
        onClick={() => onSave(draft)}
      >
        {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'Сохранить'}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2"
        title="Основной профиль"
        disabled={busy || person.isDefault}
        onClick={onDefault}
      >
        <Star className={`w-3.5 h-3.5 ${person.isDefault ? 'fill-current text-amber-500' : ''}`} />
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        className="h-8 px-2 text-destructive"
        title="Удалить"
        disabled={busy}
        onClick={onDelete}
      >
        <Trash2 className="w-3.5 h-3.5" />
      </Button>
    </li>
  );
}
