import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import type { HarborArtifactExportInput, HarborRunArtifacts, HarborRunResult } from './types.js';
import { buildHarborTrajectory } from './trajectory.js';

export async function writeHarborRunPrelude(input: {
  outputDir: string;
  instruction: string;
  sessionId: string;
  runtime: HarborArtifactExportInput['runtime'];
}): Promise<{ artifacts: HarborRunArtifacts; resultPath: string }> {
  await mkdir(input.outputDir, { recursive: true });
  const { artifacts, resultPath } = getHarborArtifactPaths(input.outputDir);

  const result: HarborRunResult = {
    sessionId: input.sessionId,
    outputDir: input.outputDir,
    runtime: input.runtime,
    artifacts,
    partial: true
  };

  await Promise.all([
    writeFile(artifacts.instructionPath, `${input.instruction}\n`, 'utf8'),
    writeFile(artifacts.runtimeJsonPath, JSON.stringify(input.runtime, null, 2), 'utf8'),
    writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8')
  ]);

  return { artifacts, resultPath };
}

export async function writeHarborRunArtifacts(
  input: HarborArtifactExportInput,
  options?: {
    partial?: boolean;
  }
): Promise<{ artifacts: HarborRunArtifacts; resultPath: string }> {
  await mkdir(input.outputDir, { recursive: true });

  const transcript = input.transcript;
  const modelHistory = input.modelHistory;
  const modelUsage = input.modelUsage;
  const questions = input.studyDebts;
  const experiments = input.experiments;
  const trajectory = await buildHarborTrajectory(input);

  const { artifacts, resultPath } = getHarborArtifactPaths(input.outputDir);

  await Promise.all([
    writeFile(artifacts.instructionPath, `${input.instruction}\n`, 'utf8'),
    writeFile(
      artifacts.sessionMarkdownPath,
      renderSessionMarkdown(input.sessionId, transcript, questions, experiments),
      'utf8'
    ),
    writeFile(artifacts.transcriptJsonPath, JSON.stringify(transcript, null, 2), 'utf8'),
    writeFile(artifacts.modelHistoryJsonPath, JSON.stringify(modelHistory, null, 2), 'utf8'),
    writeFile(
      artifacts.usageJsonPath,
      JSON.stringify(
        {
          summary: input.runtime.usage ?? null,
          entries: modelUsage
        },
        null,
        2
      ),
      'utf8'
    ),
    writeFile(artifacts.questionsJsonPath, JSON.stringify(questions, null, 2), 'utf8'),
    writeFile(artifacts.experimentsJsonPath, JSON.stringify(experiments, null, 2), 'utf8'),
    writeFile(artifacts.runtimeJsonPath, JSON.stringify(input.runtime, null, 2), 'utf8'),
    writeFile(artifacts.gitStatusPath, await readGitOutput(input.cwd, ['status', '--short']), 'utf8'),
    writeFile(artifacts.diffPatchPath, await readGitOutput(input.cwd, ['diff']), 'utf8'),
    writeFile(artifacts.trajectoryJsonPath, JSON.stringify(trajectory, null, 2), 'utf8')
  ]);

  const result: HarborRunResult = {
    sessionId: input.sessionId,
    outputDir: input.outputDir,
    runtime: input.runtime,
    artifacts,
    partial: options?.partial ?? false
  };
  await writeFile(resultPath, JSON.stringify(result, null, 2), 'utf8');

  return {
    artifacts,
    resultPath
  };
}

function getHarborArtifactPaths(outputDir: string): { artifacts: HarborRunArtifacts; resultPath: string } {
  const summaryJsonPath = path.join(outputDir, 'summary.json');
  const instructionPath = path.join(outputDir, 'instruction.txt');
  const sessionMarkdownPath = path.join(outputDir, 'session.md');
  const transcriptJsonPath = path.join(outputDir, 'transcript.json');
  const modelHistoryJsonPath = path.join(outputDir, 'model-history.json');
  const usageJsonPath = path.join(outputDir, 'usage.json');
  const questionsJsonPath = path.join(outputDir, 'questions.json');
  const experimentsJsonPath = path.join(outputDir, 'experiments.json');
  const runtimeJsonPath = path.join(outputDir, 'runtime.json');
  const gitStatusPath = path.join(outputDir, 'git-status.txt');
  const diffPatchPath = path.join(outputDir, 'diff.patch');
  const trajectoryJsonPath = path.join(outputDir, 'trajectory.json');

  return {
    artifacts: {
      summaryJsonPath,
      instructionPath,
      sessionMarkdownPath,
      transcriptJsonPath,
      modelHistoryJsonPath,
      usageJsonPath,
      questionsJsonPath,
      experimentsJsonPath,
      runtimeJsonPath,
      gitStatusPath,
      diffPatchPath,
      trajectoryJsonPath
    },
    resultPath: summaryJsonPath
  };
}

function renderSessionMarkdown(
  sessionId: string,
  transcript: Array<{ role: string; text: string; createdAt: string; id: number }>,
  questions: Array<{ id: string; status: string; summary: string; resolution: string | null }>,
  experiments: Array<{ id: string; status: string; hypothesis: string; finalSummary: string | null }>
): string {
  const questionLines =
    questions.length > 0
      ? questions
          .map((question) =>
            [
              `- ${question.id}`,
              `  - status: ${question.status}`,
              `  - summary: ${question.summary}`,
              question.resolution ? `  - resolution: ${question.resolution}` : null
            ]
              .filter((line): line is string => Boolean(line))
              .join('\n')
          )
          .join('\n')
      : '- none';
  const experimentLines =
    experiments.length > 0
      ? experiments
          .map((experiment) =>
            [
              `- ${experiment.id}`,
              `  - status: ${experiment.status}`,
              `  - hypothesis: ${experiment.hypothesis}`,
              experiment.finalSummary ? `  - summary: ${experiment.finalSummary}` : null
            ]
              .filter((line): line is string => Boolean(line))
              .join('\n')
          )
          .join('\n')
      : '- none';
  const transcriptSection = transcript
    .map(
      (entry) =>
        `## ${entry.id} ${entry.role} ${entry.createdAt}\n\n${entry.text.trim() || '(empty)'}`
    )
    .join('\n\n');

  return [
    `# Session ${sessionId}`,
    '',
    '## Questions',
    '',
    questionLines,
    '',
    '## Experiments',
    '',
    experimentLines,
    '',
    '## Transcript',
    '',
    transcriptSection
  ].join('\n');
}

async function readGitOutput(cwd: string, args: string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd,
    reject: false
  });
  return result.exitCode === 0 ? result.stdout : result.stderr || result.stdout;
}
