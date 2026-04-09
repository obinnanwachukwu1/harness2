import path from 'node:path';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';

import { createSessionId, nowIso } from '../lib/utils.js';
import { getGlobalH2Dir } from '../state-paths.js';

export interface EvalRunBatchRecord {
  batchId: string;
  suiteId: string;
  manifestPath: string;
  runIds: string[];
  createdAt: string;
}

export async function createEvalRunBatchRecord(input: {
  suiteId: string;
  manifestPath: string;
  runIds: string[];
}): Promise<EvalRunBatchRecord> {
  const record: EvalRunBatchRecord = {
    batchId: createBatchId(),
    suiteId: input.suiteId,
    manifestPath: path.resolve(input.manifestPath),
    runIds: [...input.runIds],
    createdAt: nowIso()
  };
  const batchDir = path.join(getGlobalH2Dir(), 'evals', 'batches');
  await mkdir(batchDir, { recursive: true });
  await writeFile(path.join(batchDir, `${record.batchId}.json`), JSON.stringify(record, null, 2), 'utf8');
  return record;
}

export async function readLatestEvalRunBatchRecord(): Promise<EvalRunBatchRecord> {
  const batchDir = path.join(getGlobalH2Dir(), 'evals', 'batches');
  const entries = await readdir(batchDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.startsWith('batch-') && entry.name.endsWith('.json'))
    .map((entry) => entry.name)
    .sort()
    .reverse();
  const latest = files[0];
  if (!latest) {
    throw new Error(`No eval repeat batches found under ${batchDir}.`);
  }
  const filePath = path.join(batchDir, latest);
  return JSON.parse(await readFile(filePath, 'utf8')) as EvalRunBatchRecord;
}

function createBatchId(): string {
  const stamp = nowIso().replace(/[:.]/g, '-');
  return `batch-${stamp}-${createSessionId().slice(-6)}`;
}
