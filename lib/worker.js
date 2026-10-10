/**
 * lib/worker.js —— 把一次请求交给 python worker，拿回一份 JSON。
 *
 * 为什么不是纯 JS：
 *   App 的 JS 跑在宿主 Node 权限模型里（--allow-fs-read=安装目录、
 *   --allow-fs-write=app-data），连 fs.existsSync 都够不到
 *   <HANA_HOME>/agents/<agent>/memory/facts.db。spawn 出来的子进程不继承这层限制，
 *   所以碰 facts.db 的活全交给 python（标准库 sqlite3/urllib，零依赖）。
 *
 * 协议：写一行 JSON 到 stdin，读 stdout 一整份 JSON，stderr 当日志。
 */

import { spawn } from "node:child_process";
import { WORKER_SCRIPT } from "./env.js";

/** 上一次探测成功的命令，避免每次调用都试一轮。 */
let resolvedCommand = null;
/** 正在进行的探测，避免并发调用各起一个 python 进程。 */
let resolving = null;

function splitCommand(command) {
  return String(command || "").trim().split(/\s+/).filter(Boolean);
}

function candidateCommands(config) {
  const list = [];
  if (config && config.pythonCommand) list.push(config.pythonCommand);
  list.push("python", "py -3", "python3");
  // 兜底：本机已知的 CPython 安装位置（探不到 PATH 时还能活）。
  list.push("E:\\Python\\Python312\\python.exe");
  return [...new Set(list.filter(Boolean))];
}

export function spawnWorker(config, request, { timeoutMs = 180000 } = {}) {
  const command = resolvedCommand || (config && config.pythonCommand) || "python";
  const [bin, ...prefix] = splitCommand(command);
  const args = [...prefix, WORKER_SCRIPT];
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, {
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" },
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: `无法启动 ${command}：${error.message}` });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* 已退出 */ }
      finish({ ok: false, error: `worker 超时（${timeoutMs}ms）`, stderr: stderr.slice(-400) });
    }, timeoutMs);

    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr.on("data", (chunk) => { stderr += String(chunk); });
    child.on("error", (error) => finish({ ok: false, error: `${command} 启动失败：${error.message}`, stderr }));
    child.on("close", (code) => {
      const text = stdout.trim();
      if (!text) {
        finish({ ok: false, error: `worker 无输出（退出码 ${code}）`, stderr: stderr.slice(-400) });
        return;
      }
      try {
        const parsed = JSON.parse(text.split("\n").pop());
        if (stderr.trim()) parsed.stderr = stderr.trim().slice(-400);
        finish(parsed);
      } catch (error) {
        finish({ ok: false, error: `worker 输出不是 JSON：${error.message}`, stdout: text.slice(-400), stderr });
      }
    });

    child.stdin.on("error", () => { /* 子进程早退时忽略 EPIPE */ });
    child.stdin.end(JSON.stringify(request));
  });
}

/** 探一次可用的 python 解释器，成功的结果会被记住（并发只跑一轮）。 */
export async function resolvePython(config, { log } = {}) {
  if (resolvedCommand) return { ok: true, command: resolvedCommand, cached: true };
  if (resolving) return resolving;
  resolving = probePython(config, log);
  try {
    return await resolving;
  } finally {
    resolving = null;
  }
}

async function probePython(config, log) {
  const tried = [];
  for (const command of candidateCommands(config)) {
    const result = await spawnWorker({ ...config, pythonCommand: command }, { cmd: "ping" }, { timeoutMs: 20000 });
    tried.push(`${command}${result.ok ? "" : `(${result.error || "失败"})`}`);
    if (result.ok && result.pong) {
      resolvedCommand = command;
      if (log) await log(`python 可用：${command}（${result.python}）`);
      return { ok: true, command, python: result.python, tried };
    }
  }
  if (log) await log(`没有可用的 python 解释器，试过：${tried.join("、")}`);
  return { ok: false, tried };
}

export function resetPythonCache() {
  resolvedCommand = null;
}
