import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseToml } from 'smol-toml';
import { z } from 'zod';

import type {
  EvalCaseDefinition,
  EvalCaseEnvOverride,
  EvalClarificationPolicy,
  EvalFixtureDefinition,
  EvalFollowupTurn,
  EvalRuntimeConfig,
  EvalSuiteManifest,
  EvalSuiteMeta
} from './manifest-types.js';

const runtimeSchema = z.object({
  model: z.string().trim().min(1).optional(),
  reasoning_effort: z.enum(['off', 'low', 'medium', 'high']),
  thinking: z.boolean().optional().default(false),
  web_search_mode: z.enum(['disabled', 'cached', 'live', 'fixed']).optional().default('fixed'),
  max_steps: z.number().int().positive().optional(),
  parallelism: z.number().int().positive().optional(),
  default_experiment_budget: z.number().int().positive().optional()
});

const clarificationSchema = z
  .object({
    auto_reply: z.string().trim().min(1),
    mark_as_unnecessary: z.boolean().optional().default(false)
  })
  .optional();

const fixtureSchema = z.object({
  id: z.string().trim().min(1),
  type: z.enum(['template', 'git_checkout']),
  path: z.string().trim().min(1),
  ref: z.string().trim().min(1).optional(),
  setup_command: z.string().trim().min(1).optional(),
  env_source: z.string().trim().min(1).optional(),
  write_env_file: z.string().trim().min(1).optional(),
  write_env_example: z.string().trim().min(1).optional(),
  validate_env_example: z.boolean().optional()
});

const followupSchema = z.object({
  after_turn: z.number().int().positive(),
  prompt: z.string().trim().min(1)
});

const runtimeOverrideSchema = runtimeSchema.partial();

const caseEnvOverrideSchema = z
  .object({
    env_source: z.string().trim().min(1).optional(),
    write_env_file: z.string().trim().min(1).optional(),
    write_env_example: z.string().trim().min(1).optional()
  })
  .optional();

const caseSchema = z.object({
  id: z.string().trim().min(1),
  bucket: z.enum(['A', 'B', 'C', 'W']),
  fixture: z.string().trim().min(1),
  profile: z.string().trim().min(1),
  prompt: z.string().trim().min(1),
  notes: z.string().optional(),
  question_expected: z.boolean().optional(),
  experiment_expected: z.boolean().optional(),
  web_search_expected: z.enum(['yes', 'no', 'optional']).optional(),
  runtime_override: runtimeOverrideSchema.optional(),
  env_override: caseEnvOverrideSchema,
  followups: z.array(followupSchema).optional().default([]),
  review_hints: z.array(z.string()).optional().default([])
});

const manifestSchema = z.object({
  suite: z.object({
    id: z.string().trim().min(1),
    description: z.string().optional()
  }),
  runtime: runtimeSchema,
  clarification: clarificationSchema,
  fixtures: z.array(fixtureSchema).min(1),
  cases: z.array(caseSchema).min(1)
});

export interface ParsedEvalManifest {
  manifest: EvalSuiteManifest;
  manifestPath: string;
  manifestDir: string;
}

export async function parseEvalManifest(manifestPath: string): Promise<ParsedEvalManifest> {
  const absolutePath = path.resolve(manifestPath);
  const rawText = await readFile(absolutePath, 'utf8');
  const raw = parseToml(rawText);
  const parsed = manifestSchema.parse(raw);
  const manifestDir = path.dirname(absolutePath);

  const suite: EvalSuiteMeta = {
    id: parsed.suite.id,
    description: parsed.suite.description
  };
  const runtime: EvalRuntimeConfig = {
    model: normalizeModelSelection(parsed.runtime.model),
    reasoningEffort: parsed.runtime.reasoning_effort,
    thinking: parsed.runtime.thinking,
    webSearchMode: parsed.runtime.web_search_mode,
    parallelism: parsed.runtime.parallelism,
    defaultExperimentBudget: parsed.runtime.default_experiment_budget
  };
  const clarification: EvalClarificationPolicy | undefined = parsed.clarification
    ? {
        autoReply: parsed.clarification.auto_reply,
        markAsUnnecessary: parsed.clarification.mark_as_unnecessary
      }
    : undefined;
  const fixtures: EvalFixtureDefinition[] = parsed.fixtures.map((fixture) => ({
    id: fixture.id,
    type: fixture.type,
    path: resolveManifestPath(manifestDir, fixture.path),
    ref: fixture.ref,
    setupCommand: fixture.setup_command,
    envSource: fixture.env_source ? resolveManifestPath(manifestDir, fixture.env_source) : undefined,
    writeEnvFile: fixture.write_env_file,
    writeEnvExample: fixture.write_env_example,
    validateEnvExample: fixture.validate_env_example
  }));
  const cases: EvalCaseDefinition[] = parsed.cases.map((entry) => ({
    id: entry.id,
    bucket: entry.bucket,
    fixture: entry.fixture,
    profile: entry.profile,
    prompt: entry.prompt,
    notes: entry.notes,
    questionExpected: entry.question_expected,
    experimentExpected: entry.experiment_expected,
    webSearchExpected: entry.web_search_expected,
    runtimeOverride: entry.runtime_override
      ? normalizeRuntimeOverride(entry.runtime_override)
      : undefined,
    envOverride: entry.env_override
      ? normalizeEnvOverride(entry.env_override, manifestDir)
      : undefined,
    followups: entry.followups.map((followup) => ({
      afterTurn: followup.after_turn,
      prompt: followup.prompt
    })),
    reviewHints: entry.review_hints
  }));

  validateManifestFixtureReferences(fixtures, cases);

  return {
    manifest: {
      suite,
      runtime,
      clarification,
      fixtures,
      cases
    },
    manifestPath: absolutePath,
    manifestDir
  };
}

function resolveManifestPath(manifestDir: string, targetPath: string): string {
  if (path.isAbsolute(targetPath)) {
    return targetPath;
  }
  if (targetPath.startsWith('~/')) {
    return targetPath;
  }
  return path.resolve(manifestDir, targetPath);
}

function normalizeRuntimeOverride(
  input: z.infer<typeof runtimeOverrideSchema>
): Partial<EvalRuntimeConfig> {
  return {
    model: normalizeModelSelection(input.model),
    reasoningEffort: input.reasoning_effort,
    thinking: input.thinking,
    webSearchMode: input.web_search_mode,
    parallelism: input.parallelism,
    defaultExperimentBudget: input.default_experiment_budget
  };
}

function normalizeModelSelection(model: string | undefined): string | undefined {
  if (!model) {
    return undefined;
  }
  return model.trim().toLowerCase() === 'default' ? undefined : model;
}

function normalizeEnvOverride(
  input: z.infer<typeof caseEnvOverrideSchema>,
  manifestDir: string
): EvalCaseEnvOverride | undefined {
  if (!input) {
    return undefined;
  }
  return {
    envSource: input.env_source ? resolveManifestPath(manifestDir, input.env_source) : undefined,
    writeEnvFile: input.write_env_file,
    writeEnvExample: input.write_env_example
  };
}

function validateManifestFixtureReferences(
  fixtures: EvalFixtureDefinition[],
  cases: EvalCaseDefinition[]
): void {
  const fixtureIds = new Set(fixtures.map((fixture) => fixture.id));
  for (const entry of cases) {
    if (!fixtureIds.has(entry.fixture)) {
      throw new Error(`Case ${entry.id} references unknown fixture ${entry.fixture}.`);
    }
  }
}
