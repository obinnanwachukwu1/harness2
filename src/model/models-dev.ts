export interface ModelsDevResolvedMetadata {
  contextTokens: number;
  inputTokens: number | null;
  outputTokens: number | null;
  hasOver200kPricing: boolean;
}

interface ModelsDevCatalogEntry extends ModelsDevResolvedMetadata {
  id: string;
}

const MODELS_DEV_URL = process.env.H2_MODELS_DEV_URL ?? 'https://models.dev/api.json';
const MODELS_DEV_TTL_MS = 6 * 60 * 60 * 1000;

let cachedCatalog = new Map<string, ModelsDevCatalogEntry>();
let lastLoadedAt = 0;
let inflightLoad: Promise<void> | null = null;

export async function ensureModelsDevCatalog(fetchImpl: typeof fetch): Promise<void> {
  if (!shouldUseModelsDevFetch(fetchImpl)) {
    return;
  }

  if (Date.now() - lastLoadedAt < MODELS_DEV_TTL_MS && cachedCatalog.size > 0) {
    return;
  }

  if (inflightLoad) {
    return inflightLoad;
  }

  inflightLoad = (async () => {
    try {
      const response = await fetchImpl(MODELS_DEV_URL);
      if (!response.ok) {
        throw new Error(`models.dev returned ${response.status}`);
      }

      const payload = await response.json();
      cachedCatalog = parseModelsDevCatalog(payload);
      lastLoadedAt = Date.now();
    } finally {
      inflightLoad = null;
    }
  })();

  return inflightLoad;
}

export function getModelsDevResolvedMetadata(model: string): ModelsDevResolvedMetadata | null {
  const normalized = model.trim().toLowerCase();
  if (!normalized || cachedCatalog.size === 0) {
    return null;
  }

  const direct = cachedCatalog.get(normalized);
  if (direct) {
    return direct;
  }

  const openAiMatch = cachedCatalog.get(`openai/${normalized}`);
  if (openAiMatch) {
    return openAiMatch;
  }

  for (const [id, value] of cachedCatalog.entries()) {
    if (id.endsWith(`/${normalized}`)) {
      return value;
    }
  }

  return null;
}

export function resetModelsDevCatalogForTests(): void {
  cachedCatalog = new Map();
  lastLoadedAt = 0;
  inflightLoad = null;
}

function parseModelsDevCatalog(payload: unknown): Map<string, ModelsDevCatalogEntry> {
  const catalog = new Map<string, ModelsDevCatalogEntry>();
  walkModelsDev(payload, (entry) => {
    const existing = catalog.get(entry.id);
    catalog.set(entry.id, mergeCatalogEntry(existing, entry));
  });
  return catalog;
}

function walkModelsDev(value: unknown, visit: (entry: ModelsDevCatalogEntry) => void): void {
  if (!value || typeof value !== 'object') {
    return;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      walkModelsDev(item, visit);
    }
    return;
  }

  const candidate = toCatalogEntry(value as Record<string, unknown>);
  if (candidate) {
    visit(candidate);
  }

  for (const nested of Object.values(value)) {
    walkModelsDev(nested, visit);
  }
}

function toCatalogEntry(value: Record<string, unknown>): ModelsDevCatalogEntry | null {
  const id = typeof value.id === 'string' ? value.id.trim().toLowerCase() : null;
  const limit = value.limit;
  if (!id || !limit || typeof limit !== 'object' || Array.isArray(limit)) {
    return null;
  }

  const contextTokens = numberOrNull((limit as Record<string, unknown>).context);
  if (!contextTokens || contextTokens <= 0) {
    return null;
  }

  const cost = value.cost;
  const costRecord = cost && typeof cost === 'object' && !Array.isArray(cost) ? (cost as Record<string, unknown>) : null;

  return {
    id,
    contextTokens,
    inputTokens: numberOrNull((limit as Record<string, unknown>).input),
    outputTokens: numberOrNull((limit as Record<string, unknown>).output),
    hasOver200kPricing: Boolean(costRecord?.context_over_200k)
  };
}

function mergeCatalogEntry(
  existing: ModelsDevCatalogEntry | undefined,
  incoming: ModelsDevCatalogEntry
): ModelsDevCatalogEntry {
  if (!existing) {
    return incoming;
  }

  return {
    id: existing.id,
    contextTokens: Math.max(existing.contextTokens, incoming.contextTokens),
    inputTokens: pickPreferredLimit(existing.inputTokens, incoming.inputTokens),
    outputTokens: pickPreferredLimit(existing.outputTokens, incoming.outputTokens),
    hasOver200kPricing: existing.hasOver200kPricing || incoming.hasOver200kPricing
  };
}

function pickPreferredLimit(current: number | null, incoming: number | null): number | null {
  if (incoming === null) {
    return current;
  }
  if (current === null) {
    return incoming;
  }
  return Math.max(current, incoming);
}

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

function shouldUseModelsDevFetch(fetchImpl: typeof fetch): boolean {
  if (process.env.H2_MODELS_DEV_FORCE_FETCH === '1') {
    return true;
  }

  return fetchImpl === fetch;
}