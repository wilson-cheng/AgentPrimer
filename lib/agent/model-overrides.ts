/**
 * lib/agent/model-overrides.ts
 * ---------------------------------------------------------------------------
 * Server-side helpers that resolve effective model length limits by layering
 * user-saved overrides (from the Settings → Advanced section) on top of the
 * pure lookup tables in `lib/model-lengths.ts`.
 *
 * Override storage
 * ---------------
 * Two rows in the `settings` table hold JSON maps keyed by model ID:
 *
 *   model_context_overrides  → { "gpt-4o": 100000, "claude-3-opus": 500000, … }
 *   model_output_overrides   → { "gpt-4o": 8000, … }
 *
 * When a value is present for the requested model it wins over both the
 * provider-fetched value and the built-in lookup table. This lets operators
 * pin a conservative output ceiling for a specific model without affecting
 * any others.
 *
 * Why a separate module?
 * ----------------------
 * `lib/model-lengths.ts` is imported by client-side code
 * (`components/ChatInterface.tsx`) so it must stay free of `better-sqlite3`
 * imports. The DB-backed override logic lives here, server-side only, and is
 * consumed exclusively by the agent loop / finalize / sub-agent paths.
 */
import { getSetting } from '../db';
import { getContextLength, getOutputLength } from '../model-lengths';

/**
 * Parse a JSON override map from the settings table.
 * Returns an empty object on any parse error so a corrupt blob never crashes
 * the agent loop — the caller simply falls through to the lookup table.
 */
function parseOverrideMap(key: string): Record<string, number> {
  const raw = getSetting(key);
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const result: Record<string, number> = {};
      for (const [k, v] of Object.entries(parsed)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          result[k] = v;
        }
      }
      return result;
    }
  } catch {
    // Corrupt JSON — ignore and fall back to lookup table.
  }
  return {};
}

let cachedContextOverrides: Record<string, number> | null = null;
let cachedOutputOverrides: Record<string, number> | null = null;

/**
 * Lazily read & cache the context-length override map.
 *
 * The settings table is read once per server process lifetime (or until
 * `clearModelOverrideCache()` is called). Reads inside the hot agent loop
 * are then just a plain object lookup.
 */
export function getContextOverrides(): Record<string, number> {
  if (cachedContextOverrides === null) {
    cachedContextOverrides = parseOverrideMap('model_context_overrides');
  }
  return cachedContextOverrides;
}

/**
 * Lazily read & cache the output-length override map.
 */
export function getOutputOverrides(): Record<string, number> {
  if (cachedOutputOverrides === null) {
    cachedOutputOverrides = parseOverrideMap('model_output_overrides');
  }
  return cachedOutputOverrides;
}

/**
 * Clear the in-memory override cache.
 *
 * Call this after saving new override values so subsequent agent turns pick
 * up the change without a server restart.
 */
export function clearModelOverrideCache(): void {
  cachedContextOverrides = null;
  cachedOutputOverrides = null;
}

/**
 * Effective output length (max_tokens) for a model.
 *
 * Priority: user override → provider-fetched → lookup table → DEFAULT_OUTPUT_LENGTH.
 */
export function getEffectiveOutputLength(
  modelId: string,
  fetched?: Record<string, number>,
): number {
  const override = getOutputOverrides()[modelId];
  if (override !== undefined) return override;
  return getOutputLength(modelId, fetched);
}

/**
 * Effective context window for a model.
 *
 * Priority: user override → provider-fetched → lookup table → undefined.
 */
export function getEffectiveContextLength(
  modelId: string,
  fetched?: Record<string, number>,
): number | undefined {
  const override = getContextOverrides()[modelId];
  if (override !== undefined) return override;
  return getContextLength(modelId, fetched);
}
