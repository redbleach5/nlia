import { describe, it, expect } from 'vitest';
import { buildManifestChunkContent, isManifestChunk } from '@/lib/kb/folder-manifest';

describe('folder-manifest', () => {
  it('buildManifestChunkContent includes path tokens for BM25', () => {
    const content = buildManifestChunkContent(
      {
        absolutePath: 'C:\\docs\\EGTS_SR_ADAS_DATA.docx',
        relativePath: 'EGTS/EGTS_SR_ADAS_DATA.docx',
        mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      },
      'Downloads',
    );

    expect(content).toContain('EGTS_SR_ADAS_DATA.docx');
    expect(content).toContain('EGTS/EGTS_SR_ADAS_DATA.docx');
    expect(content).toContain('Downloads');
  });

  it('isManifestChunk detects manifest metadata', () => {
    expect(isManifestChunk({ manifest: true, relativePath: 'a.md' })).toBe(true);
    expect(isManifestChunk({ relativePath: 'a.md' })).toBe(false);
    expect(isManifestChunk(undefined)).toBe(false);
  });
});
