/**
 * lib/scheduler.js —— 记忆补全的两种触发方式，各有独立开关。
 *
 * 1) 事件驱动（默认开）：订阅宿主的回合结束信号（turn_end / message_end），
 *    收到后延迟 EVENT_SETTLE_MS 再扫一次。这个延迟是留给 memoryTicker 的 ——
 *    它也是回合结束后才开始蒸馏写库，去早了空手而归。这期间又来事件则重新计时（去抖）。
 * 2) 定时轮询（默认开）：按 maintainIntervalMs 定时扫一遍所有 agent 的记忆库。
 *
 * 两个开关互相独立：可以都开、只开一个、或者都关（那样只剩手动补全和启动时扫一次）。
 * 只开事件驱动最省（空闲时完全不动作），代价是信号一旦丢了就没人兜底；
 * 只开定时轮询兼容性最好，代价是空闲时也会按点起一个 python 进程空转一圈。
 *
 * 背景：这正是 v1 插件里坏掉的那一环。它的 onload 在应用启动时拿不到 agentId，
 * 回退成不存在的 "hanako" 目录，异常又被一个在该宿主里根本不存在的日志通道吞掉，
 * 于是定时器从来没被注册过 —— 补嵌入只能靠人手点。这里的做法是不再猜单个 agent，
 * 直接扫 <HANA_HOME>/agents/* 下的全部记忆库，并且每一次动作和失败都写日志。
 */

import { config, log, maintain, sdkRef } from "./runtime.js";

let timer = null;
let started = false;
let unsubscribe = null;
let settleTimer = null;

/** 轮询间隔下限，防止设置里填出 0 变成死循环。 */
const MIN_INTERVAL_MS = 15000;
/** 事件触发时的短节流：一轮对话可能连发好几个事件，别每个都跑一遍。 */
const EVENT_MIN_GAP_MS = 5000;
/** 收到回合结束信号后先歇这么久，等 memoryTicker 把这一轮的记忆写完。 */
const EVENT_SETTLE_MS = 10000;

export function startScheduler() {
  if (started) return { ok: true, already: true };
  started = true;

  // 推迟到本轮启动流程之后，避开宿主启动握手窗口
  setTimeout(() => {
    void bootstrap();
  }, 0);

  return { ok: true };
}

async function bootstrap() {
  // 启动先补一次积压：有活才干活，没活就直接退出，与两个开关无关
  void runOnce("startup");
  await applyModes();
}

/**
 * 按当前设置启停两种机制。改完设置调它即可（原来叫 reschedule）。
 */
export async function applyModes() {
  const cfg = await config({ fresh: true });

  if (cfg.autoMaintain) {
    const interval = Math.max(MIN_INTERVAL_MS, Number(cfg.maintainIntervalMs) || 60000);
    if (timer) clearInterval(timer);
    timer = setInterval(() => { void runOnce("timer"); }, interval);
    if (timer.unref) timer.unref();
  } else if (timer) {
    clearInterval(timer);
    timer = null;
  }

  if (cfg.eventDriven) {
    await startEventDriven();
  } else {
    await stopEventDriven();
  }

  const polling = cfg.autoMaintain ? `开（每 ${Math.round(Number(cfg.maintainIntervalMs) / 1000)}s）` : "关";
  const events = cfg.eventDriven ? "开" : "关";
  const tail = cfg.autoMaintain || cfg.eventDriven ? "" : "；两者都关，只能手动补全";
  await log("info", `补全方式：回合结束触发=${events}，定时轮询=${polling}${tail}`);

  return { ok: true, autoMaintain: Boolean(cfg.autoMaintain), eventDriven: Boolean(cfg.eventDriven) };
}

/** 兼容旧调用名。 */
export async function reschedule() {
  if (!started) return { ok: true, skipped: true };
  return applyModes();
}

/**
 * 订「一轮对话结束」的信号，听到就稍后补一次。
 * 事件真的到不到，日志里一眼能看出来，所以这里把订阅结果也写进去。
 */
export async function startEventDriven() {
  if (unsubscribe) return { ok: true, already: true };
  const sdk = sdkRef();
  if (!sdk?.bus?.subscribe) {
    await log("warn", "宿主没有 bus.subscribe，只能靠定时轮询");
    return { ok: false, reason: "no-bus" };
  }
  try {
    unsubscribe = await sdk.bus.subscribe(
      (event) => {
        const type = event?.type || event?.kind || "unknown";
        // turn_end 和 message_end 是同一件事的两种粒度（一轮走完 / 一条消息写完），
        // 两个都订是为了不漏：不同场景可能只发其中一个。
        if (type !== "turn_end" && type !== "message_end") return;
        const reason = `event:${type}`;
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(() => {
          settleTimer = null;
          void runOnce(reason, { minGapMs: EVENT_MIN_GAP_MS });
        }, EVENT_SETTLE_MS);
        if (settleTimer.unref) settleTimer.unref();
      },
      { types: ["turn_end", "message_end"] },
    );
    await log("info", `已订阅回合结束信号（turn_end / message_end），收到后 ${EVENT_SETTLE_MS / 1000}s 补一次`);
    return { ok: true };
  } catch (error) {
    await log("warn", `订阅回合结束信号失败，退回流询：${error?.message || error}`);
    return { ok: false, reason: String(error?.message || error) };
  }
}

async function stopEventDriven() {
  if (unsubscribe) {
    try {
      if (typeof unsubscribe === "function") unsubscribe();
      else if (typeof unsubscribe.disposeAsync === "function") await unsubscribe.disposeAsync();
      else if (typeof unsubscribe.dispose === "function") unsubscribe.dispose();
    } catch {
      /* 已失效 */
    }
  }
  unsubscribe = null;
  if (settleTimer) {
    clearTimeout(settleTimer);
    settleTimer = null;
  }
}

async function runOnce(reason, options = {}) {
  try {
    await maintain(reason, options);
  } catch (error) {
    await log("warn", `后台补全(${reason})异常：${error?.message || error}`);
  }
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = null;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = null;
  if (typeof unsubscribe === "function") {
    try { unsubscribe(); } catch { /* 已失效 */ }
  }
  unsubscribe = null;
  started = false;
}
