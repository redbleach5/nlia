'use client';

// ShortcutsHelp — overlay со списком горячих клавиш (?).

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from '@/components/ui/dialog';
import { getModKeyLabel } from '@/lib/utils';
import { useEffect, useState } from 'react';

type ShortcutsHelpProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
};

export function ShortcutsHelp({ open, onOpenChange }: ShortcutsHelpProps) {
  const [mod, setMod] = useState('Ctrl');
  useEffect(() => { setMod(getModKeyLabel()); }, []);

  const rows = [
    { keys: `${mod}+N`, label: 'Новый чат' },
    { keys: `${mod}+\\`, label: 'Показать / скрыть чаты' },
    { keys: `${mod}+B`, label: 'База знаний' },
    { keys: `${mod}+,`, label: 'Настройки' },
    { keys: `${mod}+Shift+A`, label: 'В режиме Агент — ask/auto Apply; иначе — цикл образа' },
    { keys: 'Esc', label: 'Стоп ответа или агента' },
    { keys: 'Enter', label: 'Отправить сообщение' },
    { keys: 'Shift+Enter', label: 'Новая строка' },
    { keys: '@', label: 'В режиме Агент — выбор файла/папки' },
    { keys: '?', label: 'Эта справка' },
  ];

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Горячие клавиши</DialogTitle>
          <DialogDescription>
            Режим агента — в селекторе чата. «Применить все» — в полоске над правками в ленте.
            Тема — в «Ещё».
          </DialogDescription>
        </DialogHeader>
        <ul className="mt-2 space-y-1.5">
          {rows.map(row => (
            <li key={row.keys} className="flex items-center justify-between gap-3 text-sm">
              <span className="text-muted-foreground">{row.label}</span>
              <kbd className="lia-kbd shrink-0">{row.keys}</kbd>
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  );
}
