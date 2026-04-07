import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  EngineSnapshot,
  ExperimentDetails,
  ExperimentObservation,
  ExperimentRecord,
  ExperimentObservationTag,
  ExperimentStatus,
  ExperimentSearchResult,
  ModelHistoryItem,
  ModelMessageRole,
  ModelSessionRecord,
  OpenAICodexAuthRecord,
  SessionRecord,
  SessionCheckpointRecord,
  StudyDebtKind,
  StudyDebtRecord,
  StudyDebtResolution,
  TranscriptEntry,
  TranscriptRole
} from '../types.js';
import { nowIso } from '../lib/utils.js';

interface SessionRow {
  id: string;
  cwd: string;
  started_at: string;
  last_active_at: string;
}

interface TranscriptRow {
  id: number;
  session_id: string;
  role: TranscriptRole;
  text: string;
  created_at: string;
}

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

interface AuthTokenRow {
  provider: string;
  type: 'oauth';
  access_token: string;
  refresh_token: string;
  id_token: string;
  account_id: string;
  expires_at: number;
  created_at: string;
  updated_at: string;
}

interface ModelSessionRow {
  session_id: string;
  provider: 'openai-codex';
  model: string;
  reasoning_effort: 'low' | 'medium' | 'high' | null;
  previous_response_id: string | null;
  updated_at: string;
}

interface ModelHistoryRow {
  id: number;
  session_id: string;
  item_type: ModelHistoryItem['type'];
  role: ModelMessageRole | null;
  name: string | null;
  call_id: string | null;
  arguments_text: string | null;
  content_text: string | null;
  created_at: string;
}

interface StudyDebtRow {
  id: string;
  session_id: string;
  status: 'open' | 'closed';
  kind: StudyDebtKind;
  summary: string;
  why_it_matters: string;
  affected_paths_json: string | null;
  recommended_study: string | null;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  resolution: StudyDebtResolution | null;
  resolution_note: string | null;
}

interface SessionCheckpointRow {
  id: number;
  session_id: string;
  created_at: string;
  goal: string;
  completed: string;
  next: string;
  open_risks: string | null;
  git_log: string;
  git_status: string;
  git_diff_stat: string;
  last_test_status: string | null;
  active_experiments_json: string;
  checkpoint_block: string;
  tail_start_history_id: number | null;
}

interface TableInfoRow {
  name: string;
}

export class Notebook {
  private readonly db: DatabaseSync;

  constructor(private readonly dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.init();
  }

