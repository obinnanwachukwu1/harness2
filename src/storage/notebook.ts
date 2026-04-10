import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  AgentMode,
  AskUserKind,
  AskUserRecommendedResponse,
  AskUserResponseKind,
  ApprovePlanResult,
  CompactionArtifactPointer,
  CreatePlanInput,
  EngineSnapshot,
  ExperimentDetails,
  ExperimentObservation,
  ExperimentRecord,
  LiveTurnEvent,
  ExperimentObservationTag,
  ExperimentStatus,
  ExperimentSearchResult,
  ModelHistoryItem,
  ModelMessageRole,
  ModelSessionRecord,
  OpenAICodexAuthRecord,
  PlanDirectCompactionSummary,
  PlanModePhase,
  SessionPlanRecord,
  PendingUserRequest,
  SessionRecord,
  SessionCheckpointRecord,
  StudyDebtKind,
  StudyDebtRecord,
  StudyDebtResolution,
  TodoItem,
  TranscriptEntry,
  TranscriptRole
} from '../types.js';
import { createStudyDebtId, estimateTokens, nowIso } from '../lib/utils.js';
import {
  appendObservation,
  EXPERIMENT_SCHEMA_SQL,
  getExperiment,
  getExperimentDetails,
  listActiveExperimentsForStudyDebt,
  listExperiments,
  listInvalidatedExperimentsForStudyDebt,
  listObservations,
  migrateExperimentTables,
  searchExperimentDetails,
  searchExperimentSummaries,
  upsertExperiment
} from './notebook-experiments.js';

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
  agent_mode: AgentMode;
  plan_mode_phase: PlanModePhase;
}

interface SessionPlanRow {
  session_id: string;
  created_at: string;
  updated_at: string;
  goal: string;
  assumptions_json: string;
  files_json: string;
  steps_json: string;
  validation_json: string;
  risks_json: string;
  options_json: string;
  recommended_option_id: string;
  selected_option_id: string | null;
  plan_path: string;
}

interface SessionTodoRow {
  session_id: string;
  todo_id: string;
  text: string;
  status: TodoItem['status'];
  position: number;
  updated_at: string;
}

interface PendingUserRequestRow {
  session_id: string;
  kind: AskUserKind;
  response_kind: AskUserResponseKind;
  question: string;
  context: string | null;
  options_json: string | null;
  recommended_option_id: string | null;
  recommended_response: AskUserRecommendedResponse;
  reason: string | null;
  created_at: string;
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
  evidence_paths_json: string | null;
  recommended_study: string | null;
  opened_at: string;
  updated_at: string;
  closed_at: string | null;
  resolution: StudyDebtResolution | null;
  resolution_note: string | null;
}

interface StudyDebtProbeBudgetRow {
  question_id: string;
  session_id: string;
  episodes_used: number;
  updated_at: string;
}

interface SessionCheckpointRow {
  id: number;
  session_id: string;
  created_at: string;
  checkpoint_kind: 'study' | 'plan_direct';
  goal: string;
  completed: string;
  next: string;
  open_risks: string | null;
  current_commitments: string | null;
  important_non_goals: string | null;
  git_log: string;
  git_status: string;
  git_diff_stat: string;
  last_test_status: string | null;
  active_experiments_json: string;
  invalidated_experiments_json: string;
  checkpoint_block: string;
  checkpoint_json: string | null;
  artifacts_json: string;
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

