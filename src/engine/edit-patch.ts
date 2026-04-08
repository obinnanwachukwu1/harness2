import { createTwoFilesPatch } from 'diff';

export interface EditPatchRuntime {
  resolvePath(filePath: string): string;
  assertCanMutate(resolvedPath: string): void;
  ensureParentDir(resolvedPath: string): Promise<void>;
  readFile(resolvedPath: string): Promise<string>;
  writeFile(resolvedPath: string, content: string): Promise<void>;
  removeFile(resolvedPath: string): Promise<void>;
}

type ParsedEditOperation =
  | { kind: 'add'; path: string; content: string }
  | { kind: 'delete'; path: string }
  | { kind: 'update'; path: string; moveTo: string | null; hunks: ParsedPatchHunk[] };

interface ParsedPatchHunk {
  lines: Array<{ prefix: ' ' | '+' | '-'; text: string }>;
}

export async function executeEditPatch(
  patchText: string,
  runtime: EditPatchRuntime
): Promise<string> {
  const operations = parseEditPatch(patchText);
  const renderedDiffs: string[] = [];

  for (const operation of operations) {
    if (operation.kind === 'add') {
      const resolvedPath = runtime.resolvePath(operation.path);
      runtime.assertCanMutate(resolvedPath);
      await runtime.ensureParentDir(resolvedPath);
      await runtime.writeFile(resolvedPath, operation.content);
      renderedDiffs.push(renderFileDiff('/dev/null', operation.path, '', operation.content));
      continue;
    }

    if (operation.kind === 'delete') {
      const resolvedPath = runtime.resolvePath(operation.path);
      runtime.assertCanMutate(resolvedPath);
      const current = await runtime.readFile(resolvedPath);
      await runtime.removeFile(resolvedPath);
      renderedDiffs.push(renderFileDiff(operation.path, '/dev/null', current, ''));
      continue;
    }

    const resolvedSourcePath = runtime.resolvePath(operation.path);
    runtime.assertCanMutate(resolvedSourcePath);
    const current = await runtime.readFile(resolvedSourcePath);
    const next = applyUpdatePatch(current, operation, operation.path);

    if (operation.moveTo) {
      const resolvedTargetPath = runtime.resolvePath(operation.moveTo);
      runtime.assertCanMutate(resolvedTargetPath);
      await runtime.ensureParentDir(resolvedTargetPath);
      await runtime.writeFile(resolvedTargetPath, next);
      await runtime.removeFile(resolvedSourcePath);
    } else {
      await runtime.writeFile(resolvedSourcePath, next);
    }
    renderedDiffs.push(renderFileDiff(operation.path, operation.moveTo ?? operation.path, current, next));
  }

  return formatEditDiffToolTranscript(operations, renderedDiffs);
}

function parseEditPatch(patchText: string): ParsedEditOperation[] {
  const lines = patchText.split(/\r?\n/);
  if (lines[0] !== '*** Begin Patch') {
    throw new Error('Patch must start with "*** Begin Patch".');
  }

  const operations: ParsedEditOperation[] = [];
  let index = 1;

  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (line === '*** End Patch') {
      return operations;
    }

    if (line.startsWith('*** Add File: ')) {
      const pathText = line.slice('*** Add File: '.length).trim();
      index += 1;
      const contentLines: string[] = [];
      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        if (nextLine === '*** End Patch' || nextLine.startsWith('*** ')) {
          break;
        }
        if (!nextLine.startsWith('+')) {
          throw new Error(`Invalid add-file line in ${pathText}: ${nextLine}`);
        }
        contentLines.push(nextLine.slice(1));
        index += 1;
      }
      operations.push({ kind: 'add', path: pathText, content: contentLines.join('\n') });
      continue;
    }

    if (line.startsWith('*** Delete File: ')) {
      operations.push({ kind: 'delete', path: line.slice('*** Delete File: '.length).trim() });
      index += 1;
      continue;
    }

    if (line.startsWith('*** Update File: ')) {
      const pathText = line.slice('*** Update File: '.length).trim();
      index += 1;
      let moveTo: string | null = null;
      if ((lines[index] ?? '').startsWith('*** Move to: ')) {
        moveTo = (lines[index] ?? '').slice('*** Move to: '.length).trim();
        index += 1;
      }

      const hunks: ParsedPatchHunk[] = [];
      let currentHunk: ParsedPatchHunk | null = null;

      while (index < lines.length) {
        const nextLine = lines[index] ?? '';
        if (
          nextLine === '*** End Patch' ||
          nextLine.startsWith('*** Add File: ') ||
          nextLine.startsWith('*** Update File: ') ||
          nextLine.startsWith('*** Delete File: ')
        ) {
          break;
        }
        if (nextLine === '*** End of File') {
          index += 1;
          continue;
        }
        if (nextLine.startsWith('@@')) {
          currentHunk = { lines: [] };
          hunks.push(currentHunk);
          index += 1;
          continue;
        }
        const prefix = nextLine[0];
        if (prefix !== ' ' && prefix !== '+' && prefix !== '-') {
          throw new Error(`Invalid patch line in ${pathText}: ${nextLine}`);
        }
        if (!currentHunk) {
          currentHunk = { lines: [] };
          hunks.push(currentHunk);
        }
        currentHunk.lines.push({
          prefix,
          text: nextLine.slice(1)
        });
        index += 1;
      }

      if (hunks.length === 0) {
        throw new Error(`Update patch for ${pathText} did not contain any hunks.`);
      }
      operations.push({ kind: 'update', path: pathText, moveTo, hunks });
      continue;
    }

    if (!line.trim()) {
      index += 1;
      continue;
    }

    throw new Error(`Invalid patch header: ${line}`);
  }

  throw new Error('Patch must end with "*** End Patch".');
}

