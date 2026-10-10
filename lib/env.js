/**
 * lib/env.js —— 身份与路径的单一来源。
 *
 * 两处不能想当然的地方：
 *   1) App 的安装目录在 v2 是只读的（Node 权限模型约束的是 AppHost 进程），
 *      所以任何写入都只能落 ctx.dataDir；但 facts.db 在 HANA_HOME/agents 下，
 *      两边都够不着 —— 这正是一切 sqlite 活都交给 python 子进程的原因。
 *   2) AppHost 的 env 是白名单，HANA_HOME 不保证存在；从 dataDir
 *      （<HANA_HOME>/app-data/<id>）往上两层反推才靠得住。
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_ID = "local-vector-memory";

/** App 包根目录（安装目录，只读）。lib/env.js -> '..' */
export const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** 静态 UI 根（route 解析到 /api/apps/<id>/ui<route>）。 */
export const UI_DIR = path.join(PLUGIN_ROOT, "ui");

/** 真正干活的 python worker。 */
export const WORKER_SCRIPT = path.join(PLUGIN_ROOT, "python", "vector_memory.py");

/** 从 ctx.dataDir 反推 HANA_HOME。 */
export function hanakoHome(dataDir) {
  const dir = typeof dataDir === "string" && dataDir ? dataDir : process.env.HANAKO_PLUGIN_DATA;
  if (dir) {
    const parent = path.dirname(dir); // <HANA_HOME>/app-data
    if (path.basename(parent) === "app-data") return path.dirname(parent);
    return path.dirname(parent);
  }
  return process.env.HANA_HOME || path.join(process.env.USERPROFILE || process.env.HOME || "", ".hanako");
}

/**
 * 从会话路径里认领 agent。
 * 工具侧拿不到 agentId，但 sessionPath 长这样：
 *   <HANA_HOME>/agents/<agentId>/sessions/xxx.jsonl
 *   <HANA_HOME>/agents/<agentId>/subagent-sessions/direct/xxx.jsonl
 * 认出第二个片段即可；认不出就返回 null，由调用方决定退路。
 */
export function agentFromSessionPath(sessionPath) {
  if (!sessionPath || typeof sessionPath !== "string") return null;
  const parts = sessionPath.split(/[\\/]+/).filter(Boolean);
  const index = parts.lastIndexOf("agents");
  if (index >= 0 && parts[index + 1]) return parts[index + 1];
  return null;
}
