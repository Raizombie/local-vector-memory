/**
 * 嵌入模型体检：量当前模型对中文到底有没有区分度。
 * 只支持英文的模型（nomic-embed-text-v1.5 就是）会把不同中文句子压成近乎同一个向量，
 * 语义通道不但不帮忙，还会主动把排序带偏 —— 这个工具就是用来当场戳破它的。
 */

import { call, config } from "../lib/runtime.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "local_vector_memory_memory_vector_probe";
export const description =
  "体检当前 embedding 模型对中文的区分度：用几组「改写句 / 无关句」测相似度是否拉开了。" +
  "如果结论是 bad/weak，说明语义检索基本无效，该换成 bge-m3、Qwen3-Embedding 这类多语言模型。";

export const parameters = { type: "object", properties: {} };

export async function execute() {
  const cfg = await config();
  const result = await call({ cmd: "probe" }, { timeoutMs: 90000 });
  if (!result.ok) return toToolError(result.error || "体检失败（嵌入服务是否在跑？）");

  const text = [
    "嵌入模型体检",
    `服务：${cfg.embeddingBaseUrl}  模型：${result.model}  (${result.dims}d)`,
    `改写句相似度：${(result.paraphrase_sims || []).join(", ")}（均值 ${result.avg_paraphrase}）`,
    `无关句相似度：${(result.unrelated_sims || []).join(", ")}（均值 ${result.avg_unrelated}）`,
    `区分度差值：${result.gap}（改写句应明显高于无关句）`,
    `结论：${result.verdict}`,
    result.advice,
  ].join("\n");
  return toToolResult(result, text);
}
