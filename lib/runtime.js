/**
 * lib/runtime.js —— 工具的公共状态：配置、python 通道、后台补全。
 *
 * 所有对外动作（工具、设置页路由、后台定时器）都从这里走，
 * 这样「谁在什么时候补嵌入了」只有一处答案，也不会各写一份 spawn。
 */

import { readConfig, workerConfig } from "./config.js";
import { hanakoHome } from "./env.js";
import { resetPythonCache, resolvePython, spawnWorker } from "./worker.js";

const state = {
  sdk: null,
  dataDir: null,
  home: null,
  config: null,
  configAt: 0,
  python: null,
  maintainRunning: false,
  lastMaintainAt: 0,
  lastMaintain: null,
  lastError: null,
  lastMaintainReason: null,
};

const CONFIG_TTL_MS = 5000;
const MIN_MAINTAIN_GAP_MS = 30000;

export function init(sdk, ctx) {
  // 入口的 sdk 与路由 ctx 都能提供 config；先到先得，但只有带 config 的才算数。
  if (sdk && typeof sdk.config?.getAll === "function" && !state.sdk) state.sdk = sdk;
  if (!state.sdk && sdk) state.sdk = sdk;
  const dataDir = ctx?.dataDir || sdk?.dataDir || state.dataDir;
  state.dataDir = dataDir || null;
  state.home = hanakoHome(state.dataDir);
  return state.home;
}

export function home() {
  if (!state.home) state.home = hanakoHome(state.dataDir);
  return state.home;
}

/** 工具侧需要写设置时用；未初始化时返回 null。 */
export function sdkRef() {
  return state.sdk;
}

export function logger() {
  return state.sdk?.logger || { info: async () => {}, warn: async () => {}, error: async () => {}, debug: async () => {} };
}

/** 日志只保留第一个参数落盘，所以先自己拼好字符串再传。 */
export async function log(level, message) {
  const sink = logger();
  const fn = typeof sink[level] === "function" ? sink[level] : sink.info;
  try {
    await fn.call(sink, `[vector-memory] ${message}`);
  } catch {
    /* 日志通道不可用不该影响主流程 */
  }
}

export async function config({ fresh = false } = {}) {
  const now = Date.now();
  if (!fresh && state.config && now - state.configAt < CONFIG_TTL_MS) return state.config;
  state.config = await readConfig(state.sdk);
  state.configAt = now;
  return state.config;
}

export async function ensurePython(force = false) {
  if (state.python?.ok && !force) return state.python;
  const cfg = await config();
  if (force) resetPythonCache();
  state.python = await resolvePython(cfg, { log: (msg) => log("info", msg) });
  return state.python;
}

/** 调一次 worker，返回它的 JSON。 */
export async function call(request, { timeoutMs = 180000, forcePython = false } = {}) {
  const cfg = await config();
  const python = await ensurePython(forcePython);
  if (!python.ok) {
    const error = `找不到可用的 python 解释器（试过：${(python.tried || []).join("、")}）。请在 App 设置里填 pythonCommand。`;
    state.lastError = error;
    return { ok: false, error };
  }
  const payload = { ...request, home: request.home ?? home(), config: workerConfig(cfg) };
  const result = await spawnWorker(cfg, payload, { timeoutMs });
  if (!result.ok) state.lastError = result.error || "worker 失败";
  return result;
}

/**
 * 后台补全：扫描所有 agent 的 facts.db，缺什么补什么。
 * reason 只进日志，force 用来绕过节流（手动按钮用）。
 */
export async function maintain(reason, { limit = 200, force = false, minGapMs = MIN_MAINTAIN_GAP_MS } = {}) {
  state.lastMaintainReason = reason;
  if (state.maintainRunning) return { ok: false, skipped: "running" };
  const now = Date.now();
  if (!force && now - state.lastMaintainAt < minGapMs) {
    return { ok: false, skipped: "throttled" };
  }
  state.maintainRunning = true;
  try {
    const result = await call({ cmd: "maintain", limit });
    state.lastMaintainAt = Date.now();
    state.lastMaintain = result;
    if (!result.ok) {
      state.lastError = result.error;
      await log("warn", `后台补全(${reason})失败：${result.error}`);
    } else {
      const touched = (result.agents || []).filter((a) => a.processed || a.error);
      const summary = touched
        .map((a) => `${a.agent}: ${a.error ? `错误 ${a.error}` : `补 ${a.processed} 跳 ${a.skipped || 0}`}`)
        .join(" / ");
      if (summary) await log("info", `后台补全(${reason})：${summary}`);
    }
    return result;
  } finally {
    state.maintainRunning = false;
  }
}

export function snapshot() {
  return {
    home: home(),
    dataDir: state.dataDir,
    python: state.python ? { ok: state.python.ok, command: state.python.command, tried: state.python.tried } : null,
    maintainRunning: state.maintainRunning,
    lastMaintainAt: state.lastMaintainAt || null,
    lastMaintainReason: state.lastMaintainReason,
    lastMaintain: state.lastMaintain,
    lastError: state.lastError,
  };
}
