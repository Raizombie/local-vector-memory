---
name: local-vector-memory
description: HanaAgent 记忆库的本地向量检索与维护。当用户问「以前说过什么 / 之前决定过什么 / 我的偏好是什么」，或需要排查语义检索、补嵌入、嵌入模型问题时使用。触发：记忆检索、search_memory_plus、向量记忆、补嵌入、嵌入模型、语义检索不准。
---

# 本地向量记忆

给 `<HANA_HOME>/agents/<agent>/memory/facts.db` 加了一层 sidecar 向量索引。facts.db 永远是唯一事实来源，
向量只是检索加速。

## 检索：先用它，再用原生

问「用户过去说过 / 决定过 / 偏好什么」这类需要语义召回的问题时，先调：

- `local_vector_memory_search_memory_plus`（参数：`query` 必填，`agent`、`limit`、`tags` 可选）

它返回每条命中的打分分解：`sem`（语义余弦）、`fts`（关键词排名分）、`tag`、`rec`（新近度），以及 `src`
（hybrid / vector / fts）。原生 `search_memory` 只在它不可用或返回空时兜底。

`agent` 缺省取当前会话所在的 agent（从 sessionPath 认领），一般不用传。

## 维护

- `local_vector_memory_memory_vector_status` — 各 agent 的覆盖度、待补条数、自动补全状态；加 `probe: true` 顺带体检嵌入模型。
- `local_vector_memory_memory_vector_backfill` — 补向量。缺省扫全部 agent；换了嵌入模型后用它能重建旧向量。
- `local_vector_memory_memory_vector_probe` — 体检当前嵌入模型对中文的区分度。
- `local_vector_memory_memory_vector_configure` — 改嵌入服务/模型/维度/python 命令/自动补全间隔。

后台每 60 秒自动扫一遍所有 agent 库并补齐，正常情况下不需要手动调 backfill。

## 判读要点

- 命中里 `sem` 普遍在 0.7 以上而 `fts` 才是真正拉开差距的那个 → 当前嵌入模型对中文区分度不足（nomic-embed-text
  这类英文模型就是如此）。先跑 `memory_vector_probe` 确认：如果「改写句」相似度不高于「无关句」，语义通道基本无效，
  该换 bge-m3、Qwen3-Embedding 这类多语言模型。换完用 `memory_vector_backfill` 重建，再 probe 一次。
- 覆盖度不足或 `pending_jobs` 不为 0 → 嵌入服务（LM Studio 等）可能没在跑，或 python 命令不可用，看
  `memory_vector_status` 里的 python 与最近错误。
