/**
 * 混合检索：FTS5 关键词 + 语义向量。
 * 这是给模型用的主入口 —— 想找「以前说过的偏好/决定/上下文」时先走这里。
 */

import { agentFromSessionPath } from "../lib/env.js";
import { call, config, maintain } from "../lib/runtime.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "local_vector_memory_search_memory_plus";
export const description =
  "用向量+关键词混合检索 HanaAgent 的长期记忆（facts.db）。比原生 search_memory 多了语义召回和打分分解，" +
  "适合查「用户过去说过什么、做过什么决定、有什么偏好」。返回每条命中的 semantic/fts/tag/recency 分解。";

export const parameters = {
  type: "object",
  properties: {
    query: { type: "string", description: "检索问题或关键词" },
    agent: { type: "string", description: "指定 agent id（缺省用当前会话所在的 agent）" },
    limit: { type: "integer", description: "返回条数，缺省用设置里的 defaultLimit" },
    tags: { type: "array", items: { type: "string" }, description: "按标签加分" },
  },
  required: ["query"],
};

export async function execute(input = {}, ctx = {}) {
  const query = String(input.query || "").trim();
  if (!query) return toToolError("query 不能为空");
  const cfg = await config();
  const agent = input.agent || ctx.agentId || agentFromSessionPath(ctx.sessionPath) || null;
  if (!agent) {
    return toToolError("无法确定要查哪个 agent 的记忆库：当前会话没有可识别的 sessionPath，也没传 agent 参数。");
  }
  const limit = Number(input.limit) || Number(cfg.defaultLimit) || 10;

  const result = await call({
    cmd: "search",
    agent,
    query,
    limit,
    tags: Array.isArray(input.tags) ? input.tags : [],
  });
  if (!result.ok) return toToolError(result.error || "检索失败", { agent });

  const hits = result.results || [];
  const lines = hits.map((hit, index) => {
    const flags = `sem=${hit.semanticScore.toFixed(3)} fts=${hit.ftsScore.toFixed(3)} tag=${hit.tagScore.toFixed(2)} rec=${hit.recencyScore.toFixed(2)}`;
    return `${index + 1}. [${hit.score.toFixed(3)}] ${hit.fact}\n     #${hit.id} ${flags} src=${hit.source}`;
  });
  const warnings = (result.warnings || []).map((w) => `- ⚠️ ${w}`).join("\n");
  const text = [
    `agent=${agent} 命中 ${hits.length} 条（候选：关键词 ${result.fts_pool} / 向量池 ${result.vector_pool}）`,
    ...lines,
    warnings,
  ].filter(Boolean).join("\n");

  // 顺手让后台把新写入的记忆补上向量，下一次检索就是全量的。
  void maintain("after-search");

  return toToolResult({ agent, query, hits, warnings: result.warnings || [] }, text);
}