  private init(): void {
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA foreign_keys = ON;

      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY,
        cwd TEXT NOT NULL,
        started_at TEXT NOT NULL,
        last_active_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS transcript_entries (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_transcript_session_created_at
      ON transcript_entries(session_id, created_at);

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

      CREATE TABLE IF NOT EXISTS auth_tokens (
        provider TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        access_token TEXT NOT NULL,
        refresh_token TEXT NOT NULL,
        id_token TEXT NOT NULL,
        account_id TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_sessions (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        reasoning_effort TEXT,
        previous_response_id TEXT,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS model_history_items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        item_type TEXT NOT NULL,
        role TEXT,
        name TEXT,
        call_id TEXT,
        arguments_text TEXT,
        content_text TEXT,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_model_history_items_session_id
      ON model_history_items(session_id, id);

      CREATE TABLE IF NOT EXISTS study_debts (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        status TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        why_it_matters TEXT NOT NULL,
        affected_paths_json TEXT,
        recommended_study TEXT,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        resolution TEXT,
        resolution_note TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_study_debts_session_status
      ON study_debts(session_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        goal TEXT NOT NULL,
        completed TEXT NOT NULL,
        next TEXT NOT NULL,
        open_risks TEXT,
        git_log TEXT NOT NULL,
        git_status TEXT NOT NULL,
        git_diff_stat TEXT NOT NULL,
        last_test_status TEXT,
        active_experiments_json TEXT NOT NULL,
        checkpoint_block TEXT NOT NULL,
        tail_start_history_id INTEGER
      );

      CREATE INDEX IF NOT EXISTS idx_session_checkpoints_session_id
      ON session_checkpoints(session_id, id DESC);
    `);

    const modelSessionColumns = this.db
      .prepare(`PRAGMA table_info(model_sessions)`)
      .all() as unknown as TableInfoRow[];

    if (!modelSessionColumns.some((column) => column.name === 'reasoning_effort')) {
      this.db.exec(`ALTER TABLE model_sessions ADD COLUMN reasoning_effort TEXT`);
    }

    const experimentColumns = this.db
      .prepare(`PRAGMA table_info(experiments)`)
      .all() as unknown as TableInfoRow[];

    if (!experimentColumns.some((column) => column.name === 'discovered_json')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN discovered_json TEXT`);
    }

    if (!experimentColumns.some((column) => column.name === 'artifacts_json')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN artifacts_json TEXT`);
    }

    if (!experimentColumns.some((column) => column.name === 'constraints_json')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN constraints_json TEXT`);
    }

    if (!experimentColumns.some((column) => column.name === 'confidence_note')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN confidence_note TEXT`);
    }

    if (!experimentColumns.some((column) => column.name === 'low_signal_warning_emitted')) {
      this.db.exec(
        `ALTER TABLE experiments ADD COLUMN low_signal_warning_emitted INTEGER NOT NULL DEFAULT 0`
      );
    }

    if (!experimentColumns.some((column) => column.name === 'promote')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN promote INTEGER NOT NULL DEFAULT 0`);
    }

    if (!experimentColumns.some((column) => column.name === 'study_debt_id')) {
      this.db.exec(
        `ALTER TABLE experiments ADD COLUMN study_debt_id TEXT REFERENCES study_debts(id) ON DELETE SET NULL`
      );
    }

    if (!experimentColumns.some((column) => column.name === 'context_tokens_used')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN context_tokens_used INTEGER NOT NULL DEFAULT 0`);
    }

    if (!experimentColumns.some((column) => column.name === 'tool_output_tokens_used')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN tool_output_tokens_used INTEGER NOT NULL DEFAULT 0`);
    }

    if (!experimentColumns.some((column) => column.name === 'observation_tokens_used')) {
      this.db.exec(`ALTER TABLE experiments ADD COLUMN observation_tokens_used INTEGER NOT NULL DEFAULT 0`);
    }

    const observationColumns = this.db
      .prepare(`PRAGMA table_info(experiment_observations)`)
      .all() as unknown as TableInfoRow[];

