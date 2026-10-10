/**
 * 手动补嵌入。缺省把所有 agent 都扫一遍，也可以指定单个 agent。
 * 换嵌入模型后也用它：旧模型的向量会被识别成 stale 并重新嵌入。
 */

import { call, maintain, snapshot } from "../lib/runtime.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "local_vector_memory_memory_vector_backfill";
export const description =
  "为 HanaAgent 记忆库补齐向量索引。缺省扫描全部 agent，把「没有向量」和「属于旧嵌入模型」的条目重新嵌入。" +
  "换过嵌入模型、或怀疑语义检索看不到新记忆时用它。";

export const parameters = {
  type: "object",
  properties: {
    agent: { type: "string", description: "只补某个 agent（缺省全部）" },
    limit: { type: "integer", description: "本次最多处理多少条，缺省 500" },
  },
};

export async function execute(input = {}) {
  const limit = Number(input.limit) || 500;
  const agent = input.agent ? String(input.agent) : null;

  if (agent) {
    const result = await call({ cmd: "backfill", agent, limit });
    if (!result.ok) return toToolError(result.error || "补全失败", { agent });
    const stats = result.stats || {};
    const text = [
      `agent=${agent} 补全完成`,
      `本次队列 ${result.pending_after_queue ?? result.queued}，处理 ${result.processed}，跳过 ${result.skipped}，失败 ${result.failed}`,
      `覆盖度：${stats.embeddings}/${stats.facts}（${Math.round((stats.coverage || 0) * 100)}%），剩余待补 ${stats.pending_jobs}`,
    ].join("\n");
    return toToolResult({ agent, ...result }, text);
  }

  const result = await maintain("tool:backfill", { limit, force: true });
  if (!result.ok) {
    if (result.skipped === "running") return toToolResult({ skipped: "running" }, "上一轮补全还在进行中，稍后再看。");
    return toToolError(result.error || "补全失败");
  }
  const lines = (result.agents || []).map((a) => {
    if (a.error) return `- ${a.agent}: 失败（${a.error}）`;
    if (!a.pending) return `- ${a.agent}: 无需补全（${a.stats?.embeddings}/${a.stats?.facts}）`;
    return `- ${a.agent}: 处理 ${a.processed}，跳过 ${a.skipped}，失败 ${a.failed}，剩余 ${a.remaining}`;
  });
  const text = ["全部 agent 补全完成", ...lines].join("\n");
  return toToolResult({ ...result, runtime: snapshot() }, text);
}
