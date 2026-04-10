import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import {
  getHeapSpaceStatistics,
  getHeapStatistics,
  writeHeapSnapshot
} from 'node:v8';

export type DiagnosticMode = 'report' | 'heap';
export type DiagnosticTrigger = 'ui' | 'signal';
export type DiagnosticProcessType = 'tui' | 'bridge';

interface DiagnosticBase {
  processType: DiagnosticProcessType;
  trigger: DiagnosticTrigger;
  pid: number;
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  capturedAt: string;
}

export interface DiagnosticReportCapture extends DiagnosticBase {
  mode: 'report';
  path: string;
}

export interface HeapSnapshotCapture extends DiagnosticBase {
  mode: 'heap';
  path: string;
  metaPath: string;
}

export async function writeDiagnosticReport(input: {
  cwd: string;
  processType: DiagnosticProcessType;
  trigger: DiagnosticTrigger;
  extra?: Record<string, unknown>;
}): Promise<DiagnosticReportCapture> {
  const capturedAt = new Date().toISOString();
  const outputDir = path.join(input.cwd, '.h2', 'heap-snapshots');
  await mkdir(outputDir, { recursive: true });

  const stamp = capturedAt.replace(/[:.]/g, '-');
  const pathBase = path.join(outputDir, `${stamp}-${input.processType}-pid-${process.pid}`);
  const reportPath = `${pathBase}.report.json`;
  const usage = process.memoryUsage();
  const resourceUsage =
    typeof process.resourceUsage === 'function' ? process.resourceUsage() : undefined;

  const report: DiagnosticReportCapture & {
    uptimeSeconds: number;
    heapStatistics: ReturnType<typeof getHeapStatistics>;
    heapSpaceStatistics: ReturnType<typeof getHeapSpaceStatistics> | null;
    warnings?: string[];
    resourceUsage?: ReturnType<typeof process.resourceUsage>;
    extra?: Record<string, unknown>;
  } = {
    mode: 'report',
    processType: input.processType,
    trigger: input.trigger,
    path: reportPath,
    pid: process.pid,
    rss: usage.rss,
    heapTotal: usage.heapTotal,
    heapUsed: usage.heapUsed,
    external: usage.external,
    arrayBuffers: usage.arrayBuffers,
    capturedAt,
    uptimeSeconds: process.uptime(),
    heapStatistics: getHeapStatistics(),
    heapSpaceStatistics: getOptionalHeapSpaceStatistics(),
    ...(BunHeapSpaceStatsUnsupportedWarning ? { warnings: [BunHeapSpaceStatsUnsupportedWarning] } : {}),
    ...(resourceUsage ? { resourceUsage } : {}),
    ...(input.extra ? { extra: input.extra } : {})
  };

  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return report;
}

export async function captureHeapSnapshot(input: {
  cwd: string;
  processType: DiagnosticProcessType;
  trigger: DiagnosticTrigger;
  extra?: Record<string, unknown>;
}): Promise<HeapSnapshotCapture> {
  const preflight = await writeDiagnosticReport(input);
  const capturedAt = new Date().toISOString();
  const stamp = capturedAt.replace(/[:.]/g, '-');
  const outputDir = path.dirname(preflight.path);
  const baseName = `${stamp}-${input.processType}-pid-${process.pid}`;
  const snapshotPath = writeHeapSnapshot(path.join(outputDir, `${baseName}.heapsnapshot`));
  const usage = process.memoryUsage();
  const metaPath = path.join(outputDir, `${baseName}.json`);

  const meta: HeapSnapshotCapture & {
    preflightReportPath: string;
  } = {
    mode: 'heap',
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
    capturedAt,
    preflightReportPath: preflight.path
  };

  await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, 'utf8');
  return meta;
}

let BunHeapSpaceStatsUnsupportedWarning: string | null = null;

function getOptionalHeapSpaceStatistics(): ReturnType<typeof getHeapSpaceStatistics> | null {
  try {
    return getHeapSpaceStatistics();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('getHeapSpaceStatistics is not yet implemented in Bun')) {
      BunHeapSpaceStatsUnsupportedWarning = message;
      return null;
    }
    throw error;
  }
}