    if (!observationColumns.some((column) => column.name === 'tags_json')) {
      this.db.exec(`ALTER TABLE experiment_observations ADD COLUMN tags_json TEXT`);
    }
  }

  createSession(sessionId: string, cwd: string): SessionRecord {
    const existing = this.getSession(sessionId);
    if (existing) {
      this.touchSession(sessionId);
      return this.getSession(sessionId) as SessionRecord;
    }

    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO sessions (id, cwd, started_at, last_active_at)
          VALUES (?, ?, ?, ?)
        `
      )
      .run(sessionId, cwd, timestamp, timestamp);

    return this.getSession(sessionId) as SessionRecord;
  }

  touchSession(sessionId: string): void {
    this.db
      .prepare(
        `
          UPDATE sessions
          SET last_active_at = ?
          WHERE id = ?
        `
      )
      .run(nowIso(), sessionId);
  }

  getSession(sessionId: string): SessionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT id, cwd, started_at, last_active_at
          FROM sessions
          WHERE id = ?
        `
      )
      .get(sessionId) as SessionRow | undefined;

    return row ? mapSession(row) : null;
  }

  appendTranscript(sessionId: string, role: TranscriptRole, text: string): void {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO transcript_entries (session_id, role, text, created_at)
          VALUES (?, ?, ?, ?)
        `
      )
      .run(sessionId, role, text, timestamp);
    this.touchSession(sessionId);
  }

  listTranscript(sessionId: string, limit = 200): TranscriptEntry[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, session_id, role, text, created_at
          FROM transcript_entries
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT ?
        `
      )
      .all(sessionId, limit) as unknown as TranscriptRow[];

    return rows.reverse().map(mapTranscript);
  }

  upsertExperiment(experiment: ExperimentRecord): void {
    this.db
      .prepare(
        `
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
        `
      )
      .run(
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

    this.touchSession(experiment.sessionId);
  }

  getExperiment(experimentId: string): ExperimentRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
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
          FROM experiments
          WHERE id = ?
        `
      )
      .get(experimentId) as ExperimentRow | undefined;

    return row ? mapExperiment(row) : null;
  }

  listExperiments(sessionId: string): ExperimentRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
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
          FROM experiments
          WHERE session_id = ?
          ORDER BY created_at DESC
        `
      )
      .all(sessionId) as unknown as ExperimentRow[];

    return rows.map(mapExperiment);
  }

  listInvalidatedExperimentsForStudyDebt(questionId: string): ExperimentRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
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
          FROM experiments
          WHERE study_debt_id = ?
            AND (final_verdict = 'invalidated' OR status = 'invalidated')
          ORDER BY updated_at DESC, id DESC
        `
      )
      .all(questionId) as unknown as ExperimentRow[];

    return rows.map(mapExperiment);
  }

  clearExperimentJournal(
    sessionId: string,
    options: { force?: boolean } = {}
  ): { clearedExperiments: number; clearedObservations: number; blockedActive: number } {
    const activeStatuses: ExperimentStatus[] = ['running', 'budget_exhausted'];
    const activeRows = this.db
      .prepare(
        `
          SELECT id
          FROM experiments
          WHERE session_id = ?
            AND status IN (?, ?)
        `
      )
      .all(sessionId, activeStatuses[0], activeStatuses[1]) as Array<{ id: string }>;

    if (activeRows.length > 0 && !options.force) {
      return {
        clearedExperiments: 0,
        clearedObservations: 0,
        blockedActive: activeRows.length
      };
    }

    const observationResult = this.db
      .prepare(
        `
          DELETE FROM experiment_observations
          WHERE experiment_id IN (
            SELECT id FROM experiments WHERE session_id = ?
          )
        `
      )
      .run(sessionId);

    const experimentResult = this.db
      .prepare(
        `
          DELETE FROM experiments
          WHERE session_id = ?
        `
      )
      .run(sessionId);

    this.touchSession(sessionId);

    return {
      clearedExperiments: Number(experimentResult.changes ?? 0),
      clearedObservations: Number(observationResult.changes ?? 0),
      blockedActive: 0
    };
  }

  appendObservation(
    experimentId: string,
    message: string,
    tags: ExperimentObservationTag[] = []
  ): ExperimentObservation {
    const createdAt = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO experiment_observations (experiment_id, message, created_at, tags_json)
          VALUES (?, ?, ?, ?)
        `
      )
      .run(experimentId, message, createdAt, JSON.stringify(tags));

    const row = this.db
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

  listObservations(experimentId: string): ExperimentObservation[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, experiment_id, message, created_at
            , tags_json
          FROM experiment_observations
          WHERE experiment_id = ?
          ORDER BY id ASC
        `
      )
      .all(experimentId) as unknown as ObservationRow[];

    return rows.map(mapObservation);
  }

  searchExperimentDetails(sessionId: string, query?: string): ExperimentDetails[] {
    const normalized = query?.trim();
    if (!normalized) {
      return this.listExperiments(sessionId).map((experiment) => ({
        ...experiment,
        observations: this.listObservations(experiment.id)
      }));
    }

    const searchTerm = `%${normalized}%`;
    const rows = this.db
      .prepare(
        `
          SELECT DISTINCT
            e.id,
            e.session_id,
            e.study_debt_id,
            e.hypothesis,
            e.command,
            e.context,
            e.base_commit_sha,
            e.branch_name,
            e.worktree_path,
            e.status,
            e.budget,
            e.tokens_used,
            e.context_tokens_used,
            e.tool_output_tokens_used,
            e.observation_tokens_used,
            e.preserve,
            e.created_at,
            e.updated_at,
            e.resolved_at,
            e.final_verdict,
            e.final_summary,
            e.discovered_json,
            e.artifacts_json,
            e.constraints_json,
            e.confidence_note,
            e.low_signal_warning_emitted,
            e.promote
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
      observations: this.listObservations(row.id)
    }));
  }

  searchExperimentSummaries(sessionId: string, query?: string): ExperimentSearchResult[] {
    const normalized = query?.trim();
    if (!normalized) {
      return this.listExperiments(sessionId).map(mapExperimentSearchResult);
    }

    const searchTerm = `%${normalized}%`;
    const rows = this.db
      .prepare(
        `
          SELECT DISTINCT
            e.id,
            e.session_id,
            e.hypothesis,
            e.command,
            e.context,
            e.base_commit_sha,
            e.branch_name,
            e.worktree_path,
            e.status,
            e.budget,
            e.tokens_used,
            e.context_tokens_used,
            e.tool_output_tokens_used,
            e.observation_tokens_used,
            e.preserve,
            e.created_at,
            e.updated_at,
            e.resolved_at,
            e.final_verdict,
            e.final_summary,
            e.discovered_json,
            e.artifacts_json,
            e.constraints_json,
            e.confidence_note,
            e.low_signal_warning_emitted,
            e.promote
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

  getExperimentDetails(experimentId: string): ExperimentDetails | null {
    const experiment = this.getExperiment(experimentId);
    if (!experiment) {
      return null;
    }

    return {
      ...experiment,
      observations: this.listObservations(experimentId)
    };
  }

  upsertOpenAICodexAuth(record: OpenAICodexAuthRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO auth_tokens (
            provider,
            type,
            access_token,
            refresh_token,
            id_token,
            account_id,
            expires_at,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(provider) DO UPDATE SET
            type = excluded.type,
            access_token = excluded.access_token,
            refresh_token = excluded.refresh_token,
            id_token = excluded.id_token,
            account_id = excluded.account_id,
            expires_at = excluded.expires_at,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at
        `
      )
      .run(
        record.provider,
        record.type,
        record.accessToken,
        record.refreshToken,
        record.idToken,
        record.accountId,
        record.expiresAt,
        record.createdAt,
        record.updatedAt
      );
  }

  getOpenAICodexAuth(): OpenAICodexAuthRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            provider,
            type,
            access_token,
            refresh_token,
            id_token,
            account_id,
            expires_at,
            created_at,
            updated_at
          FROM auth_tokens
          WHERE provider = 'openai-codex'
        `
      )
      .get() as AuthTokenRow | undefined;

    return row ? mapAuthToken(row) : null;
  }

  deleteOpenAICodexAuth(): boolean {
    const result = this.db
      .prepare(
        `
          DELETE FROM auth_tokens
          WHERE provider = 'openai-codex'
        `
      )
      .run();

    return result.changes > 0;
  }

  upsertModelSession(record: ModelSessionRecord): void {
    this.db
      .prepare(
        `
          INSERT INTO model_sessions (
            session_id,
            provider,
            model,
            reasoning_effort,
            previous_response_id,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            reasoning_effort = excluded.reasoning_effort,
            previous_response_id = excluded.previous_response_id,
            updated_at = excluded.updated_at
        `
      )
      .run(
        record.sessionId,
        record.provider,
        record.model,
        record.reasoningEffort,
        record.previousResponseId,
        record.updatedAt
      );
  }

  getModelSession(sessionId: string): ModelSessionRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id,
            provider,
            model,
            reasoning_effort,
            previous_response_id,
            updated_at
          FROM model_sessions
          WHERE session_id = ?
        `
      )
      .get(sessionId) as ModelSessionRow | undefined;

    return row ? mapModelSession(row) : null;
  }

  appendModelHistoryItem(sessionId: string, item: ModelHistoryItem): void {
    const createdAt = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO model_history_items (
            session_id,
            item_type,
            role,
            name,
            call_id,
            arguments_text,
            content_text,
            created_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        sessionId,
        item.type,
        item.type === 'message' ? item.role : null,
        item.type === 'function_call' ? item.name : null,
        'call_id' in item ? item.call_id : null,
        item.type === 'function_call' ? item.arguments : null,
        item.type === 'message'
          ? item.content
          : item.type === 'function_call_output'
            ? item.output
            : null,
        createdAt
      );

    this.touchSession(sessionId);
  }

  getLatestModelHistoryId(sessionId: string): number | null {
    const row = this.db
      .prepare(
        `
          SELECT MAX(id) AS id
          FROM model_history_items
          WHERE session_id = ?
        `
      )
      .get(sessionId) as { id: number | null } | undefined;

    return row?.id ?? null;
  }

  getTailStartHistoryId(sessionId: string, tailLength: number): number | null {
    if (tailLength < 1) {
      return null;
    }

    const row = this.db
      .prepare(
        `
          SELECT id
          FROM model_history_items
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT 1 OFFSET ?
        `
      )
      .get(sessionId, tailLength - 1) as { id: number } | undefined;

    return row?.id ?? null;
  }

  listModelHistory(sessionId: string): ModelHistoryItem[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            item_type,
            role,
            name,
            call_id,
            arguments_text,
            content_text,
            created_at
          FROM model_history_items
          WHERE session_id = ?
          ORDER BY id ASC
        `
      )
      .all(sessionId) as unknown as ModelHistoryRow[];

    return rows.map(mapModelHistoryItem);
  }

  openStudyDebt(input: {
    sessionId: string;
    summary: string;
    whyItMatters: string;
    kind?: StudyDebtKind;
    affectedPaths?: string[];
    recommendedStudy?: string;
  }): StudyDebtRecord {
    const timestamp = nowIso();
    const id = `question-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const affectedPaths =
      input.affectedPaths && input.affectedPaths.length > 0
        ? input.affectedPaths.map((item) => item.trim()).filter(Boolean)
        : null;

    this.db
      .prepare(
        `
          INSERT INTO study_debts (
            id,
            session_id,
            status,
            kind,
            summary,
            why_it_matters,
            affected_paths_json,
            recommended_study,
            opened_at,
            updated_at,
            closed_at,
            resolution,
            resolution_note
          )
          VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        `
      )
      .run(
        id,
        input.sessionId,
        input.kind ?? 'runtime',
        input.summary.trim(),
        input.whyItMatters.trim(),
        affectedPaths ? JSON.stringify(affectedPaths) : null,
        input.recommendedStudy?.trim() || null,
        timestamp,
        timestamp
      );

    this.touchSession(input.sessionId);
    return this.getStudyDebt(id) as StudyDebtRecord;
  }

  resolveStudyDebt(input: {
    questionId: string;
    resolution: StudyDebtResolution;
    note: string;
  }): StudyDebtRecord {
    const existing = this.getStudyDebt(input.questionId);
    if (!existing) {
      throw new Error(`Unknown question: ${input.questionId}`);
    }

    const invalidatedExperiments = this.listInvalidatedExperimentsForStudyDebt(existing.id);
    if (
      invalidatedExperiments.length > 0 &&
      input.resolution !== 'scope_narrowed' &&
      input.resolution !== 'user_override'
    ) {
      throw new Error(
        [
          `Question ${input.questionId} is linked to invalidated experiment ${invalidatedExperiments
            .map((experiment) => experiment.id)
            .join(', ')}.`,
          'Do not resolve this question as study_run or static_evidence_sufficient.',
          'Narrow the claim with scope_narrowed, open a new question for a different path, or record a user override.'
        ].join('\n')
      );
    }

    const timestamp = nowIso();
    this.db
      .prepare(
        `
          UPDATE study_debts
          SET status = 'closed',
              updated_at = ?,
              closed_at = ?,
              resolution = ?,
              resolution_note = ?
          WHERE id = ?
        `
      )
      .run(timestamp, timestamp, input.resolution, input.note.trim(), input.questionId);

    this.touchSession(existing.sessionId);
    return this.getStudyDebt(input.questionId) as StudyDebtRecord;
  }

  listOpenStudyDebts(sessionId: string): StudyDebtRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            status,
            kind,
            summary,
            why_it_matters,
            affected_paths_json,
            recommended_study,
            opened_at,
            updated_at,
            closed_at,
            resolution,
            resolution_note
          FROM study_debts
          WHERE session_id = ?
            AND status = 'open'
          ORDER BY updated_at DESC, id DESC
        `
      )
      .all(sessionId) as unknown as StudyDebtRow[];

    return rows.map(mapStudyDebt);
  }

  listStudyDebts(sessionId: string): StudyDebtRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            status,
            kind,
            summary,
            why_it_matters,
            affected_paths_json,
            recommended_study,
            opened_at,
            updated_at,
            closed_at,
            resolution,
            resolution_note
          FROM study_debts
          WHERE session_id = ?
          ORDER BY opened_at ASC, id ASC
        `
      )
      .all(sessionId) as unknown as StudyDebtRow[];

    return rows.map(mapStudyDebt);
  }

  getStudyDebt(debtId: string): StudyDebtRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            status,
            kind,
            summary,
            why_it_matters,
            affected_paths_json,
            recommended_study,
            opened_at,
            updated_at,
            closed_at,
            resolution,
            resolution_note
          FROM study_debts
          WHERE id = ?
        `
      )
      .get(debtId) as StudyDebtRow | undefined;

    return row ? mapStudyDebt(row) : null;
  }

  buildModelRequestHistory(sessionId: string): ModelHistoryItem[] {
    const checkpoint = this.getLatestSessionCheckpoint(sessionId);
    const openStudyDebtReminder = this.buildOpenStudyDebtReminder(sessionId);
    if (!checkpoint) {
      return [
        ...(openStudyDebtReminder
          ? [{ type: 'message', role: 'developer', content: openStudyDebtReminder } satisfies ModelHistoryItem]
          : []),
        ...this.listModelHistory(sessionId)
      ];
    }

    const tailRows = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            item_type,
            role,
            name,
            call_id,
            arguments_text,
            content_text,
            created_at
          FROM model_history_items
          WHERE session_id = ?
            AND (? IS NULL OR id >= ?)
          ORDER BY id ASC
        `
      )
      .all(
        sessionId,
        checkpoint.tailStartHistoryId,
        checkpoint.tailStartHistoryId
      ) as unknown as ModelHistoryRow[];

    return [
      {
        type: 'message',
        role: 'developer',
        content: checkpoint.checkpointBlock
      },
      ...(openStudyDebtReminder
        ? [{ type: 'message', role: 'developer', content: openStudyDebtReminder } satisfies ModelHistoryItem]
        : []),
      ...tailRows.map(mapModelHistoryItem)
    ];
  }

  buildOpenStudyDebtReminder(sessionId: string): string | null {
    const openDebts = this.listOpenStudyDebts(sessionId);
    if (openDebts.length === 0) {
      return null;
    }

    return [
      'Open questions:',
      ...openDebts.map((debt) => {
        const invalidated = this.listInvalidatedExperimentsForStudyDebt(debt.id);
        const scope =
          debt.affectedPaths && debt.affectedPaths.length > 0
            ? ` scope=${debt.affectedPaths.join(', ')}`
            : ' scope=all main-workspace edits';
        const study = debt.recommendedStudy ? ` study=${debt.recommendedStudy}` : '';
        const invalidation =
          invalidated.length > 0
            ? ` linked_invalidated_experiments=${invalidated
                .map((experiment) => experiment.id)
                .join(', ')}; do not continue on the invalidated path without narrowing scope or opening a new question.`
            : '';
        return `- ${debt.id} [${debt.kind}]: ${debt.summary}; why=${debt.whyItMatters}; resolve via study, static evidence, scope narrowing, or user override before dependent edits. Tie any related experiment to this question.${scope}${study}${invalidation}`;
      })
    ].join('\n');
  }

  createSessionCheckpoint(input: {
    sessionId: string;
    goal: string;
    completed: string;
    next: string;
    openRisks?: string;
    gitLog: string;
    gitStatus: string;
    gitDiffStat: string;
    lastTestStatus?: string | null;
    activeExperimentSummaries: ExperimentSearchResult[];
    checkpointBlock: string;
    tailStartHistoryId: number | null;
  }): SessionCheckpointRecord {
    const createdAt = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO session_checkpoints (
            session_id,
            created_at,
            goal,
            completed,
            next,
            open_risks,
            git_log,
            git_status,
            git_diff_stat,
            last_test_status,
            active_experiments_json,
            checkpoint_block,
            tail_start_history_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.sessionId,
        createdAt,
        input.goal,
        input.completed,
        input.next,
        input.openRisks ?? null,
        input.gitLog,
        input.gitStatus,
        input.gitDiffStat,
        input.lastTestStatus ?? null,
        JSON.stringify(input.activeExperimentSummaries),
        input.checkpointBlock,
        input.tailStartHistoryId
      );

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            created_at,
            goal,
            completed,
            next,
            open_risks,
            git_log,
            git_status,
            git_diff_stat,
            last_test_status,
            active_experiments_json,
            checkpoint_block,
            tail_start_history_id
          FROM session_checkpoints
          WHERE id = last_insert_rowid()
        `
      )
      .get() as unknown as SessionCheckpointRow;

    this.touchSession(input.sessionId);
    return mapSessionCheckpoint(row);
  }

  getLatestSessionCheckpoint(sessionId: string): SessionCheckpointRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            created_at,
            goal,
            completed,
            next,
            open_risks,
            git_log,
            git_status,
            git_diff_stat,
            last_test_status,
            active_experiments_json,
            checkpoint_block,
            tail_start_history_id
          FROM session_checkpoints
          WHERE session_id = ?
          ORDER BY id DESC
          LIMIT 1
        `
      )
      .get(sessionId) as SessionCheckpointRow | undefined;

    return row ? mapSessionCheckpoint(row) : null;
  }

  getSnapshot(
    sessionId: string,
    processingTurn: boolean,
    statusText: string,
    estimatedContextTokens = 0,
    contextWindowTokens = 0,
    standardRateContextTokens: number | null = null,
    liveAssistantText: string | null = null,
    liveReasoningSummary: string | null = null,
    thinkingEnabled = true
  ): EngineSnapshot {
    const session = this.getSession(sessionId);
    if (!session) {
      throw new Error(`Unknown session: ${sessionId}`);
    }

    return {
      session,
      transcript: this.listTranscript(sessionId),
      experiments: this.listExperiments(sessionId),
      processingTurn,
      statusText,
      model: this.getModelSession(sessionId)?.model ?? 'gpt-5.4',
      reasoningEffort: this.getModelSession(sessionId)?.reasoningEffort ?? 'medium',
      estimatedContextTokens,
      contextWindowTokens,
      standardRateContextTokens,
      liveAssistantText,
      liveReasoningSummary,
      thinkingEnabled
    };
  }

  close(): void {
    this.db.close();
  }
}

