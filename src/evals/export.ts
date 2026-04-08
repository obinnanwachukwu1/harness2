import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { execa } from 'execa';

import type { Notebook } from '../storage/notebook.js';
import type {
  EvalAutoScore,
  EvalCaseArtifacts,
  EvalRuntimeConfig
} from './manifest-types.js';

export async function exportEvalCaseArtifacts(input: {
  artifactRoot: string;
  notebook: Notebook;
  sessionId: string;
  runtime: EvalRuntimeConfig;
  autoScore: EvalAutoScore;
  workspacePath: string;
}): Promise<EvalCaseArtifacts> {
  await mkdir(input.artifactRoot, { recursive: true });

  const transcript = input.notebook.listTranscript(input.sessionId, Number.MAX_SAFE_INTEGER);
  const modelHistory = input.notebook.listModelHistory(input.sessionId);
  const questions = input.notebook.listStudyDebts(input.sessionId);
  const experiments = input.notebook.listExperiments(input.sessionId);

  const sessionMarkdownPath = path.join(input.artifactRoot, 'session.md');
  const transcriptJsonPath = path.join(input.artifactRoot, 'transcript.json');
  const modelHistoryJsonPath = path.join(input.artifactRoot, 'model-history.json');
  const questionsJsonPath = path.join(input.artifactRoot, 'questions.json');
  const experimentsJsonPath = path.join(input.artifactRoot, 'experiments.json');
  const runtimeJsonPath = path.join(input.artifactRoot, 'runtime.json');
  const gitStatusPath = path.join(input.artifactRoot, 'git-status.txt');
  const diffPatchPath = path.join(input.artifactRoot, 'diff.patch');
  const autoScorePath = path.join(input.artifactRoot, 'score.auto.json');

  await Promise.all([
    writeFile(sessionMarkdownPath, renderSessionMarkdown(input.sessionId, transcript, questions, experiments), 'utf8'),
    writeFile(transcriptJsonPath, JSON.stringify(transcript, null, 2), 'utf8'),
    writeFile(modelHistoryJsonPath, JSON.stringify(modelHistory, null, 2), 'utf8'),
    writeFile(questionsJsonPath, JSON.stringify(questions, null, 2), 'utf8'),
    writeFile(experimentsJsonPath, JSON.stringify(experiments, null, 2), 'utf8'),
    writeFile(runtimeJsonPath, JSON.stringify(input.runtime, null, 2), 'utf8'),
    writeFile(autoScorePath, JSON.stringify(input.autoScore, null, 2), 'utf8'),
    writeFile(gitStatusPath, await readGitOutput(input.workspacePath, ['status', '--short']), 'utf8'),
    writeFile(diffPatchPath, await readGitOutput(input.workspacePath, ['diff']), 'utf8')
  ]);

  return {
    sessionMarkdownPath,
    transcriptJsonPath,
    modelHistoryJsonPath,
    questionsJsonPath,
    experimentsJsonPath,
    runtimeJsonPath,
    gitStatusPath,
    diffPatchPath,
    autoScorePath
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

async function readGitOutput(workspacePath: string, args: string[]): Promise<string> {
  const result = await execa('git', args, {
    cwd: workspacePath,
    reject: false
  });
  return result.exitCode === 0 ? result.stdout : result.stderr || result.stdout;
}
