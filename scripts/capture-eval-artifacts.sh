#!/usr/bin/env bash
set -euo pipefail

if [[ $# -lt 1 ]]; then
  echo "usage: $0 <eval-dir> [--harness-session SESSION_ID] [--codex-thread THREAD_ID]" >&2
  exit 1
fi

EVAL_DIR="$(cd "$1" && pwd)"
shift

HARNESS_SESSION_ID=""
CODEX_THREAD_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --harness-session)
      HARNESS_SESSION_ID="${2:-}"
      shift 2
      ;;
    --codex-thread)
      CODEX_THREAD_ID="${2:-}"
      shift 2
      ;;
    *)
      echo "unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

BASELINE_DIR="${EVAL_DIR}/run-baseline"
HARNESS_DIR="${EVAL_DIR}/run-harness2"
ARTIFACTS_DIR="${EVAL_DIR}/artifacts"
BASELINE_ARTIFACTS="${ARTIFACTS_DIR}/baseline"
HARNESS_ARTIFACTS="${ARTIFACTS_DIR}/harness2"

mkdir -p "${BASELINE_ARTIFACTS}" "${HARNESS_ARTIFACTS}"

capture_git_artifacts() {
  local repo_dir="$1"
  local out_dir="$2"

  git -C "${repo_dir}" rev-parse HEAD > "${out_dir}/head.txt"
  git -C "${repo_dir}" status --short > "${out_dir}/git-status.txt"
  git -C "${repo_dir}" diff --stat > "${out_dir}/diff.stat.txt"
  git -C "${repo_dir}" diff > "${out_dir}/diff.patch"
}

capture_git_artifacts "${BASELINE_DIR}" "${BASELINE_ARTIFACTS}"
capture_git_artifacts "${HARNESS_DIR}" "${HARNESS_ARTIFACTS}"

if [[ -n "${HARNESS_SESSION_ID}" ]]; then
  HARNESS_DB="${HARNESS_DIR}/.h2/notebook.sqlite"
  if [[ -f "${HARNESS_DB}" ]]; then
    sqlite3 -header -column "${HARNESS_DB}" \
      "select role, text, created_at from transcript_entries where session_id='${HARNESS_SESSION_ID}' order by id;" \
      > "${HARNESS_ARTIFACTS}/transcript.txt"
    sqlite3 -header -column "${HARNESS_DB}" \
      "select id, status, kind, summary, why_it_matters, recommended_study, resolution, resolution_note, opened_at, closed_at from study_debts where session_id='${HARNESS_SESSION_ID}' order by rowid;" \
      > "${HARNESS_ARTIFACTS}/questions.txt"
    sqlite3 -header -column "${HARNESS_DB}" \
      "select id, status, study_debt_id, hypothesis, final_verdict, final_summary, created_at, resolved_at from experiments where session_id='${HARNESS_SESSION_ID}' order by rowid;" \
      > "${HARNESS_ARTIFACTS}/experiments.txt"
    printf '%s\n' "${HARNESS_SESSION_ID}" > "${HARNESS_ARTIFACTS}/session-id.txt"
  fi
fi

if [[ -n "${CODEX_THREAD_ID}" ]]; then
  CODEX_ROOT="${HOME}/.codex"
  CODEX_SESSION_FILE="$(find "${CODEX_ROOT}/sessions" -type f -name "*${CODEX_THREAD_ID}.jsonl" | sort | tail -n 1)"
  if [[ -n "${CODEX_SESSION_FILE}" ]]; then
    cp "${CODEX_SESSION_FILE}" "${BASELINE_ARTIFACTS}/codex-session.jsonl"
    printf '%s\n' "${CODEX_THREAD_ID}" > "${BASELINE_ARTIFACTS}/codex-thread-id.txt"
    python3 - "${CODEX_SESSION_FILE}" "${BASELINE_ARTIFACTS}/transcript.txt" <<'PY'
import json
import sys
from pathlib import Path

src = Path(sys.argv[1])
dst = Path(sys.argv[2])

with src.open() as infile, dst.open("w") as out:
    for line in infile:
        obj = json.loads(line)
        if obj.get("type") != "response_item":
            continue
        payload = obj.get("payload", {})
        ptype = payload.get("type")
        if ptype == "message":
            role = payload.get("role", "unknown")
            texts = []
            for content in payload.get("content", []):
                ctype = content.get("type")
                if ctype in {"input_text", "output_text", "text"}:
                    texts.append(content.get("text", ""))
            text = " ".join(part.strip() for part in texts if part.strip())
            if text:
              out.write(f"MESSAGE {role}\n{text}\n---\n")
        elif ptype == "function_call":
            name = payload.get("name", "unknown")
            args = payload.get("arguments", "")
            out.write(f"CALL {name}\n{args}\n---\n")
        elif ptype == "function_call_output":
            output = str(payload.get("output", ""))
            out.write(f"OUTPUT\n{output}\n---\n")
PY
  fi
fi

printf 'Captured artifacts under %s\n' "${ARTIFACTS_DIR}"
