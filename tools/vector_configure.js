/**
 * 从对话里改设置（设置页的等价物），改完立刻重排后台定时器并清掉 python 缓存。
 */

import { config, log, sdkRef } from "../lib/runtime.js";
import { reschedule } from "../lib/scheduler.js";
import { resetPythonCache } from "../lib/worker.js";
import { toToolError, toToolResult } from "../lib/tool-output.js";

export const name = "local_vector_memory_memory_vector_configure";
export const description =
  "配置本地向量记忆：嵌入服务地址、API Key、模型、维度、python 命令、自动补全开关与间隔。只传要改的项。";

export const parameters = {
  type: "object",
  properties: {
    embeddingBaseUrl: { type: "string" },
    embeddingApiKey: { type: "string" },
    embeddingModel: { type: "string" },
    dimensions: { type: "integer" },
    pythonCommand: { type: "string" },
    autoMaintain: { type: "boolean" },
    maintainIntervalMs: { type: "integer" },
    batchSize: { type: "integer" },
    ftsCandidates: { type: "integer" },
    vectorCandidates: { type: "integer" },
    defaultLimit: { type: "integer" },
    fusion: { type: "string", enum: ["minmax", "linear"] },
    eventDriven: { type: "boolean" },
  },
};

const ALLOWED = new Set([
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

const MODEL_AFFECTING = new Set(["embeddingBaseUrl", "embeddingApiKey", "embeddingModel", "dimensions"]);

export async function execute(input = {}) {
  const sdk = sdkRef();
  if (!sdk?.config?.setMany) return toToolError("设置通道不可用（sdk.config 缺失）");

  const patch = {};
  for (const [key, value] of Object.entries(input)) {
    if (!ALLOWED.has(key)) continue;
    if (value === undefined || value === null) continue;
    patch[key] = value;
  }
  if (!Object.keys(patch).length) {
    const current = await config({ fresh: true });
    return toToolResult({ config: current }, `没有要改的项。当前配置：\n${JSON.stringify(current, null, 2)}`);
  }

  await Promise.resolve(sdk.config.setMany(patch));
  const next = await config({ fresh: true });

  if (patch.pythonCommand) resetPythonCache();
  await reschedule();

  const needsRebuild = Object.keys(patch).some((key) => MODEL_AFFECTING.has(key));
  await log("info", `设置已更新：${Object.keys(patch).join(", ")}${needsRebuild ? "（涉及嵌入模型，需要重嵌）" : ""}`);

  const text = [
    `已更新：${Object.keys(patch).join(", ")}`,
    `当前：${next.embeddingBaseUrl} | ${next.embeddingModel} (${next.dimensions}d) | autoMaintain=${next.autoMaintain} | python=${next.pythonCommand}`,
    needsRebuild
      ? "改动涉及嵌入模型/维度：跑一次 memory_vector_backfill（不带 agent，会扫全部库）把旧向量重嵌，之后 memory_vector_probe 验证区分度。"
      : "",
  ].filter(Boolean).join("\n");

  return toToolResult({ patch, config: next }, text);
}
