import { hana } from "./sdk.js";

const $ = (id) => document.getElementById(id);
const CONFIG_FIELDS = [
  "embeddingBaseUrl",
  "embeddingApiKey",
  "embeddingModel",
  "dimensions",
  "pythonCommand",
  "autoMaintain",
  "maintainIntervalMs",
  "eventDriven",
  "fusion",
];

let lastStatus = null;

async function api(path, init) {
  const res = await hana.api.fetch(path, init);
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { ok: false, error: text };
  }
}

function post(path, body) {
  return api(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {}),
  });
}

function fail(message) {
  $("panel-error").textContent = message || "";
}

function setBusy(button, busy, label) {
  if (!button) return;
  button.disabled = busy;
  if (label) button.textContent = label;
}

function pct(value) {
  return `${Math.round((value || 0) * 100)}%`;
}

function renderSummary(status) {
  const cfg = status.config || {};
  const rt = status.runtime || {};
  const last = rt.lastMaintainAt ? new Date(rt.lastMaintainAt).toLocaleString() : "还没跑过";
  $("summary").textContent =
    `${cfg.embeddingModel} · ${cfg.dimensions}d · ${cfg.embeddingBaseUrl} ｜ python: ${rt.python?.ok ? rt.python.command : "未找到"}` +
    ` ｜ 自动补全：${cfg.autoMaintain ? `开（每 ${Math.round((cfg.maintainIntervalMs || 0) / 1000)}s，上次 ${last}）` : "关"}`;
  if (rt.lastError) fail(`最近错误：${rt.lastError}`);
  else if (status.error) fail(status.error);
  else fail("");
}

function renderAgents(status) {
  const tbody = $("agent-rows");
  const agents = status.agents || [];
  const select = $("search-agent");
  const previous = select.value;
  tbody.innerHTML = "";
  select.innerHTML = "";
  if (!agents.length) {
    tbody.innerHTML = '<tr><td colspan="6" class="note">没有读到任何 facts.db</td></tr>';
    return;
  }
  for (const agent of agents) {
    const tr = document.createElement("tr");
    if (agent.error) {
      tr.innerHTML = `<td>${agent.agent}</td><td colspan="5" class="err">${agent.error}</td>`;
      tbody.appendChild(tr);
      continue;
    }
    const coverage = agent.coverage || 0;
    const stale = agent.stale_model_rows ? `<span class="tag warn">旧模型 ${agent.stale_model_rows}</span>` : "";
    tr.innerHTML = `
      <td>${agent.agent}</td>
      <td class="num">${agent.facts}</td>
      <td class="num">${agent.embeddings}</td>
      <td><div class="bar"><i style="width:${pct(coverage)}"></i></div><span class="note">${pct(coverage)}</span> ${stale}</td>
      <td class="num">${agent.pending_jobs}</td>
      <td><button data-agent="${agent.agent}">补全</button></td>`;
    tbody.appendChild(tr);

    const option = document.createElement("option");
    option.value = agent.agent;
    option.textContent = agent.agent;
    select.appendChild(option);
  }
  if (previous) select.value = previous;
  tbody.querySelectorAll("button[data-agent]").forEach((button) => {
    button.addEventListener("click", () => runMaintain(button.dataset.agent, button));
  });
}