      ${EXPERIMENT_SCHEMA_SQL}

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
        updated_at TEXT NOT NULL,
        agent_mode TEXT NOT NULL DEFAULT 'study',
        plan_mode_phase TEXT
      );

      CREATE TABLE IF NOT EXISTS session_plans (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        goal TEXT NOT NULL,
        assumptions_json TEXT NOT NULL,
        files_json TEXT NOT NULL,
        steps_json TEXT NOT NULL,
        validation_json TEXT NOT NULL,
        risks_json TEXT NOT NULL,
        options_json TEXT NOT NULL,
        recommended_option_id TEXT NOT NULL,
        selected_option_id TEXT,
        plan_path TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS session_todos (
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        todo_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL,
        position INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (session_id, todo_id)
      );

      CREATE INDEX IF NOT EXISTS idx_session_todos_session_position
      ON session_todos(session_id, position);

      CREATE TABLE IF NOT EXISTS pending_user_requests (
        session_id TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
        kind TEXT NOT NULL,
        response_kind TEXT NOT NULL,
        question TEXT NOT NULL,
        context TEXT,
        options_json TEXT,
        recommended_option_id TEXT,
        recommended_response TEXT,
        reason TEXT,
        created_at TEXT NOT NULL,
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
        evidence_paths_json TEXT,
        recommended_study TEXT,
        opened_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        closed_at TEXT,
        resolution TEXT,
        resolution_note TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_study_debts_session_status
      ON study_debts(session_id, status, updated_at DESC);

      CREATE TABLE IF NOT EXISTS study_debt_probe_budgets (
        question_id TEXT PRIMARY KEY REFERENCES study_debts(id) ON DELETE CASCADE,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        episodes_used INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_study_debt_probe_budgets_session_id
      ON study_debt_probe_budgets(session_id, updated_at DESC);

      CREATE TABLE IF NOT EXISTS session_checkpoints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        checkpoint_kind TEXT NOT NULL DEFAULT 'study',
        goal TEXT NOT NULL,
        completed TEXT NOT NULL,
        next TEXT NOT NULL,
        open_risks TEXT,
        current_commitments TEXT,
        important_non_goals TEXT,
        git_log TEXT NOT NULL,
        git_status TEXT NOT NULL,
        git_diff_stat TEXT NOT NULL,
        last_test_status TEXT,
        active_experiments_json TEXT NOT NULL,
        invalidated_experiments_json TEXT NOT NULL DEFAULT '[]',
        checkpoint_block TEXT NOT NULL,
        checkpoint_json TEXT,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
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

    if (!modelSessionColumns.some((column) => column.name === 'agent_mode')) {
      this.db.exec(`ALTER TABLE model_sessions ADD COLUMN agent_mode TEXT NOT NULL DEFAULT 'study'`);
    }

    if (!modelSessionColumns.some((column) => column.name === 'plan_mode_phase')) {
      this.db.exec(`ALTER TABLE model_sessions ADD COLUMN plan_mode_phase TEXT`);
    }

    const sessionCheckpointColumns = this.db
      .prepare(`PRAGMA table_info(session_checkpoints)`)
      .all() as unknown as TableInfoRow[];

    if (!sessionCheckpointColumns.some((column) => column.name === 'current_commitments')) {
      this.db.exec(`ALTER TABLE session_checkpoints ADD COLUMN current_commitments TEXT`);
    }

    if (!sessionCheckpointColumns.some((column) => column.name === 'important_non_goals')) {
      this.db.exec(`ALTER TABLE session_checkpoints ADD COLUMN important_non_goals TEXT`);
    }

    if (!sessionCheckpointColumns.some((column) => column.name === 'invalidated_experiments_json')) {
      this.db.exec(
        `ALTER TABLE session_checkpoints ADD COLUMN invalidated_experiments_json TEXT NOT NULL DEFAULT '[]'`
      );
    }
    if (!sessionCheckpointColumns.some((column) => column.name === 'checkpoint_kind')) {
      this.db.exec(
        `ALTER TABLE session_checkpoints ADD COLUMN checkpoint_kind TEXT NOT NULL DEFAULT 'study'`
      );
    }
    if (!sessionCheckpointColumns.some((column) => column.name === 'checkpoint_json')) {
      this.db.exec(`ALTER TABLE session_checkpoints ADD COLUMN checkpoint_json TEXT`);
    }
    if (!sessionCheckpointColumns.some((column) => column.name === 'artifacts_json')) {
      this.db.exec(
        `ALTER TABLE session_checkpoints ADD COLUMN artifacts_json TEXT NOT NULL DEFAULT '[]'`
      );
    }

    migrateExperimentTables(this.db);

    const studyDebtColumns = this.db
      .prepare(`PRAGMA table_info(study_debts)`)
      .all() as unknown as TableInfoRow[];

    if (!studyDebtColumns.some((column) => column.name === 'evidence_paths_json')) {
      this.db.exec(`ALTER TABLE study_debts ADD COLUMN evidence_paths_json TEXT`);
    }

    const pendingUserRequestColumns = this.db
      .prepare(`PRAGMA table_info(pending_user_requests)`)
      .all() as unknown as TableInfoRow[];

    if (!pendingUserRequestColumns.some((column) => column.name === 'options_json')) {
      this.db.exec(`ALTER TABLE pending_user_requests ADD COLUMN options_json TEXT`);
    }

    if (!pendingUserRequestColumns.some((column) => column.name === 'recommended_option_id')) {
      this.db.exec(`ALTER TABLE pending_user_requests ADD COLUMN recommended_option_id TEXT`);
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

  listRecentSessions(limit = 10): SessionRecord[] {
    const rows = this.db
      .prepare(
        `
          SELECT id, cwd, started_at, last_active_at
          FROM sessions
          WHERE id LIKE 'session-%'
          ORDER BY last_active_at DESC
          LIMIT ?
        `
      )
      .all(limit) as unknown as SessionRow[];

    return rows.map(mapSession);
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
    upsertExperiment(this.db, experiment);
    this.touchSession(experiment.sessionId);
  }

  getExperiment(experimentId: string): ExperimentRecord | null {
    return getExperiment(this.db, experimentId);
  }

  listExperiments(sessionId: string): ExperimentRecord[] {
    return listExperiments(this.db, sessionId);
  }

  listInvalidatedExperimentsForStudyDebt(questionId: string): ExperimentRecord[] {
    return listInvalidatedExperimentsForStudyDebt(this.db, questionId);
  }

  listActiveExperimentsForStudyDebt(questionId: string): ExperimentRecord[] {
    return listActiveExperimentsForStudyDebt(this.db, questionId);
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
    return appendObservation(this.db, experimentId, message, tags);
  }

  listObservations(experimentId: string): ExperimentObservation[] {
    return listObservations(this.db, experimentId);
  }

  searchExperimentDetails(sessionId: string, query?: string): ExperimentDetails[] {
    return searchExperimentDetails(this.db, sessionId, query);
  }

  searchExperimentSummaries(sessionId: string, query?: string): ExperimentSearchResult[] {
    return searchExperimentSummaries(this.db, sessionId, query);
  }

  getExperimentDetails(experimentId: string): ExperimentDetails | null {
    return getExperimentDetails(this.db, experimentId);
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
            updated_at,
            agent_mode,
            plan_mode_phase
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            provider = excluded.provider,
            model = excluded.model,
            reasoning_effort = excluded.reasoning_effort,
            previous_response_id = excluded.previous_response_id,
            updated_at = excluded.updated_at,
            agent_mode = excluded.agent_mode,
            plan_mode_phase = excluded.plan_mode_phase
        `
      )
      .run(
        record.sessionId,
        record.provider,
        record.model,
        record.reasoningEffort,
        record.previousResponseId,
        record.updatedAt,
        record.agentMode ?? 'study',
        record.planModePhase ?? null
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
            updated_at,
            agent_mode,
            plan_mode_phase
          FROM model_sessions
          WHERE session_id = ?
        `
      )
      .get(sessionId) as ModelSessionRow | undefined;

    return row ? mapModelSession(row) : null;
  }

  getOrCreateModelSession(
    sessionId: string,
    defaults: { agentMode?: AgentMode; planModePhase?: PlanModePhase } = {}
  ): ModelSessionRecord {
    const existing = this.getModelSession(sessionId);
    if (existing) {
      return existing;
    }

    const record: ModelSessionRecord = {
      sessionId,
      provider: 'openai-codex',
      model: 'gpt-5.4',
      reasoningEffort: 'medium',
      previousResponseId: null,
      updatedAt: nowIso(),
      agentMode: defaults.agentMode ?? 'study',
      planModePhase:
        defaults.planModePhase ?? (defaults.agentMode === 'plan' ? 'planning' : null)
    };
    this.upsertModelSession(record);
    return record;
  }

  setPlanModePhase(sessionId: string, phase: PlanModePhase): ModelSessionRecord {
    const current = this.getOrCreateModelSession(sessionId);
    const next: ModelSessionRecord = {
      ...current,
      planModePhase: phase,
      updatedAt: nowIso()
    };
    this.upsertModelSession(next);
    return next;
  }

  saveSessionPlan(input: {
    sessionId: string;
    goal: string;
    assumptions: string[];
    files: string[];
    steps: string[];
    validation: string[];
    risks: string[];
    planPath: string;
  }): SessionPlanRecord {
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO session_plans (
            session_id,
            created_at,
            updated_at,
            goal,
            assumptions_json,
            files_json,
            steps_json,
            validation_json,
            risks_json,
            options_json,
            recommended_option_id,
            selected_option_id,
            plan_path
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            updated_at = excluded.updated_at,
            goal = excluded.goal,
            assumptions_json = excluded.assumptions_json,
            files_json = excluded.files_json,
            steps_json = excluded.steps_json,
            validation_json = excluded.validation_json,
            risks_json = excluded.risks_json,
            options_json = excluded.options_json,
            recommended_option_id = excluded.recommended_option_id,
            selected_option_id = excluded.selected_option_id,
            plan_path = excluded.plan_path
        `
      )
      .run(
        input.sessionId,
        timestamp,
        timestamp,
        input.goal,
        JSON.stringify(input.assumptions),
        JSON.stringify(input.files),
        JSON.stringify(input.steps),
        JSON.stringify(input.validation),
        JSON.stringify(input.risks),
        JSON.stringify([]),
        '',
        null,
        input.planPath
      );
    this.touchSession(input.sessionId);
    return this.getSessionPlan(input.sessionId) as SessionPlanRecord;
  }

  getSessionPlan(sessionId: string): SessionPlanRecord | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id,
            created_at,
            updated_at,
            goal,
            assumptions_json,
            files_json,
            steps_json,
            validation_json,
            risks_json,
            options_json,
            recommended_option_id,
            selected_option_id,
            plan_path
          FROM session_plans
          WHERE session_id = ?
        `
      )
      .get(sessionId) as SessionPlanRow | undefined;

    return row ? mapSessionPlan(row) : null;
  }

  savePendingUserRequest(input: {
    sessionId: string;
    kind: AskUserKind;
    responseKind: AskUserResponseKind;
    question: string;
    context?: string | null;
    options?: PendingUserRequest['options'];
    recommendedOptionId?: string | null;
    recommendedResponse?: AskUserRecommendedResponse;
    reason?: string | null;
  }): PendingUserRequest {
    const existing = this.getPendingUserRequest(input.sessionId);
    const timestamp = nowIso();
    const createdAt = existing?.createdAt ?? timestamp;
    this.db
      .prepare(
        `
          INSERT INTO pending_user_requests (
            session_id,
            kind,
            response_kind,
            question,
            context,
            options_json,
            recommended_option_id,
            recommended_response,
            reason,
            created_at,
            updated_at
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            kind = excluded.kind,
            response_kind = excluded.response_kind,
            question = excluded.question,
            context = excluded.context,
            options_json = excluded.options_json,
            recommended_option_id = excluded.recommended_option_id,
            recommended_response = excluded.recommended_response,
            reason = excluded.reason,
            updated_at = excluded.updated_at
        `
      )
      .run(
        input.sessionId,
        input.kind,
        input.responseKind,
        input.question.trim(),
        input.context?.trim() || null,
        input.options ? JSON.stringify(input.options) : null,
        input.recommendedOptionId ?? null,
        input.recommendedResponse ?? null,
        input.reason?.trim() || null,
        createdAt,
        timestamp
      );
    this.touchSession(input.sessionId);
    return this.getPendingUserRequest(input.sessionId) as PendingUserRequest;
  }

  getPendingUserRequest(sessionId: string): PendingUserRequest | null {
    const row = this.db
      .prepare(
        `
          SELECT
            session_id,
            kind,
            response_kind,
            question,
            context,
            options_json,
            recommended_option_id,
            recommended_response,
            reason,
            created_at,
            updated_at
          FROM pending_user_requests
          WHERE session_id = ?
        `
      )
      .get(sessionId) as PendingUserRequestRow | undefined;

    return row ? mapPendingUserRequest(row) : null;
  }

  clearPendingUserRequest(sessionId: string): void {
    this.db
      .prepare(
        `
          DELETE FROM pending_user_requests
          WHERE session_id = ?
        `
      )
      .run(sessionId);
    this.touchSession(sessionId);
  }

  approveSessionPlan(sessionId: string): SessionPlanRecord {
    const plan = this.getSessionPlan(sessionId);
    if (!plan) {
      throw new Error(`No session plan exists for ${sessionId}.`);
    }
    this.db
      .prepare(
        `
          UPDATE session_plans
          SET updated_at = ?
          WHERE session_id = ?
        `
      )
      .run(nowIso(), sessionId);
    this.touchSession(sessionId);
    return this.getSessionPlan(sessionId) as SessionPlanRecord;
  }

  replaceSessionTodos(sessionId: string, items: TodoItem[]): TodoItem[] {
    const timestamp = nowIso();
    const deleteStatement = this.db.prepare(
      `
        DELETE FROM session_todos
        WHERE session_id = ?
      `
    );
    const insertStatement = this.db.prepare(
      `
        INSERT INTO session_todos (
          session_id,
          todo_id,
          text,
          status,
          position,
          updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?)
      `
    );

    deleteStatement.run(sessionId);
    for (const item of items) {
      insertStatement.run(sessionId, item.id, item.text, item.status, item.position, timestamp);
    }

    this.touchSession(sessionId);
    return this.listSessionTodos(sessionId);
  }

  listSessionTodos(sessionId: string): TodoItem[] {
    const rows = this.db
      .prepare(
        `
          SELECT session_id, todo_id, text, status, position, updated_at
          FROM session_todos
          WHERE session_id = ?
          ORDER BY position ASC, todo_id ASC
        `
      )
      .all(sessionId) as unknown as SessionTodoRow[];

    return rows.map(mapTodoItem);
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

    return row ? this.normalizeTailStartHistoryId(sessionId, row.id) : null;
  }

  getTailStartHistoryIdByTokenBudget(sessionId: string, tailTokenBudget: number): number | null {
    if (tailTokenBudget < 1) {
      return null;
    }

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

    let total = 0;
    let tailStartId: number | null = null;
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!;
      const item = mapModelHistoryItem(row);
      const itemTokens = estimateModelHistoryItemTokens(item);
      if (tailStartId !== null && total + itemTokens > tailTokenBudget) {
        break;
      }
      total += itemTokens;
      tailStartId = row.id;
    }

    return this.normalizeTailStartHistoryId(sessionId, tailStartId);
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

  listModelHistoryRange(
    sessionId: string,
    input: { startIdInclusive?: number | null; endIdExclusive?: number | null } = {}
  ): ModelHistoryItem[] {
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
            AND (? IS NULL OR id >= ?)
            AND (? IS NULL OR id < ?)
          ORDER BY id ASC
        `
      )
      .all(
        sessionId,
        input.startIdInclusive ?? null,
        input.startIdInclusive ?? null,
        input.endIdExclusive ?? null,
        input.endIdExclusive ?? null
      ) as unknown as ModelHistoryRow[];

    return rows.map(mapModelHistoryItem);
  }

  openStudyDebt(input: {
    sessionId: string;
    summary: string;
    whyItMatters: string;
    kind?: StudyDebtKind;
    affectedPaths?: string[];
    evidencePaths?: string[];
    recommendedStudy?: string;
  }): StudyDebtRecord {
    const timestamp = nowIso();
    const id = createStudyDebtId();
    const affectedPaths =
      input.affectedPaths && input.affectedPaths.length > 0
        ? input.affectedPaths.map((item) => item.trim()).filter(Boolean)
        : null;
    const evidencePaths =
      input.evidencePaths && input.evidencePaths.length > 0
        ? input.evidencePaths.map((item) => item.trim()).filter(Boolean)
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
            evidence_paths_json,
            recommended_study,
            opened_at,
            updated_at,
            closed_at,
            resolution,
            resolution_note
          )
          VALUES (?, ?, 'open', ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL)
        `
      )
      .run(
        id,
        input.sessionId,
        input.kind ?? 'runtime',
        input.summary.trim(),
        input.whyItMatters.trim(),
        affectedPaths ? JSON.stringify(affectedPaths) : null,
        evidencePaths ? JSON.stringify(evidencePaths) : null,
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

    const activeExperiments = this.listActiveExperimentsForStudyDebt(existing.id);
    if (activeExperiments.length > 0) {
      throw new Error(
        [
          `Question ${input.questionId} still has an active linked experiment ${activeExperiments
            .map((experiment) => experiment.id)
            .join(', ')}.`,
          'Wait for that experiment to resolve, or explicitly cancel/close it before resolving the question.'
        ].join('\n')
      );
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

  getStudyDebtProbeEpisodeCount(questionId: string): number {
    const row = this.db
      .prepare(
        `
          SELECT question_id, session_id, episodes_used, updated_at
          FROM study_debt_probe_budgets
          WHERE question_id = ?
        `
      )
      .get(questionId) as StudyDebtProbeBudgetRow | undefined;
    return row?.episodes_used ?? 0;
  }

  incrementStudyDebtProbeEpisodeCount(questionId: string): number {
    const existing = this.getStudyDebt(questionId);
    if (!existing) {
      throw new Error(`Unknown question: ${questionId}`);
    }
    const timestamp = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO study_debt_probe_budgets (
            question_id,
            session_id,
            episodes_used,
            updated_at
          )
          VALUES (?, ?, 1, ?)
          ON CONFLICT(question_id) DO UPDATE SET
            episodes_used = episodes_used + 1,
            updated_at = excluded.updated_at
        `
      )
      .run(questionId, existing.sessionId, timestamp);
    this.touchSession(existing.sessionId);
    return this.getStudyDebtProbeEpisodeCount(questionId);
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
            evidence_paths_json,
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
            evidence_paths_json,
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
            evidence_paths_json,
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
    if (!checkpoint) {
      return this.listModelHistory(sessionId);
    }

    const normalizedTailStartHistoryId = this.normalizeTailStartHistoryId(
      sessionId,
      checkpoint.tailStartHistoryId
    );

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
        normalizedTailStartHistoryId,
        normalizedTailStartHistoryId
      ) as unknown as ModelHistoryRow[];

    return [
      {
        type: 'message',
        role: 'developer',
        content: checkpoint.checkpointBlock
      },
      ...tailRows.map(mapModelHistoryItem)
    ];
  }

  createSessionCheckpoint(input: {
    sessionId: string;
    checkpointKind?: 'study' | 'plan_direct';
    goal: string;
    completed: string;
    next: string;
    openRisks?: string;
    currentCommitments?: string;
    importantNonGoals?: string;
    gitLog: string;
    gitStatus: string;
    gitDiffStat: string;
    lastTestStatus?: string | null;
    activeExperimentSummaries: ExperimentSearchResult[];
    invalidatedExperimentSummaries: ExperimentSearchResult[];
    checkpointBlock: string;
    checkpointSummary?: PlanDirectCompactionSummary | null;
    artifacts?: CompactionArtifactPointer[];
    tailStartHistoryId: number | null;
  }): SessionCheckpointRecord {
    const createdAt = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO session_checkpoints (
            session_id,
            created_at,
            checkpoint_kind,
            goal,
            completed,
            next,
            open_risks,
            current_commitments,
            important_non_goals,
            git_log,
            git_status,
            git_diff_stat,
            last_test_status,
            active_experiments_json,
            invalidated_experiments_json,
            checkpoint_block,
            checkpoint_json,
            artifacts_json,
            tail_start_history_id
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        input.sessionId,
        createdAt,
        input.checkpointKind ?? 'study',
        input.goal,
        input.completed,
        input.next,
        input.openRisks ?? null,
        input.currentCommitments ?? null,
        input.importantNonGoals ?? null,
        input.gitLog,
        input.gitStatus,
        input.gitDiffStat,
        input.lastTestStatus ?? null,
        JSON.stringify(input.activeExperimentSummaries),
        JSON.stringify(input.invalidatedExperimentSummaries),
        input.checkpointBlock,
        input.checkpointSummary ? JSON.stringify(input.checkpointSummary) : null,
        JSON.stringify(input.artifacts ?? []),
        input.tailStartHistoryId
      );

    const row = this.db
      .prepare(
        `
          SELECT
            id,
            session_id,
            created_at,
            checkpoint_kind,
            goal,
            completed,
            next,
            open_risks,
            current_commitments,
            important_non_goals,
            git_log,
            git_status,
            git_diff_stat,
            last_test_status,
            active_experiments_json,
            invalidated_experiments_json,
            checkpoint_block,
            checkpoint_json,
            artifacts_json,
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
            checkpoint_kind,
            goal,
            completed,
            next,
            open_risks,
            current_commitments,
            important_non_goals,
            git_log,
            git_status,
            git_diff_stat,
            last_test_status,
            active_experiments_json,
            invalidated_experiments_json,
            checkpoint_block,
            checkpoint_json,
            artifacts_json,
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
    currentTurnStartedAt: string | null,
    statusText: string,
    estimatedContextTokens = 0,
    contextWindowTokens = 0,
    standardRateContextTokens: number | null = null,
    liveTurnEvents: LiveTurnEvent[] = [],
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
      studyDebts: this.listStudyDebts(sessionId),
      activePlan: this.getSessionPlan(sessionId),
      pendingUserRequest: this.getPendingUserRequest(sessionId),
      todos: this.listSessionTodos(sessionId),
      processingTurn,
      currentTurnStartedAt,
      statusText,
      model: this.getModelSession(sessionId)?.model ?? 'gpt-5.4',
      reasoningEffort: this.getModelSession(sessionId)?.reasoningEffort ?? 'medium',
      agentMode: this.getModelSession(sessionId)?.agentMode ?? 'study',
      planModePhase: this.getModelSession(sessionId)?.planModePhase ?? null,
      estimatedContextTokens,
      contextWindowTokens,
      standardRateContextTokens,
      liveTurnEvents,
      thinkingEnabled
    };
  }

  close(): void {
    this.db.close();
  }

  private normalizeTailStartHistoryId(sessionId: string, candidateId: number | null): number | null {
    if (candidateId === null) {
      return null;
    }

    let normalizedId = candidateId;
    for (;;) {
      const row = this.db
        .prepare(
          `
            SELECT id, item_type, call_id
            FROM model_history_items
            WHERE session_id = ?
              AND id = ?
          `
        )
        .get(sessionId, normalizedId) as
        | { id: number; item_type: string; call_id: string | null }
        | undefined;

      if (!row || row.item_type !== 'function_call_output' || !row.call_id) {
        return normalizedId;
      }

      const matchingCall = this.db
        .prepare(
          `
            SELECT id
            FROM model_history_items
            WHERE session_id = ?
              AND item_type = 'function_call'
              AND call_id = ?
              AND id < ?
            ORDER BY id DESC
            LIMIT 1
          `
        )
        .get(sessionId, row.call_id, row.id) as { id: number } | undefined;

      if (!matchingCall || matchingCall.id === normalizedId) {
        return normalizedId;
      }

      normalizedId = matchingCall.id;
    }
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
    updatedAt: row.updated_at,
    agentMode: row.agent_mode ?? 'study',
    planModePhase: row.plan_mode_phase ?? null
  };
}

function mapSessionPlan(row: SessionPlanRow): SessionPlanRecord {
  return {
    sessionId: row.session_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    goal: row.goal,
    assumptions: parseJsonStringArray(row.assumptions_json, 'session_plans.assumptions_json'),
    files: parseJsonStringArray(row.files_json, 'session_plans.files_json'),
    steps: parseJsonStringArray(row.steps_json, 'session_plans.steps_json'),
    validation: parseJsonStringArray(row.validation_json, 'session_plans.validation_json'),
    risks: parseJsonStringArray(row.risks_json, 'session_plans.risks_json'),
    planPath: row.plan_path
  };
}

function mapPendingUserRequest(row: PendingUserRequestRow): PendingUserRequest {
  return {
    sessionId: row.session_id,
    kind: row.kind,
    responseKind: row.response_kind,
    question: row.question,
    context: row.context,
    options: parseNullableAskUserOptions(row.options_json, 'pending_user_requests.options_json'),
    recommendedOptionId: row.recommended_option_id,
    recommendedResponse: row.recommended_response,
    reason: row.reason,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  };
}

function mapTodoItem(row: SessionTodoRow): TodoItem {
  return {
    id: row.todo_id,
    text: row.text,
    status: row.status,
    position: row.position
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
    affectedPaths: parseNullableJsonArray(row.affected_paths_json, 'study_debts.affected_paths_json'),
    evidencePaths: parseNullableJsonArray(row.evidence_paths_json, 'study_debts.evidence_paths_json'),
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
    checkpointKind: row.checkpoint_kind ?? 'study',
    goal: row.goal,
    completed: row.completed,
    next: row.next,
    openRisks: row.open_risks,
    currentCommitments: row.current_commitments,
    importantNonGoals: row.important_non_goals,
    gitLog: row.git_log,
    gitStatus: row.git_status,
    gitDiffStat: row.git_diff_stat,
    lastTestStatus: row.last_test_status,
    activeExperimentSummaries: parseExperimentSearchResults(
      row.active_experiments_json,
      'session_checkpoints.active_experiments_json'
    ),
    invalidatedExperimentSummaries: parseExperimentSearchResults(
      row.invalidated_experiments_json,
      'session_checkpoints.invalidated_experiments_json'
    ),
    checkpointBlock: row.checkpoint_block,
    checkpointSummary: parseNullablePlanDirectCheckpoint(
      row.checkpoint_json,
      'session_checkpoints.checkpoint_json'
    ),
    artifacts: parseCompactionArtifactPointers(
      row.artifacts_json,
      'session_checkpoints.artifacts_json'
    ),
    tailStartHistoryId: row.tail_start_history_id
  };
}

function parseNullablePlanDirectCheckpoint(
  value: string | null,
  field: string
): PlanDirectCompactionSummary | null {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}: ${String(error)}`);
  }

  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid checkpoint summary stored in ${field}.`);
  }

  return parsed as PlanDirectCompactionSummary;
}

