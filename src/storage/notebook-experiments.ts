import type { DatabaseSync } from 'node:sqlite';

import type {
  ExperimentDetails,
  ExperimentObservation,
  ExperimentObservationTag,
  ExperimentRecord,
  ExperimentSearchResult
} from '../types.js';
import { nowIso } from '../lib/utils.js';

interface ExperimentRow {
  id: string;
  session_id: string;
  study_debt_id: string | null;
  hypothesis: string;
  command: string;
  context: string;
  base_commit_sha: string;
  branch_name: string;
  worktree_path: string;
  status: ExperimentRecord['status'];
  budget: number;
  tokens_used: number;
  context_tokens_used: number;
  tool_output_tokens_used: number;
  observation_tokens_used: number;
  preserve: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  final_verdict: ExperimentRecord['finalVerdict'];
  final_summary: string | null;
  discovered_json: string | null;
  artifacts_json: string | null;
  constraints_json: string | null;
  confidence_note: string | null;
  low_signal_warning_emitted: number;
  promote: number;
}

interface ObservationRow {
  id: number;
  experiment_id: string;
  message: string;
  created_at: string;
  tags_json: string | null;
}

interface TableInfoRow {
  name: string;
}

export const EXPERIMENT_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS experiments (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    study_debt_id TEXT REFERENCES study_debts(id) ON DELETE SET NULL,
    hypothesis TEXT NOT NULL,
    command TEXT NOT NULL,
    context TEXT NOT NULL,
    base_commit_sha TEXT NOT NULL,
    branch_name TEXT NOT NULL,
    worktree_path TEXT NOT NULL,
    status TEXT NOT NULL,
    budget INTEGER NOT NULL,
    tokens_used INTEGER NOT NULL,
    context_tokens_used INTEGER NOT NULL DEFAULT 0,
    tool_output_tokens_used INTEGER NOT NULL DEFAULT 0,
    observation_tokens_used INTEGER NOT NULL DEFAULT 0,
    preserve INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    resolved_at TEXT,
    final_verdict TEXT,
    final_summary TEXT,
    discovered_json TEXT,
    artifacts_json TEXT,
    constraints_json TEXT,
    confidence_note TEXT,
    low_signal_warning_emitted INTEGER NOT NULL DEFAULT 0,
    promote INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_experiments_session_created_at
  ON experiments(session_id, created_at);

  CREATE TABLE IF NOT EXISTS experiment_observations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
    message TEXT NOT NULL,
    created_at TEXT NOT NULL,
    tags_json TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_experiment_observations_experiment_created_at
  ON experiment_observations(experiment_id, created_at);
`;

const EXPERIMENT_SELECT_COLUMNS = `
  id,
  session_id,
  study_debt_id,
  hypothesis,
  command,
  context,
  base_commit_sha,
  branch_name,
  worktree_path,
  status,
  budget,
  tokens_used,
  context_tokens_used,
  tool_output_tokens_used,
  observation_tokens_used,
  preserve,
  created_at,
  updated_at,
  resolved_at,
  final_verdict,
  final_summary,
  discovered_json,
  artifacts_json,
  constraints_json,
  confidence_note,
  low_signal_warning_emitted,
  promote
`;

const UPSERT_EXPERIMENT_SQL = `
  INSERT INTO experiments (
    id,
    session_id,
    study_debt_id,
    hypothesis,
    command,
    context,
    base_commit_sha,
    branch_name,
    worktree_path,
    status,
    budget,
    tokens_used,
    context_tokens_used,
    tool_output_tokens_used,
    observation_tokens_used,
    preserve,
    created_at,
    updated_at,
    resolved_at,
    final_verdict,
    final_summary,
    discovered_json,
    artifacts_json,
    constraints_json,
    confidence_note,
    low_signal_warning_emitted,
    promote
  )
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    session_id = excluded.session_id,
    study_debt_id = excluded.study_debt_id,
    hypothesis = excluded.hypothesis,
    command = excluded.command,
    context = excluded.context,
    base_commit_sha = excluded.base_commit_sha,
    branch_name = excluded.branch_name,
    worktree_path = excluded.worktree_path,
    status = excluded.status,
    budget = excluded.budget,
    tokens_used = excluded.tokens_used,
    context_tokens_used = excluded.context_tokens_used,
    tool_output_tokens_used = excluded.tool_output_tokens_used,
    observation_tokens_used = excluded.observation_tokens_used,
    preserve = excluded.preserve,
    created_at = excluded.created_at,
    updated_at = excluded.updated_at,
    resolved_at = excluded.resolved_at,
    final_verdict = excluded.final_verdict,
    final_summary = excluded.final_summary,
    discovered_json = excluded.discovered_json,
    artifacts_json = excluded.artifacts_json,
    constraints_json = excluded.constraints_json,
    confidence_note = excluded.confidence_note,
    low_signal_warning_emitted = excluded.low_signal_warning_emitted,
    promote = excluded.promote
`;

export function migrateExperimentTables(db: DatabaseSync): void {
  const experimentColumns = db.prepare(`PRAGMA table_info(experiments)`).all() as unknown as TableInfoRow[];

  if (!experimentColumns.some((column) => column.name === 'discovered_json')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN discovered_json TEXT`);
  }

  if (!experimentColumns.some((column) => column.name === 'artifacts_json')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN artifacts_json TEXT`);
  }

  if (!experimentColumns.some((column) => column.name === 'constraints_json')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN constraints_json TEXT`);
  }

  if (!experimentColumns.some((column) => column.name === 'confidence_note')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN confidence_note TEXT`);
  }

  if (!experimentColumns.some((column) => column.name === 'low_signal_warning_emitted')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN low_signal_warning_emitted INTEGER NOT NULL DEFAULT 0`);
  }

  if (!experimentColumns.some((column) => column.name === 'promote')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN promote INTEGER NOT NULL DEFAULT 0`);
  }

  if (!experimentColumns.some((column) => column.name === 'study_debt_id')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN study_debt_id TEXT REFERENCES study_debts(id) ON DELETE SET NULL`);
  }

  if (!experimentColumns.some((column) => column.name === 'context_tokens_used')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN context_tokens_used INTEGER NOT NULL DEFAULT 0`);
  }

  if (!experimentColumns.some((column) => column.name === 'tool_output_tokens_used')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN tool_output_tokens_used INTEGER NOT NULL DEFAULT 0`);
  }

  if (!experimentColumns.some((column) => column.name === 'observation_tokens_used')) {
    db.exec(`ALTER TABLE experiments ADD COLUMN observation_tokens_used INTEGER NOT NULL DEFAULT 0`);
  }

  const observationColumns = db
    .prepare(`PRAGMA table_info(experiment_observations)`)
    .all() as unknown as TableInfoRow[];

  if (!observationColumns.some((column) => column.name === 'tags_json')) {
    db.exec(`ALTER TABLE experiment_observations ADD COLUMN tags_json TEXT`);
  }
}