function applyUpdatePatch(
  currentContent: string,
  operation: Extract<ParsedEditOperation, { kind: 'update' }>,
  filePath: string
): string {
  const sourceLines = currentContent.split(/\r?\n/);
  const outputLines: string[] = [];
  let cursor = 0;

  for (const hunk of operation.hunks) {
    const oldLines = hunk.lines
      .filter((line) => line.prefix === ' ' || line.prefix === '-')
      .map((line) => line.text);
    const matchIndex = findPatchMatchIndex(sourceLines, oldLines, cursor);
    if (matchIndex === -1) {
      throw new Error(`Could not apply patch hunk to ${filePath}.`);
    }

    outputLines.push(...sourceLines.slice(cursor, matchIndex));
    let readIndex = matchIndex;
    for (const line of hunk.lines) {
      if (line.prefix === ' ') {
        if (sourceLines[readIndex] !== line.text) {
          throw new Error(`Patch context mismatch while applying ${filePath}.`);
        }
        outputLines.push(line.text);
        readIndex += 1;
        continue;
      }
      if (line.prefix === '-') {
        if (sourceLines[readIndex] !== line.text) {
          throw new Error(`Patch deletion mismatch while applying ${filePath}.`);
        }
        readIndex += 1;
        continue;
      }
      outputLines.push(line.text);
    }
    cursor = readIndex;
  }

  outputLines.push(...sourceLines.slice(cursor));
  return outputLines.join('\n');
}

function findPatchMatchIndex(sourceLines: string[], oldLines: string[], startIndex: number): number {
  if (oldLines.length === 0) {
    return startIndex;
  }

  for (let index = startIndex; index <= sourceLines.length - oldLines.length; index += 1) {
    let matched = true;
    for (let offset = 0; offset < oldLines.length; offset += 1) {
      if (sourceLines[index + offset] !== oldLines[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) {
      return index;
    }
  }

  return -1;
}

function formatEditDiffToolTranscript(
  operations: ParsedEditOperation[],
  renderedDiffs: string[]
): string {
  const label =
    operations.length === 1
      ? describeEditOperation(operations[0]!)
      : `Edit(${operations.length} files)`;
  return `@@tool\tedit_diff\t${label}\n${renderedDiffs.join('\n\n')}`;
}

function describeEditOperation(operation: ParsedEditOperation): string {
  if (operation.kind === 'add') {
    return `Add(${operation.path})`;
  }
  if (operation.kind === 'delete') {
    return `Delete(${operation.path})`;
  }
  if (operation.moveTo) {
    return `Move(${operation.path} -> ${operation.moveTo})`;
  }
  return `Edit(${operation.path})`;
}

function renderFileDiff(oldPath: string, newPath: string, before: string, after: string): string {
  const diffHeaderOld = oldPath === '/dev/null' ? '/dev/null' : `a/${oldPath}`;
  const diffHeaderNew = newPath === '/dev/null' ? '/dev/null' : `b/${newPath}`;
  const patch = sanitizeUnifiedDiff(
    createTwoFilesPatch(diffHeaderOld, diffHeaderNew, before, after, '', '', {
      context: 3
    })
  );

  const metadata: string[] = [`diff --git ${diffHeaderOld} ${diffHeaderNew}`];
  if (oldPath === '/dev/null') {
    metadata.push('new file mode 100644');
  } else if (newPath === '/dev/null') {
    metadata.push('deleted file mode 100644');
  }

  const patchLines = patch.split('\n');
  return [...metadata, ...patchLines].join('\n');
}

function sanitizeUnifiedDiff(patch: string): string {
  const normalized = patch
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line) => !/^=+$/.test(line))
    .map((line) => line.replace(/\t+$/, ''))
    .join('\n');

  return normalized.endsWith('\n') ? normalized.slice(0, -1) : normalized;
}
