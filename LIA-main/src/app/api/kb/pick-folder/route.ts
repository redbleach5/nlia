// GET /api/kb/pick-folder — native folder picker (local-first, Windows/macOS)

import { NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { logger } from '@/lib/logger';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const execFileAsync = promisify(execFile);

async function pickFolderWindows(): Promise<string | null> {
  const script = [
    'Add-Type -AssemblyName System.Windows.Forms',
    '$d = New-Object System.Windows.Forms.FolderBrowserDialog',
    '$d.Description = "Выберите папку для базы знаний"',
    'if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.SelectedPath }',
  ].join('; ');

  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-STA', '-Command', script],
    { timeout: 120_000, windowsHide: true },
  );

  const selected = stdout.trim();
  return selected.length > 0 ? selected : null;
}

async function pickFolderMac(): Promise<string | null> {
  const script = 'POSIX path of (choose folder with prompt "Выберите папку для базы знаний")';
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 120_000 });
  const selected = stdout.trim();
  return selected.length > 0 ? selected : null;
}

export async function GET() {
  try {
    let path: string | null = null;

    if (process.platform === 'win32') {
      path = await pickFolderWindows();
    } else if (process.platform === 'darwin') {
      path = await pickFolderMac();
    } else {
      return NextResponse.json({
        path: null,
        manual: true,
        message: 'На этой ОС введите путь к папке вручную',
      });
    }

    return NextResponse.json({ path, manual: false });
  } catch (e) {
    logger.warn('kb', 'Folder picker failed', {}, e);
    return NextResponse.json({
      path: null,
      manual: true,
      message: 'Не удалось открыть диалог выбора папки — введите путь вручную',
    });
  }
}