function mapSession(row: SessionRow): SessionRecord {
  return {
    id: row.id,
    cwd: row.cwd,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at
  };
}

function mapTranscript(row: TranscriptRow): TranscriptEntry {
  return {
    id: row.id,
    sessionId: row.session_id,
    role: row.role,
    text: row.text,
    createdAt: row.created_at
  };
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
    discovered: parseJsonArray(row.discovered_json),
    artifacts: parseJsonArray(row.artifacts_json),
    constraints: parseJsonArray(row.constraints_json),
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
    tags: parseJsonArray(row.tags_json) as ExperimentObservationTag[]
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

function mapAuthToken(row: AuthTokenRow): OpenAICodexAuthRecord {
  return {
    provider: 'openai-codex',
    type: 'oauth',
    accessToken: row.access_token,
    refreshToken: row.refresh_token,
    idToken: row.id_token,
    accountId: row.account_id,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapModelSession(row: ModelSessionRow): ModelSessionRecord {
  return {
    sessionId: row.session_id,
    provider: 'openai-codex',
    model: row.model,
    reasoningEffort: row.reasoning_effort,
    previousResponseId: row.previous_response_id,
    updatedAt: row.updated_at
  };
}

function mapModelHistoryItem(row: ModelHistoryRow): ModelHistoryItem {
  if (row.item_type === 'message') {
    return {
      type: 'message',
      role: row.role ?? 'assistant',
      content: row.content_text ?? ''
    };
  }

  if (row.item_type === 'function_call') {
    return {
      type: 'function_call',
      call_id: row.call_id ?? '',
      name: row.name ?? '',
      arguments: row.arguments_text ?? '{}'
    };
  }

  return {
    type: 'function_call_output',
    call_id: row.call_id ?? '',
    output: row.content_text ?? ''
  };
}

function mapStudyDebt(row: StudyDebtRow): StudyDebtRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    kind: row.kind,
    summary: row.summary,
    whyItMatters: row.why_it_matters,
    affectedPaths: parseNullableJsonArray(row.affected_paths_json),
    recommendedStudy: row.recommended_study,
    openedAt: row.opened_at,
    updatedAt: row.updated_at,
    closedAt: row.closed_at,
    resolution: row.resolution,
    resolutionNote: row.resolution_note
  };
}

function mapSessionCheckpoint(row: SessionCheckpointRow): SessionCheckpointRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    createdAt: row.created_at,
    goal: row.goal,
    completed: row.completed,
    next: row.next,
    openRisks: row.open_risks,
    gitLog: row.git_log,
    gitStatus: row.git_status,
    gitDiffStat: row.git_diff_stat,
    lastTestStatus: row.last_test_status,
    activeExperimentSummaries: parseExperimentSearchResults(row.active_experiments_json),
    checkpointBlock: row.checkpoint_block,
    tailStartHistoryId: row.tail_start_history_id
  };
}