export function upsertExperiment(db: DatabaseSync, experiment: ExperimentRecord): void {
  db.prepare(UPSERT_EXPERIMENT_SQL).run(
    experiment.id,
    experiment.sessionId,
    experiment.studyDebtId,
    experiment.hypothesis,
    experiment.command,
    experiment.context,
    experiment.baseCommitSha,
    experiment.branchName,
    experiment.worktreePath,
    experiment.status,
    experiment.budget,
    experiment.tokensUsed,
    experiment.contextTokensUsed,
    experiment.toolOutputTokensUsed,
    experiment.observationTokensUsed,
    experiment.preserve ? 1 : 0,
    experiment.createdAt,
    experiment.updatedAt,
    experiment.resolvedAt,
    experiment.finalVerdict,
    experiment.finalSummary,
    JSON.stringify(experiment.discovered),
    JSON.stringify(experiment.artifacts),
    JSON.stringify(experiment.constraints),
    experiment.confidenceNote,
    experiment.lowSignalWarningEmitted ? 1 : 0,
    experiment.promote ? 1 : 0
  );
}

export function getExperiment(db: DatabaseSync, experimentId: string): ExperimentRecord | null {
  const row = db
    .prepare(
      `
        SELECT ${EXPERIMENT_SELECT_COLUMNS}
        FROM experiments
        WHERE id = ?
      `
    )
    .get(experimentId) as ExperimentRow | undefined;

  return row ? mapExperiment(row) : null;
}

