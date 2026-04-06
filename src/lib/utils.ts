import { randomUUID } from 'node:crypto';

export function nowIso(): string {
  return new Date().toISOString();
}

export function createSessionId(): string {
  return `session-${randomUUID().slice(0, 8)}`;
}

export function createExperimentId(): string {
  return `exp-${randomUUID().slice(0, 8)}`;
}

export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export function clampText(text: string, limit = 4000): string {
  if (text.length <= limit) {
    return text;
  }

  return `${text.slice(0, limit)}\n...[truncated ${text.length - limit} chars]`;
}

export function lines(text: string): string[] {
  return text.split(/\r?\n/).filter(Boolean);
}
