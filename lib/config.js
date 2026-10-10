/**
 * lib/config.js —— 设置读取与 worker 参数翻译。
 *
 * 设置项一律走 sdk.config（manifest 的 contributes.settings.schema 声明），
 * 这里只负责补默认值、做类型收敛，再翻译成 worker 认识的 snake_case。
 */

export const DEFAULTS = {
  embeddingBaseUrl: "http://127.0.0.1:1234/v1",
  embeddingApiKey: "",
  embeddingModel: "text-embedding-nomic-embed-text-v1.5@q8_0",
  dimensions: 768,
  pythonCommand: "python",
  autoMaintain: true,
  eventDriven: true,
  maintainIntervalMs: 60000,
  batchSize: 32,
  ftsCandidates: 200,
  vectorCandidates: 80,
  defaultLimit: 10,
  fusion: "minmax",
};

const NUMERIC = new Set([
  "dimensions",
  "maintainIntervalMs",
  "batchSize",
  "ftsCandidates",
  "vectorCandidates",
  "defaultLimit",
]);

function toBool(value, fallback) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") return !["false", "0", "no", "off", ""].includes(value.toLowerCase());
  if (value === undefined || value === null) return fallback;
  return Boolean(value);
}

export function normalizeConfig(raw) {
  const out = { ...DEFAULTS };
  for (const key of Object.keys(DEFAULTS)) {
    const value = raw ? raw[key] : undefined;
    if (value === undefined || value === null || value === "") continue;
    if (key === "autoMaintain") out[key] = toBool(value, DEFAULTS[key]);
    else if (key === "eventDriven") out[key] = toBool(value, DEFAULTS[key]);
    else if (NUMERIC.has(key)) {
      const num = Number(value);
      if (Number.isFinite(num)) out[key] = num;
    } else out[key] = String(value);
  }
  return out;
}

export async function readConfig(sdk) {
  let raw = {};
  try {
    raw = (await sdk.config.getAll()) || {};
  } catch {
    raw = {};
  }
  return normalizeConfig(raw);
}

/** worker 侧参数（snake_case，与 python/vector_memory.py 对齐）。 */
export function workerConfig(config) {
  return {
    base_url: config.embeddingBaseUrl,
    api_key: config.embeddingApiKey,
    model: config.embeddingModel,
    dims: Number(config.dimensions) || 0,
    batch_size: Number(config.batchSize) || 32,
    fts_candidates: Number(config.ftsCandidates) || 200,
    vector_candidates: Number(config.vectorCandidates) || 80,
    default_limit: Number(config.defaultLimit) || 10,
    fusion: String(config.fusion || "minmax"),
    timeout_ms: 30000,
  };
}