export function listExperiments(db: DatabaseSync, sessionId: string): ExperimentRecord[] {
  const rows = db
    .prepare(
      `
        SELECT ${EXPERIMENT_SELECT_COLUMNS}
        FROM experiments
        WHERE session_id = ?
        ORDER BY created_at DESC
      `
    )
    .all(sessionId) as unknown as ExperimentRow[];

  return rows.map(mapExperiment);
}

export function listInvalidatedExperimentsForStudyDebt(
  db: DatabaseSync,
  questionId: string
): ExperimentRecord[] {
  const rows = db
    .prepare(
      `
        SELECT ${EXPERIMENT_SELECT_COLUMNS}
        FROM experiments
        WHERE study_debt_id = ?
          AND (final_verdict = 'invalidated' OR status = 'invalidated')
        ORDER BY updated_at DESC, id DESC
      `
    )
    .all(questionId) as unknown as ExperimentRow[];

  return rows.map(mapExperiment);
}

export function listActiveExperimentsForStudyDebt(
  db: DatabaseSync,
  questionId: string
): ExperimentRecord[] {
  const rows = db
    .prepare(
      `
        SELECT ${EXPERIMENT_SELECT_COLUMNS}
        FROM experiments
        WHERE study_debt_id = ?
          AND status IN ('running', 'budget_exhausted')
        ORDER BY updated_at DESC, id DESC
      `
    )
    .all(questionId) as unknown as ExperimentRow[];

  return rows.map(mapExperiment);
}

export function appendObservation(
  db: DatabaseSync,
  experimentId: string,
  message: string,
  tags: ExperimentObservationTag[] = []
): ExperimentObservation {
  const createdAt = nowIso();
  db.prepare(
    `
      INSERT INTO experiment_observations (experiment_id, message, created_at, tags_json)
      VALUES (?, ?, ?, ?)
    `
  ).run(experimentId, message, createdAt, JSON.stringify(tags));

  const row = db
    .prepare(
      `
        SELECT id, experiment_id, message, created_at, tags_json
        FROM experiment_observations
        WHERE id = last_insert_rowid()
      `
    )
    .get() as unknown as ObservationRow;

  return mapObservation(row);
}

export function listObservations(db: DatabaseSync, experimentId: string): ExperimentObservation[] {
  const rows = db
    .prepare(
      `
        SELECT id, experiment_id, message, created_at, tags_json
        FROM experiment_observations
        WHERE experiment_id = ?
        ORDER BY id ASC
      `
    )
    .all(experimentId) as unknown as ObservationRow[];

  return rows.map(mapObservation);
}

export function searchExperimentDetails(
  db: DatabaseSync,
  sessionId: string,
  query?: string
): ExperimentDetails[] {
  const normalized = query?.trim();
  if (!normalized) {
    return listExperiments(db, sessionId).map((experiment) => ({
      ...experiment,
      observations: listObservations(db, experiment.id)
    }));
  }

  const searchTerm = `%${normalized}%`;
  const rows = db
    .prepare(
      `
        SELECT DISTINCT ${aliasExperimentColumns('e')}
        FROM experiments e
        LEFT JOIN experiment_observations o
          ON o.experiment_id = e.id
        WHERE e.session_id = ?
          AND (
            e.id LIKE ?
            OR e.hypothesis LIKE ?
            OR e.final_summary LIKE ?
            OR o.message LIKE ?
          )
        ORDER BY e.created_at DESC
      `
    )
    .all(sessionId, searchTerm, searchTerm, searchTerm, searchTerm) as unknown as ExperimentRow[];

  return rows.map((row) => ({
    ...mapExperiment(row),
    observations: listObservations(db, row.id)
  }));
}

