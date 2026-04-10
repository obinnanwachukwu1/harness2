import type { ModelHistoryItem } from '../types.js';
import type { ToolDefinition } from './model-tooling.js';

export function shouldInjectObservationHint(
  requestItems: ModelHistoryItem[],
  toolDefinitions: readonly ToolDefinition[]
): boolean {
  if (!toolDefinitions.some((tool) => tool.name === 'log_observation')) {
    return false;
  }

  const functionCalls = getCurrentTurnFunctionCalls(requestItems);
  const lastObservationIndex = functionCalls.map((item) => item.name).lastIndexOf('log_observation');
  const sinceLastObservation =
    lastObservationIndex === -1 ? functionCalls : functionCalls.slice(lastObservationIndex + 1);

  if (sinceLastObservation.some((item) => item.name === 'resolve_experiment')) {
    return false;
  }

  const substantiveToolCalls = sinceLastObservation.filter(
    (item) => !['log_observation', 'read_experiment'].includes(item.name)
  ).length;

  return substantiveToolCalls >= 4;
}

export function buildObservationHint(): string {
  return 'Harness hint: log one belief-changing observation or blocker before doing much more experiment work.';
}

function getCurrentTurnItems(requestItems: ModelHistoryItem[]): ModelHistoryItem[] {
  for (let index = requestItems.length - 1; index >= 0; index -= 1) {
    const item = requestItems[index];
    if (item?.type === 'message' && item.role === 'user') {
      return requestItems.slice(index + 1);
    }
  }

  return requestItems;
}

function getCurrentTurnFunctionCalls(
  requestItems: ModelHistoryItem[]
): Array<Extract<ModelHistoryItem, { type: 'function_call' }>> {
  return getCurrentTurnItems(requestItems).filter(
    (item): item is Extract<ModelHistoryItem, { type: 'function_call' }> => item.type === 'function_call'
  );
}
