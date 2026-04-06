import { glob, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';

import { execa, execaCommand } from 'execa';

import { ExperimentManager } from '../experiments/experiment-manager.js';
import { clampText, createSessionId } from '../lib/utils.js';
import { Notebook } from '../storage/notebook.js';
import type {
  AgentRunner,
  AgentTools,
  EngineSnapshot,
  ExperimentDetails,
  ExperimentRecord,
  SpawnExperimentInput,
  TranscriptRole
} from '../types.js';
import { PrototypeRunner } from './prototype-runner.js';

interface OpenEngineOptions {
  cwd: string;
  sessionId?: string;
}

export class HeadlessEngine {
  static async open(options: OpenEngineOptions): Promise<HeadlessEngine> {
    const sessionId = options.sessionId ?? createSessionId();
    const stateDir = path.join(options.cwd, '.h2');
    const dbPath = path.join(stateDir, 'notebook.sqlite');
    const notebook = new Notebook(dbPath);

    if (options.sessionId) {
      const existing = notebook.getSession(sessionId);
      if (!existing) {
        throw new Error(`Unknown session: ${sessionId}`);
      }
      notebook.touchSession(sessionId);
    } else {
      notebook.createSession(sessionId, options.cwd);
    }

    return new HeadlessEngine({
      cwd: options.cwd,
      sessionId,
      stateDir,
      notebook,
      runner: new PrototypeRunner()
    });
  }

  private readonly events = new EventEmitter();
  private readonly experimentManager: ExperimentManager;
  private readonly tools: AgentTools;
  private processingTurn = false;
  private statusText = 'idle';
  private turnQueue: Promise<void> = Promise.resolve();

  private constructor(
    private readonly options: {
      cwd: string;
      sessionId: string;
      stateDir: string;
      notebook: Notebook;
      runner: AgentRunner;
    }
  ) {
    this.experimentManager = new ExperimentManager({
      cwd: options.cwd,
      stateDir: options.stateDir,
      notebook: options.notebook,
      onChange: () => this.emitChange()
    });

    this.tools = {
      bash: (command) => this.runBash(command),
      read: (filePath) => this.runRead(filePath),
      write: (filePath, content) => this.runWrite(filePath, content),
      edit: (filePath, findText, replaceText) => this.runEdit(filePath, findText, replaceText),
      glob: (pattern) => this.runGlob(pattern),
      grep: (pattern, target) => this.runGrep(pattern, target),
      spawnExperiment: (input) => this.spawnExperiment(input),
      readExperiment: (experimentId) => this.readExperiment(experimentId)
    };
  }

  get snapshot(): EngineSnapshot {
    return this.options.notebook.getSnapshot(
      this.options.sessionId,
      this.processingTurn,
      this.statusText
    );
  }

  subscribe(listener: () => void): () => void {
    this.events.on('change', listener);
    return () => {
      this.events.off('change', listener);
    };
  }

  submit(input: string): Promise<void> {
    const work = this.turnQueue.then(async () => {
      const trimmed = input.trim();
      if (!trimmed) {
        return;
      }

      this.processingTurn = true;
      this.statusText = 'running turn';
      this.appendTranscript('user', trimmed);

      try {
        await this.options.runner.runTurn(trimmed, {
          tools: this.tools,
          emit: async (role, text) => {
            this.appendTranscript(role, text);
          }
        });
        this.statusText = 'idle';
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.appendTranscript('assistant', `Error: ${message}`);
        this.statusText = 'error';
      } finally {
        this.processingTurn = false;
        this.emitChange();
      }
    });

    this.turnQueue = work.catch(() => undefined);
    return work;
  }

  async dispose(): Promise<void> {
    await this.experimentManager.dispose();
    this.options.notebook.close();
  }

  private appendTranscript(role: TranscriptRole, text: string): void {
    this.options.notebook.appendTranscript(this.options.sessionId, role, text);
    this.emitChange();
  }

  private emitChange(): void {
    this.events.emit('change');
  }

  private async runBash(command: string): Promise<string> {
    const result = await execaCommand(command, {
      cwd: this.options.cwd,
      shell: true,
      reject: false
    });

    return formatCommandResult(command, result.exitCode ?? 1, result.stdout, result.stderr);
  }

  private async runRead(filePath: string): Promise<string> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    const content = await readFile(resolvedPath, 'utf8');
    return `${relativeToWorkspace(this.options.cwd, resolvedPath)}\n\n${clampText(content, 12000)}`;
  }

  private async runWrite(filePath: string, content: string): Promise<string> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    await mkdir(path.dirname(resolvedPath), { recursive: true });
    await writeFile(resolvedPath, content, 'utf8');
    return `Wrote ${content.length} chars to ${relativeToWorkspace(this.options.cwd, resolvedPath)}.`;
  }

  private async runEdit(filePath: string, findText: string, replaceText: string): Promise<string> {
    const resolvedPath = this.resolveWorkspacePath(filePath);
    const current = await readFile(resolvedPath, 'utf8');

    if (!current.includes(findText)) {
      throw new Error(`Could not find target text in ${filePath}.`);
    }

    const next = current.replace(findText, replaceText);
    await writeFile(resolvedPath, next, 'utf8');
    return `Edited ${relativeToWorkspace(this.options.cwd, resolvedPath)}.`;
  }

  private async runGlob(patternText: string): Promise<string[]> {
    const matches: string[] = [];
    for await (const entry of glob(patternText, { cwd: this.options.cwd })) {
      matches.push(entry);
    }

    return matches
      .filter((entry) => !entry.startsWith('.git/') && !entry.startsWith('.h2/'))
      .sort();
  }

  private async runGrep(patternText: string, target = '.'): Promise<string> {
    try {
      const result = await execa(
        'rg',
        ['-n', '--hidden', '--glob', '!.git', '--glob', '!.h2', patternText, target],
        {
          cwd: this.options.cwd,
          reject: false
        }
      );

      if (result.exitCode === 1 && !result.stderr.trim()) {
        return `No matches for ${patternText}.`;
      }

      return formatCommandResult(
        `rg -n --hidden ${patternText} ${target}`,
        result.exitCode ?? 1,
        result.stdout,
        result.stderr
      );
    } catch (error) {
      const result = await execa('grep', ['-R', '-n', patternText, target], {
        cwd: this.options.cwd,
        reject: false
      });

      return formatCommandResult(
        `grep -R -n ${patternText} ${target}`,
        result.exitCode ?? 1,
        result.stdout,
        result.stderr
      );
    }
  }

  private async spawnExperiment(
    input: Omit<SpawnExperimentInput, 'sessionId'>
  ): Promise<ExperimentRecord> {
    return this.experimentManager.spawn({
      ...input,
      sessionId: this.options.sessionId
    });
  }

  private async readExperiment(experimentId: string): Promise<ExperimentDetails> {
    return this.experimentManager.read(experimentId);
  }

  private resolveWorkspacePath(filePath: string): string {
    const resolvedPath = path.resolve(this.options.cwd, filePath);
    const workspaceRoot = `${this.options.cwd}${path.sep}`;

    if (resolvedPath !== this.options.cwd && !resolvedPath.startsWith(workspaceRoot)) {
      throw new Error(`Path escapes workspace: ${filePath}`);
    }

    return resolvedPath;
  }
}

function formatCommandResult(
  command: string,
  exitCode: number,
  stdout: string,
  stderr: string
): string {
  const sections = [`$ ${command}`, `exit: ${exitCode}`];

  if (stdout.trim()) {
    sections.push(`stdout:\n${clampText(stdout, 12000)}`);
  }

  if (stderr.trim()) {
    sections.push(`stderr:\n${clampText(stderr, 12000)}`);
  }

  if (!stdout.trim() && !stderr.trim()) {
    sections.push('(no output)');
  }

  return sections.join('\n\n');
}

function relativeToWorkspace(cwd: string, filePath: string): string {
  return path.relative(cwd, filePath) || '.';
}
