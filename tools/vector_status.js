/**
 * 记忆库向量状态总览：每个 agent 的覆盖度、待补条数、当前模型、后台补全情况。
 */

import { call, config, snapshot } from "../lib/runtime.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "local_vector_memory_memory_vector_status";
export const description =
  "查看所有 HanaAgent 记忆库（facts.db）的向量覆盖情况：每个 agent 有多少条事实、多少条已嵌入、" +
  "多少条待补、用的是哪个嵌入模型，以及后台自动补全是否在跑。";

export const parameters = {
  type: "object",
  properties: {
    probe: { type: "boolean", description: "顺便体检当前嵌入模型对中文的区分度" },
  },
};

export async function execute(input = {}) {
  const cfg = await config();
  const result = await call({ cmd: "agents" });
  if (!result.ok) return toToolError(result.error || "读取记忆库失败", { runtime: snapshot() });

  const agents = result.agents || [];
  const lines = agents.map((a) => {
    if (a.error) return `- ${a.agent}: 读取失败（${a.error}）`;
    const pct = Math.round((a.coverage || 0) * 100);
    const stale = a.stale_model_rows ? `，旧模型 ${a.stale_model_rows}` : "";
    return `- ${a.agent}: ${a.embeddings}/${a.facts}（${pct}%）待补 ${a.pending_jobs}${stale}`;
  });

  const rt = snapshot();
  const last = rt.lastMaintainAt ? new Date(rt.lastMaintainAt).toLocaleString() : "还没有";
  const text = [
    "本地向量记忆 · 状态",
    `嵌入服务：${cfg.embeddingBaseUrl}  模型：${cfg.embeddingModel}  (${cfg.dimensions}d)`,
    `python：${rt.python?.ok ? rt.python.command : "未找到"}`,
    `自动补全：${cfg.autoMaintain ? `开，每 ${Math.round(cfg.maintainIntervalMs / 1000)}s` : "关"}，上次运行：${last}`,
    rt.lastError ? `最近错误：${rt.lastError}` : "",
    "各 agent 记忆库：",
    ...lines,
    input.probe ? "" : "提示：加 probe=true 可顺便体检嵌入模型对中文的区分度。",
  ].filter(Boolean);

  let probe = null;
  if (input.probe) {
    const probed = await call({ cmd: "probe" }, { timeoutMs: 60000 });
    if (probed.ok) {
      probe = probed;
      text.push(`嵌入体检：${probed.verdict}（改写句 ${probed.avg_paraphrase} vs 无关句 ${probed.avg_unrelated}，差 ${probed.gap}）`);
      text.push(probed.advice);
    } else {
      text.push(`嵌入体检失败：${probed.error}`);
    }
  }

  return toToolResult({ agents, runtime: rt, probe }, text.join("\n"));
}
