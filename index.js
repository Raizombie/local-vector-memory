// local-vector-memory v2 App 入口。
//
// 三件事：
//   1) 启动时记一行带 HANA_HOME / dataDir 的日志 —— v1 插件死就死在
//      "找不到 facts.db 但没人看得见"，所以身份解析结果必须落进日志；
//   2) 注册 5 个工具，把宿主给的 invocation 拆成 (input, ctx)，
//      agentId 从 context.sessionPath 里认领（工具上下文不带 agentId）；
//   3) 起后台补全定时器：扫全部 agent 库，缺向量就补，日志全程可见。

import { defineApp } from "./sdk/app-contract/server-client.js";
import { agentFromSessionPath } from "./lib/env.js";
import { home, init, log } from "./lib/runtime.js";
import { startScheduler } from "./lib/scheduler.js";
import * as toolBackfill from "./tools/vector_backfill.js";
import * as toolConfigure from "./tools/vector_configure.js";
import * as toolProbe from "./tools/vector_probe.js";
import * as toolSearch from "./tools/vector_search.js";
import * as toolStatus from "./tools/vector_status.js";

export const name = "local-vector-memory";

const TOOL_MODULES = [toolSearch, toolStatus, toolBackfill, toolProbe, toolConfigure];

export default defineApp(async (sdk) => {
  const resolved = init(sdk, sdk);
  await log("info", `v2 启动 | HANA_HOME=${resolved} | dataDir=${sdk?.dataDir || "(未知)"} | spawn=${typeof sdk?.dataDir}`);

  for (const mod of TOOL_MODULES) {
    await sdk.tools.register({
      name: mod.name,
      description: mod.description,
      parameters: mod.parameters,
      execute: async (invocation) => {
        const raw = invocation && typeof invocation === "object" ? invocation : {};
        const { context, ...input } = raw;
        const sessionPath = context?.sessionPath || null;
        const ctx = {
          sessionPath,
          agentId: agentFromSessionPath(sessionPath),
        };
        return mod.execute(input, ctx);
      },
    });
  }

  await log("info", `已注册工具：${TOOL_MODULES.map((m) => m.name).join(", ")}`);

  startScheduler();
});