export function searchExperimentSummaries(
  db: DatabaseSync,
  sessionId: string,
  query?: string
): ExperimentSearchResult[] {
  const normalized = query?.trim();
  if (!normalized) {
    return listExperiments(db, sessionId).map(mapExperimentSearchResult);
  }

  const searchTerm = `%${normalized}%`;
  const rows = db
    .prepare(
      `
        SELECT DISTINCT ${aliasExperimentColumns('e')}
        FROM experiments e
        LEFT JOIN experiment_observations o
          ON o.experiment_id = e.id
        WHERE e.session_id = ?
          AND (
            e.id LIKE ?
            OR e.hypothesis LIKE ?
            OR e.status LIKE ?
            OR e.final_summary LIKE ?
            OR e.discovered_json LIKE ?
            OR o.message LIKE ?
          )
        ORDER BY e.created_at DESC
      `
    )
    .all(
      sessionId,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm,
      searchTerm
    ) as unknown as ExperimentRow[];

  return rows.map((row) => mapExperimentSearchResult(mapExperiment(row)));
}

export function getExperimentDetails(db: DatabaseSync, experimentId: string): ExperimentDetails | null {
  const experiment = getExperiment(db, experimentId);
  if (!experiment) {
    return null;
  }

  return {
    ...experiment,
    observations: listObservations(db, experimentId)
  };
}

function aliasExperimentColumns(alias: string): string {
  return EXPERIMENT_SELECT_COLUMNS.split(',')
    .map((column) => `${alias}.${column.trim()}`)
    .join(', ');
}

function mapExperiment(row: ExperimentRow): ExperimentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    studyDebtId: row.study_debt_id,
    hypothesis: row.hypothesis,
    command: row.command,
    context: row.context,
    baseCommitSha: row.base_commit_sha,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    status: row.status,
    budget: row.budget,
    tokensUsed: row.tokens_used,
    contextTokensUsed: row.context_tokens_used,
    toolOutputTokensUsed: row.tool_output_tokens_used,
    observationTokensUsed: row.observation_tokens_used,
    preserve: Boolean(row.preserve),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    finalVerdict: row.final_verdict,
    finalSummary: row.final_summary,
    discovered: parseStoredStringArray(row.discovered_json, 'experiments.discovered_json'),
    artifacts: parseStoredStringArray(row.artifacts_json, 'experiments.artifacts_json'),
    constraints: parseStoredStringArray(row.constraints_json, 'experiments.constraints_json'),
    confidenceNote: row.confidence_note,
    lowSignalWarningEmitted: Boolean(row.low_signal_warning_emitted),
    promote: Boolean(row.promote)
  };
}

function mapObservation(row: ObservationRow): ExperimentObservation {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    message: row.message,
    createdAt: row.created_at,
    tags: parseStoredStringArray(row.tags_json, 'experiment_observations.tags_json') as ExperimentObservationTag[]
  };
}

function mapExperimentSearchResult(experiment: ExperimentRecord): ExperimentSearchResult {
  return {
    experimentId: experiment.id,
    hypothesis: experiment.hypothesis,
    status: experiment.status,
    summary: experiment.finalSummary ?? '',
    discovered: experiment.discovered
  };
}

function parseStoredStringArray(value: string | null, field: string): string[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}: ${String(error)}`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string')) {
    throw new Error(`Invalid string array stored in ${field}.`);
  }

  return parsed;
}
