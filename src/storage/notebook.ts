import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type {
  EngineSnapshot,
  ExperimentDetails,
  ExperimentObservation,
  ExperimentRecord,
  SessionRecord,
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
  hypothesis: string;
  command: string;
  context: string;
  base_commit_sha: string;
  branch_name: string;
  worktree_path: string;
  status: ExperimentRecord['status'];
  budget: number;
  tokens_used: number;
  preserve: number;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  final_verdict: ExperimentRecord['finalVerdict'];
  final_summary: string | null;
}

interface ObservationRow {
  id: number;
  experiment_id: string;
  message: string;
  created_at: string;
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
        hypothesis TEXT NOT NULL,
        command TEXT NOT NULL,
        context TEXT NOT NULL,
        base_commit_sha TEXT NOT NULL,
        branch_name TEXT NOT NULL,
        worktree_path TEXT NOT NULL,
        status TEXT NOT NULL,
        budget INTEGER NOT NULL,
        tokens_used INTEGER NOT NULL,
        preserve INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        final_verdict TEXT,
        final_summary TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_experiments_session_created_at
      ON experiments(session_id, created_at);

      CREATE TABLE IF NOT EXISTS experiment_observations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        experiment_id TEXT NOT NULL REFERENCES experiments(id) ON DELETE CASCADE,
        message TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_experiment_observations_experiment_created_at
      ON experiment_observations(experiment_id, created_at);
    `);
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
            hypothesis,
            command,
            context,
            base_commit_sha,
            branch_name,
            worktree_path,
            status,
            budget,
            tokens_used,
            preserve,
            created_at,
            updated_at,
            resolved_at,
            final_verdict,
            final_summary
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(id) DO UPDATE SET
            session_id = excluded.session_id,
            hypothesis = excluded.hypothesis,
            command = excluded.command,
            context = excluded.context,
            base_commit_sha = excluded.base_commit_sha,
            branch_name = excluded.branch_name,
            worktree_path = excluded.worktree_path,
            status = excluded.status,
            budget = excluded.budget,
            tokens_used = excluded.tokens_used,
            preserve = excluded.preserve,
            created_at = excluded.created_at,
            updated_at = excluded.updated_at,
            resolved_at = excluded.resolved_at,
            final_verdict = excluded.final_verdict,
            final_summary = excluded.final_summary
        `
      )
      .run(
        experiment.id,
        experiment.sessionId,
        experiment.hypothesis,
        experiment.command,
        experiment.context,
        experiment.baseCommitSha,
        experiment.branchName,
        experiment.worktreePath,
        experiment.status,
        experiment.budget,
        experiment.tokensUsed,
        experiment.preserve ? 1 : 0,
        experiment.createdAt,
        experiment.updatedAt,
        experiment.resolvedAt,
        experiment.finalVerdict,
        experiment.finalSummary
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
            hypothesis,
            command,
            context,
            base_commit_sha,
            branch_name,
            worktree_path,
            status,
            budget,
            tokens_used,
            preserve,
            created_at,
            updated_at,
            resolved_at,
            final_verdict,
            final_summary
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
            hypothesis,
            command,
            context,
            base_commit_sha,
            branch_name,
            worktree_path,
            status,
            budget,
            tokens_used,
            preserve,
            created_at,
            updated_at,
            resolved_at,
            final_verdict,
            final_summary
          FROM experiments
          WHERE session_id = ?
          ORDER BY created_at DESC
        `
      )
      .all(sessionId) as unknown as ExperimentRow[];

    return rows.map(mapExperiment);
  }

  appendObservation(experimentId: string, message: string): ExperimentObservation {
    const createdAt = nowIso();
    this.db
      .prepare(
        `
          INSERT INTO experiment_observations (experiment_id, message, created_at)
          VALUES (?, ?, ?)
        `
      )
      .run(experimentId, message, createdAt);

    const row = this.db
      .prepare(
        `
          SELECT id, experiment_id, message, created_at
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
          FROM experiment_observations
          WHERE experiment_id = ?
          ORDER BY id ASC
        `
      )
      .all(experimentId) as unknown as ObservationRow[];

    return rows.map(mapObservation);
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

  getSnapshot(
    sessionId: string,
    processingTurn: boolean,
    statusText: string
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
      statusText
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
    hypothesis: row.hypothesis,
    command: row.command,
    context: row.context,
    baseCommitSha: row.base_commit_sha,
    branchName: row.branch_name,
    worktreePath: row.worktree_path,
    status: row.status,
    budget: row.budget,
    tokensUsed: row.tokens_used,
    preserve: Boolean(row.preserve),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    finalVerdict: row.final_verdict,
    finalSummary: row.final_summary
  };
}

function mapObservation(row: ObservationRow): ExperimentObservation {
  return {
    id: row.id,
    experimentId: row.experiment_id,
    message: row.message,
    createdAt: row.created_at
  };
}