function parseCompactionArtifactPointers(
  value: string | null,
  field: string
): CompactionArtifactPointer[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}: ${String(error)}`);
  }

  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (item) =>
        !item ||
        typeof item !== 'object' ||
        typeof (item as { path?: unknown }).path !== 'string' ||
        typeof (item as { why?: unknown }).why !== 'string'
    )
  ) {
    throw new Error(`Invalid compaction artifact pointers stored in ${field}.`);
  }

  return parsed as CompactionArtifactPointer[];
}

function estimateModelHistoryItemTokens(item: ModelHistoryItem): number {
  if (item.type === 'message') {
    return estimateTokens(item.content);
  }

  if (item.type === 'function_call') {
    return estimateTokens(item.name) + estimateTokens(item.arguments);
  }

  return estimateTokens(item.output);
}

function parseJsonStringArray(value: string | null, field: string): string[] {
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

function parseNullableJsonArray(value: string | null, field: string): string[] | null {
  if (!value) {
    return null;
  }

  const parsed = parseJsonStringArray(value, field);
  return parsed.length > 0 ? parsed : [];
}

function parseNullableAskUserOptions(
  value: string | null,
  field: string
): PendingUserRequest['options'] {
  if (!value) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Expected ${field} to be a JSON array.`);
  }

  return parsed.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Expected ${field}[${index}] to be an object.`);
    }
    const option = item as Record<string, unknown>;
    if (
      typeof option.id !== 'string' ||
      typeof option.label !== 'string' ||
      typeof option.description !== 'string'
    ) {
      throw new Error(`Expected ${field}[${index}] to match AskUserOption.`);
    }
    return {
      id: option.id,
      label: option.label,
      description: option.description
    };
  });
}

function parseExperimentSearchResults(value: string | null, field: string): ExperimentSearchResult[] {
  if (!value) {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid JSON stored in ${field}: ${String(error)}`);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(`Invalid experiment summary array stored in ${field}.`);
  }

  return parsed.map((item) => {
    if (!item || typeof item !== 'object') {
      throw new Error(`Invalid experiment summary entry stored in ${field}.`);
    }

    const candidate = item as Record<string, unknown>;
    if (
      typeof candidate.experimentId !== 'string' ||
      typeof candidate.hypothesis !== 'string' ||
      typeof candidate.status !== 'string'
    ) {
      throw new Error(`Invalid experiment summary entry stored in ${field}.`);
    }

    return {
      experimentId: candidate.experimentId,
      hypothesis: candidate.hypothesis,
      status: candidate.status as ExperimentSearchResult['status'],
      summary: typeof candidate.summary === 'string' ? candidate.summary : '',
      discovered: Array.isArray(candidate.discovered)
        ? candidate.discovered.filter((entry): entry is string => typeof entry === 'string')
        : []
    };
  });
}