function parseJsonArray(value: string | null): string[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.filter((item): item is string => typeof item === 'string');
  } catch {
    return [];
  }
}

function parseNullableJsonArray(value: string | null): string[] | null {
  if (!value) {
    return null;
  }

  const parsed = parseJsonArray(value);
  return parsed.length > 0 ? parsed : [];
}

function parseExperimentSearchResults(value: string | null): ExperimentSearchResult[] {
  if (!value) {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }

    return parsed.flatMap((item) => {
      if (!item || typeof item !== 'object') {
        return [];
      }

      const candidate = item as Record<string, unknown>;
      const experimentId =
        typeof candidate.experimentId === 'string' ? candidate.experimentId : undefined;
      const hypothesis = typeof candidate.hypothesis === 'string' ? candidate.hypothesis : undefined;
      const status = typeof candidate.status === 'string' ? candidate.status : undefined;
      if (!experimentId || !hypothesis || !status) {
        return [];
      }

      return [
        {
          experimentId,
          hypothesis,
          status: status as ExperimentSearchResult['status'],
          summary: typeof candidate.summary === 'string' ? candidate.summary : '',
          discovered: Array.isArray(candidate.discovered)
            ? candidate.discovered.filter(
                (entry): entry is string => typeof entry === 'string'
              )
            : []
        }
      ];
    });
  } catch {
    return [];
  }
}
