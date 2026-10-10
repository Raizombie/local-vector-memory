/**
 * routes/settings.js —— 设置页/卡片的后端。
 *
 * 路径映射：这里的 "/status" → GET /api/apps/local-vector-memory/routes/status
 * （页面侧用 hana.api.fetch("/status") 即可，SDK 会补前缀）
 */

import { call, config, init, maintain, snapshot } from "../lib/runtime.js";
import { reschedule } from "../lib/scheduler.js";
import { resetPythonCache } from "../lib/worker.js";

const ALLOWED_KEYS = new Set([
  "embeddingBaseUrl",
  "embeddingApiKey",
  "embeddingModel",
  "dimensions",
  "pythonCommand",
  "autoMaintain",
  "eventDriven",
  "maintainIntervalMs",
  "batchSize",
  "ftsCandidates",
  "vectorCandidates",
  "defaultLimit",
  "fusion",
]);

export default function registerVectorMemoryRoutes(app, ctx) {
  init(ctx, ctx);

  app.get("/status", async (c) => {
    const cfg = await config({ fresh: true });
    const agents = await call({ cmd: "agents" }, { timeoutMs: 60000 });
    return c.json({
      ok: true,
      config: cfg,
      runtime: snapshot(),
      agents: agents.ok ? agents.agents : [],
      error: agents.ok ? null : agents.error,
    });
  });

  app.post("/maintain", async (c) => {
    const body = await readJson(c);
    const limit = Number(body.limit) || 500;
    if (body.agent) {
      const result = await call({ cmd: "backfill", agent: String(body.agent), limit }, { timeoutMs: 600000 });
      return c.json({ ok: result.ok, result, error: result.ok ? null : result.error });
    }
    const result = await maintain("ui:backfill", { limit, force: true });
    return c.json({ ok: Boolean(result.ok), result, error: result.error || null });
  });

  app.post("/probe", async (c) => {
    const result = await call({ cmd: "probe" }, { timeoutMs: 120000 });
    return c.json({ ok: result.ok, probe: result, error: result.ok ? null : result.error });
  });

  app.post("/search", async (c) => {
    const body = await readJson(c);
    const query = String(body.query || "").trim();
    const agent = String(body.agent || "").trim();
    if (!query || !agent) return c.json({ ok: false, error: "query 与 agent 都必填" }, 400);
    const cfg = await config();
    const result = await call({
      cmd: "search",
      agent,
      query,
      limit: Number(body.limit) || Number(cfg.defaultLimit) || 10,
      tags: Array.isArray(body.tags) ? body.tags : [],
    }, { timeoutMs: 120000 });
    return c.json({ ok: result.ok, results: result.results || [], warnings: result.warnings || [], error: result.ok ? null : result.error });
  });

  app.post("/config", async (c) => {
    const body = await readJson(c);
    const patch = {};
    for (const [key, value] of Object.entries(body.patch || body || {})) {
      if (!ALLOWED_KEYS.has(key)) continue;
      if (value === undefined || value === null) continue;
      patch[key] = value;
    }
    if (!Object.keys(patch).length) return c.json({ ok: false, error: "没有可写入的合法设置项" }, 400);
    try {
      await Promise.resolve(ctx.config.setMany(patch));
    } catch (error) {
      return c.json({ ok: false, error: `写入设置失败：${error?.message || error}` }, 400);
    }
    if (patch.pythonCommand) resetPythonCache();
    await reschedule();
    return c.json({ ok: true, patch, config: await config({ fresh: true }), runtime: snapshot() });
  });

  app.post("/python", async (c) => {
    // 排查用：清掉缓存重新探一遍解释器
    resetPythonCache();
    const agents = await call({ cmd: "ping" }, { timeoutMs: 30000, forcePython: true });
    return c.json({ ok: agents.ok, ping: agents, runtime: snapshot() });
  });
}

async function readJson(c) {
  try {
    return (await c.req.json()) || {};
  } catch {
    return {};
  }
}
