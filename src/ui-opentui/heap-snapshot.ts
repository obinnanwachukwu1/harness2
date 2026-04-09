import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { writeHeapSnapshot } from 'node:v8';

export interface HeapSnapshotCapture {
  processType: 'tui' | 'bridge';
  trigger: 'ui' | 'signal';
  path: string;
  metaPath: string;
  pid: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  capturedAt: string;
}

export async function captureHeapSnapshot(input: {
  cwd: string;
  processType: 'tui' | 'bridge';
  trigger: 'ui' | 'signal';
}): Promise<HeapSnapshotCapture> {
  const capturedAt = new Date().toISOString();
  const outputDir = path.join(input.cwd, '.h2', 'heap-snapshots');
  await mkdir(outputDir, { recursive: true });

  const stamp = capturedAt.replace(/[:.]/g, '-');
  const baseName = `${stamp}-${input.processType}-pid-${process.pid}`;
  const snapshotPath = writeHeapSnapshot(path.join(outputDir, `${baseName}.heapsnapshot`));
  const usage = process.memoryUsage();
  const metaPath = path.join(outputDir, `${baseName}.json`);

  const meta: HeapSnapshotCapture = {
    processType: input.processType,
    trigger: input.trigger,
    path: snapshotPath,
    metaPath,
    pid: process.pid,
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    capturedAt
  };

  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}