function renderConfig(status) {
  const cfg = status.config || {};
  for (const key of CONFIG_FIELDS) {
    const el = $(`cfg-${key}`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = Boolean(cfg[key]);
    else el.value = cfg[key] ?? "";
  }
}

async function refresh() {
  try {
    const status = await api("status");
    if (!status?.ok) {
      fail(`读取状态失败：${status?.error || status?.message || "未知错误"}`);
      return;
    }
    lastStatus = status;
    renderSummary(status);
    renderConfig(status);
    renderAgents(status);
  } catch (error) {
    fail(`读取状态异常：${error?.message || error}`);
  }
}

async function runMaintain(agent, button) {
  setBusy(button, true, "补全中…");
  $("maintain-note").textContent = agent ? `正在补全 ${agent} …` : "正在扫描全部 agent …";
  try {
    const result = await post("maintain", agent ? { agent, limit: 500 } : { limit: 500 });
    if (!result?.ok) {
      $("maintain-note").textContent = `补全失败：${result?.error || "未知错误"}`;
    } else {
      const r = result.result || {};
      if (agent) {
        $("maintain-note").textContent = `${agent}：处理 ${r.processed ?? 0}，跳过 ${r.skipped ?? 0}，失败 ${r.failed ?? 0}`;
      } else {
        const touched = (r.agents || []).filter((a) => a.processed || a.error);
        $("maintain-note").textContent = touched.length
          ? touched.map((a) => `${a.agent}: +${a.processed}${a.error ? ` (${a.error})` : ""}`).join("，")
          : "没有需要补的，全部已是最新。";
      }
    }
    await refresh();
  } catch (error) {
    $("maintain-note").textContent = `补全异常：${error?.message || error}`;
  } finally {
    setBusy(button, false, "补全");
  }
}

async function runProbe(button) {
  setBusy(button, true, "体检中…");
  try {
    const result = await post("probe");
    const box = $("probe-result");
    if (!result?.ok) {
      box.innerHTML = `<p class="err">体检失败：${result?.error || "未知错误"}</p>`;
      return;
    }
    const p = result.probe;
    const cls = p.verdict === "ok" ? "ok" : p.verdict === "weak" ? "warn" : "bad";
    box.innerHTML = `
      <p class="note">模型 ${p.model} (${p.dims}d)</p>
      <p>改写句相似度 ${(p.paraphrase_sims || []).join(" / ")}（均值 ${p.avg_paraphrase}）</p>
      <p>无关句相似度 ${(p.unrelated_sims || []).join(" / ")}（均值 ${p.avg_unrelated}）</p>
      <p><span class="tag ${cls}">${p.verdict}</span> 区分度差值 ${p.gap}</p>
      <p class="note">${p.advice}</p>`;
  } catch (error) {
    $("probe-result").innerHTML = `<p class="err">体检异常：${error?.message || error}</p>`;
  } finally {
    setBusy(button, false, "跑体检");
  }
}

async function runSearch(button) {
  const query = $("search-query").value.trim();
  const agent = $("search-agent").value;
  if (!query || !agent) {
    $("search-result").innerHTML = '<p class="warn">选一个 agent 并输入查询。</p>';
    return;
  }
  setBusy(button, true, "检索中…");
  try {
    const result = await post("search", { query, agent, limit: 8 });
    if (!result?.ok) {
      $("search-result").innerHTML = `<p class="err">检索失败：${result?.error || "未知错误"}</p>`;
      return;
    }
    const hits = result.results || [];
    if (!hits.length) {
      $("search-result").innerHTML = '<p class="note">没有命中。</p>';
      return;
    }
    $("search-result").innerHTML = hits.map((hit) => `
      <pre class="hit">[${hit.score.toFixed(3)}] #${hit.id} ${escapeHtml(hit.fact)}
sem ${hit.semanticScore.toFixed(3)} · fts ${hit.ftsScore.toFixed(3)} · tag ${hit.tagScore.toFixed(2)} · rec ${hit.recencyScore.toFixed(2)} · ${hit.source}</pre>`).join("");
    if (result.warnings?.length) {
      $("search-result").insertAdjacentHTML("beforeend", result.warnings.map((w) => `<p class="warn">${escapeHtml(w)}</p>`).join(""));
    }
  } catch (error) {
    $("search-result").innerHTML = `<p class="err">检索异常：${error?.message || error}</p>`;
  } finally {
    setBusy(button, false, "检索");
  }
}

async function saveConfig(button) {
  const patch = {};
  for (const key of CONFIG_FIELDS) {
    const el = $(`cfg-${key}`);
    if (!el) continue;
    if (el.type === "checkbox") patch[key] = el.checked;
    else if (el.type === "number") patch[key] = Number(el.value);
    else patch[key] = el.value;
  }
  setBusy(button, true, "保存中…");
  try {
    const result = await post("config", { patch });
    if (!result?.ok) fail(`保存失败：${result?.error || "未知错误"}`);
    else {
      fail("");
      await refresh();
    }
  } catch (error) {
    fail(`保存异常：${error?.message || error}`);
  } finally {
    setBusy(button, false, "保存");
  }
}

function escapeHtml(text) {
  return String(text ?? "").replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
}

$("btn-refresh").addEventListener("click", refresh);
$("btn-maintain").addEventListener("click", (event) => runMaintain(null, event.currentTarget));
$("btn-probe").addEventListener("click", (event) => runProbe(event.currentTarget));
$("btn-search").addEventListener("click", (event) => runSearch(event.currentTarget));
$("btn-save").addEventListener("click", (event) => saveConfig(event.currentTarget));

hana.ready().then(() => {
  refresh();
});
