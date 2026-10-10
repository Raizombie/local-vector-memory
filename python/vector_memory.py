#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""vector_memory worker —— 本地向量记忆的实干层。

为什么存在这个文件：
App 的 JS 跑在宿主的 Node 权限模型里（--allow-fs-read=安装目录、--allow-fs-write=app-data），
连 fs.existsSync 都碰不到 ~/.hanako/agents/*/memory/facts.db。由 App spawn 出来的子进程
不继承这层限制，所以所有碰 facts.db 的活（建表、补嵌入、检索）一律交给这里。

协议：stdin 收一个 JSON 请求，stdout 吐一个 JSON 响应，日志走 stderr。
不需要任何第三方依赖（sqlite3 / urllib / array 都是标准库）。
"""

import array
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import unicodedata
import urllib.error
import urllib.request

# ---------------------------------------------------------------- consts --- #

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS fact_embeddings (
  fact_id INTEGER PRIMARY KEY,
  model TEXT NOT NULL,
  dims INTEGER NOT NULL,
  vector BLOB NOT NULL,
  content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY(fact_id) REFERENCES facts(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_fact_embeddings_model
  ON fact_embeddings(model, dims);

CREATE TABLE IF NOT EXISTS fact_embedding_jobs (
  fact_id INTEGER PRIMARY KEY,
  reason TEXT NOT NULL,
  queued_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  FOREIGN KEY(fact_id) REFERENCES facts(id) ON DELETE CASCADE
);

CREATE TRIGGER IF NOT EXISTS hvm_facts_ai AFTER INSERT ON facts
BEGIN
  INSERT OR REPLACE INTO fact_embedding_jobs(fact_id, reason, queued_at, attempts, last_error)
  VALUES (new.id, 'insert', datetime('now'), 0, NULL);
END;

CREATE TRIGGER IF NOT EXISTS hvm_facts_au AFTER UPDATE OF fact, search_text, tags ON facts
BEGIN
  INSERT OR REPLACE INTO fact_embedding_jobs(fact_id, reason, queued_at, attempts, last_error)
  VALUES (new.id, 'update', datetime('now'), 0, NULL);
END;

CREATE TRIGGER IF NOT EXISTS hvm_facts_ad AFTER DELETE ON facts
BEGIN
  DELETE FROM fact_embeddings WHERE fact_id = old.id;
  DELETE FROM fact_embedding_jobs WHERE fact_id = old.id;
END;
"""

# 线性融合的权重（历史默认，回退时行为保持一致）
WEIGHTS_LINEAR = {"semantic": 0.55, "fts": 0.30, "tag": 0.10, "recency": 0.05}
# 量纲对齐（min-max）之后的权重：这时数字才真等于话语权，所以往语义偏。
# 2026-10-09 实测：0.55/0.30 在 minmax 下会把“语义最高但字面不撞”的那条挤在头部之外。
WEIGHTS_MINMAX = {"semantic": 0.65, "fts": 0.20, "tag": 0.10, "recency": 0.05}

CJK_RE = re.compile(r"[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uac00-\ud7af]+")

BUSY_TIMEOUT_MS = 15000


class WorkerError(Exception):
    pass


def log(msg):
    sys.stderr.write("[vector-memory] %s\n" % msg)
    sys.stderr.flush()


# ------------------------------------------------------------- text utils --- #

def normalize_text(value):
    text = unicodedata.normalize("NFKC", str(value or "")).strip()
    return re.sub(r"\s+", " ", text).lower()


def content_hash(text):
    return hashlib.sha256(normalize_text(text).encode("utf-8")).hexdigest()


def text_for_embedding(fact, tags_raw):
    tags = []
    if isinstance(tags_raw, str):
        try:
            parsed = json.loads(tags_raw or "[]")
            if isinstance(parsed, list):
                tags = [t for t in parsed if isinstance(t, str)]
        except Exception:
            tags = []
    elif isinstance(tags_raw, list):
        tags = [t for t in tags_raw if isinstance(t, str)]
    return "\n".join([p for p in [fact or ""] + tags if p])


def cjk_ngrams(text):
    tokens = []
    for match in CJK_RE.finditer(text):
        chars = list(match.group(0))
        for size in (2, 3):
            if len(chars) < size:
                continue
            for i in range(len(chars) - size + 1):
                tokens.append("".join(chars[i:i + size]))
    return tokens


def build_fts_query(query):
    normalized = unicodedata.normalize("NFKC", str(query or "")).strip()
    if not normalized:
        return ""
    tokens = normalized.split()
    tokens += cjk_ngrams(normalized)
    seen, out = set(), []
    for token in tokens:
        tok = unicodedata.normalize("NFKC", token).strip()
        if not tok or tok in seen:
            continue
        seen.add(tok)
        out.append('"%s"' % tok.replace('"', '""'))
    return " OR ".join(out)


def has_cjk(text):
    return bool(CJK_RE.search(unicodedata.normalize("NFKC", str(text or ""))))


def normalize_vector(values):
    norm = 0.0
    for value in values:
        norm += value * value
    norm = norm ** 0.5 or 1.0
    return [float(v) / norm for v in values]


def vector_to_blob(values):
    return array.array("f", values).tobytes()


def blob_to_vector(blob):
    vec = array.array("f")
    vec.frombytes(blob)
    return vec


# ------------------------------------------------------------------- db ----- #

def open_db(path, read_only=False):
    if not path or not os.path.exists(path):
        raise WorkerError("facts.db 不存在：%s" % path)
    if read_only:
        con = sqlite3.connect("file:%s?mode=ro" % path.replace("?", "%3f"), uri=True, timeout=10)
    else:
        con = sqlite3.connect(path, timeout=BUSY_TIMEOUT_MS / 1000.0)
    con.execute("PRAGMA busy_timeout = %d" % BUSY_TIMEOUT_MS)
    # 外键级联：facts 被删时 fact_embeddings / fact_embedding_jobs 跟着走。
    # 触发器已经做了同一件事，这里再上一层，保证即使触发器被别的程序改掉也不留孤儿。
    con.execute("PRAGMA foreign_keys = ON")
    con.row_factory = sqlite3.Row
    return con


def has_table(con, name):
    return bool(con.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone())


def init_schema(con):
    con.executescript(SCHEMA_SQL)
    con.commit()


def fact_db_path(home, agent):
    return os.path.join(home, "agents", agent, "memory", "facts.db")


def resolve_db(req):
    """允许只传 agent（路径由这里拼），也允许直接给 db。"""
    db = req.get("db")
    if db:
        return db
    agent = req.get("agent")
    if agent and req.get("home"):
        return fact_db_path(req["home"], agent)
    raise WorkerError("缺少 db 路径，或缺少 agent + home")


def list_agents(home):
    agents_dir = os.path.join(home, "agents")
    if not os.path.isdir(agents_dir):
        return []
    found = []
    for name in sorted(os.listdir(agents_dir)):
        db = fact_db_path(home, name)
        if os.path.exists(db):
            found.append((name, db))
    return found


# --------------------------------------------------------------- embedding -- #

def embedding_endpoint(base_url):
    trimmed = str(base_url or "").strip().rstrip("/")
    if not trimmed:
        raise WorkerError("embeddingBaseUrl 未配置")
    if trimmed.endswith("/embeddings"):
        return trimmed
    return trimmed + "/embeddings"


def embed_texts(config, texts):
    url = embedding_endpoint(config.get("base_url"))
    model = str(config.get("model") or "").strip()
    dims = int(config.get("dims") or 0)
    timeout = float(config.get("timeout_ms") or 30000) / 1000.0
    headers = {"Content-Type": "application/json"}
    api_key = str(config.get("api_key") or "").strip()
    if api_key:
        headers["Authorization"] = "Bearer %s" % api_key

    def call(payload):
        body = json.dumps(payload).encode("utf-8")
        req = urllib.request.Request(url, data=body, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                return json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as err:
            detail = ""
            try:
                detail = err.read().decode("utf-8", "replace")[:400]
            except Exception:
                pass
            raise WorkerError("HTTP %s %s" % (err.code, detail.strip()))

    payload = {"model": model, "input": texts}
    if dims > 0:
        payload["dimensions"] = dims
    try:
        data = call(payload)
    except WorkerError as err:
        if dims > 0 and str(err).startswith("HTTP 400"):
            log("服务端拒绝 dimensions 参数，去掉重试一次")
            data = call({"model": model, "input": texts})
        else:
            raise

    vectors = [item.get("embedding") for item in (data.get("data") or [])]
    if not vectors or any(not isinstance(v, list) for v in vectors):
        raise WorkerError("embedding 响应缺少 data[].embedding")
    out = []
    for vec in vectors:
        if dims > 0 and len(vec) != dims:
            raise WorkerError("嵌入维度不匹配：期望 %d，实际 %d（改 embedding.dimensions 或换模型）"
                              % (dims, len(vec)))
        out.append(normalize_vector(vec))
    return out


# ------------------------------------------------------------------ jobs ---- #

def queue_missing(con, config):
    """把「没有向量」和「向量属于旧模型/旧维度」的事实都排进队列。"""
    model = str(config.get("model") or "").strip()
    dims = int(config.get("dims") or 0)
    init_schema(con)
    con.execute(
        """
        INSERT OR IGNORE INTO fact_embedding_jobs(fact_id, reason, queued_at)
        SELECT f.id, 'missing', datetime('now')
        FROM facts f
        LEFT JOIN fact_embeddings e ON e.fact_id = f.id
        WHERE e.fact_id IS NULL
        """
    )
    if model and dims:
        con.execute(
            """
            INSERT OR IGNORE INTO fact_embedding_jobs(fact_id, reason, queued_at)
            SELECT f.id, 'stale-model', datetime('now')
            FROM facts f
            JOIN fact_embeddings e ON e.fact_id = f.id
            WHERE e.model <> ? OR e.dims <> ?
            """,
            (model, dims),
        )
    con.commit()
    return con.execute("SELECT COUNT(*) FROM fact_embedding_jobs").fetchone()[0]


def drain(con, config, max_jobs):
    init_schema(con)
    model = str(config.get("model") or "").strip()
    dims = int(config.get("dims") or 0)
    batch_size = max(1, int(config.get("batch_size") or 32))
    if not model or not dims:
        raise WorkerError("embedding model / dimensions 未配置")

    rows = con.execute(
        """
        SELECT j.fact_id, f.fact, f.tags, e.content_hash AS existing_hash,
               e.model AS existing_model, e.dims AS existing_dims
        FROM fact_embedding_jobs j
        JOIN facts f ON f.id = j.fact_id
        LEFT JOIN fact_embeddings e ON e.fact_id = j.fact_id
        ORDER BY j.queued_at ASC
        LIMIT ?
        """,
        (max_jobs,),
    ).fetchall()

    candidates, skipped = [], 0
    for fact_id, fact, tags, existing_hash, existing_model, existing_dims in rows:
        text = text_for_embedding(fact, tags)
        digest = content_hash(text)
        if existing_hash == digest and existing_model == model and existing_dims == dims:
            con.execute("DELETE FROM fact_embedding_jobs WHERE fact_id = ?", (fact_id,))
            skipped += 1
            continue
        candidates.append({"id": fact_id, "text": text, "hash": digest})
    if skipped:
        con.commit()

    processed, failed = 0, 0
    for offset in range(0, len(candidates), batch_size):
        chunk = candidates[offset:offset + batch_size]
        try:
            vectors = embed_texts(config, [row["text"] for row in chunk])
        except Exception as err:
            failed += len(chunk)
            now = _utc_now()
            for row in chunk:
                con.execute(
                    """
                    UPDATE fact_embedding_jobs
                    SET attempts = attempts + 1, last_error = ?, queued_at = ?
                    WHERE fact_id = ?
                    """,
                    (str(err)[:400], now, row["id"]),
                )
            con.commit()
            log("嵌入失败：%s" % err)
            break
        now = _utc_now()
        for row, vector in zip(chunk, vectors):
            con.execute(
                """
                INSERT INTO fact_embeddings(fact_id, model, dims, vector, content_hash, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(fact_id) DO UPDATE SET
                  model = excluded.model,
                  dims = excluded.dims,
                  vector = excluded.vector,
                  content_hash = excluded.content_hash,
                  updated_at = excluded.updated_at
                """,
                (row["id"], model, dims, vector_to_blob(vector), row["hash"], now, now),
            )
            con.execute("DELETE FROM fact_embedding_jobs WHERE fact_id = ?", (row["id"],))
            processed += 1
        con.commit()

    remaining = con.execute("SELECT COUNT(*) FROM fact_embedding_jobs").fetchone()[0]
    total = con.execute("SELECT COUNT(*) FROM fact_embeddings").fetchone()[0]
    return {
        "queued": len(rows),
        "processed": processed,
        "skipped": skipped,
        "failed": failed,
        "remaining": remaining,
        "total_embeddings": total,
    }


def _utc_now():
    return time.strftime("%Y-%m-%dT%H:%M:%S", time.gmtime())


# ----------------------------------------------------------------- search --- #

def _weights(config, fusion):
    """按融合方式取默认权重，并允许 config 覆盖（调参用）。"""
    weights = dict(WEIGHTS_MINMAX if fusion == "minmax" else WEIGHTS_LINEAR)
    for key, cfg_key in (("semantic", "w_semantic"), ("fts", "w_fts"),
                         ("tag", "w_tag"), ("recency", "w_recency")):
        value = config.get(cfg_key)
        if value is None:
            continue
        try:
            weights[key] = float(value)
        except (TypeError, ValueError):
            continue
    return weights


def _minmax(values):
    """把一条通道的分数线性拉伸到 0-1（候选集内比较）。

    两个通道量纲不同时直接加权相加，等于让量纲大的那个说了算。
    本通道没有任何区分度（全同分/只有一个候选）时给中性值 0.5，
    不奖也不罚，把排序交给别的信号。
    """
    if not values:
        return {}
    lo = min(values.values())
    hi = max(values.values())
    if hi - lo < 1e-9:
        return {key: 0.5 for key in values}
    return {key: (value - lo) / (hi - lo) for key, value in values.items()}


def fts_candidates(con, query, limit):
    fts_query = build_fts_query(query)
    if not fts_query:
        return []
    try:
        rows = con.execute(
            """
            SELECT f.*, rank
            FROM facts_fts fts
            JOIN facts f ON f.id = fts.rowid
            WHERE facts_fts MATCH ?
            ORDER BY rank
            LIMIT ?
            """,
            (fts_query, limit),
        ).fetchall()
    except sqlite3.Error as err:
        log("FTS 查询失败(%s)，退回 LIKE" % err)
        rows = []
    if not rows and has_cjk(query):
        rows = con.execute(
            """
            SELECT *, 0 AS rank FROM facts
            WHERE fact LIKE '%' || ? || '%'
            ORDER BY time DESC, created_at DESC
            LIMIT ?
            """,
            (query, limit),
        ).fetchall()
    return rows


def vector_candidates(con, query_vector, limit, model, dims):
    rows = con.execute(
        """
        SELECT f.*, e.vector
        FROM fact_embeddings e
        JOIN facts f ON f.id = e.fact_id
        WHERE e.model = ? AND e.dims = ?
        """,
        (model, dims),
    ).fetchall()
    scored = []
    qv = query_vector
    for row in rows:
        vec = blob_to_vector(row["vector"])
        n = min(len(qv), len(vec))
        score = 0.0
        for i in range(n):
            score += qv[i] * vec[i]
        scored.append((score, row))
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[:limit], len(rows)


def parse_tags(raw):
    try:
        tags = json.loads(raw or "[]")
        return tags if isinstance(tags, list) else []
    except Exception:
        return []


def score_tags(fact_tags, query_tags):
    if not query_tags:
        return 0.0
    haystack = {normalize_text(t) for t in fact_tags}
    hits = sum(1 for t in query_tags if normalize_text(t) in haystack)
    return hits / len(query_tags)


def score_recency(raw_date):
    if not raw_date:
        return 0.0
    text = str(raw_date).strip().replace("Z", "")
    parsed = None
    for fmt, size in (("%Y-%m-%dT%H:%M:%S", 19), ("%Y-%m-%dT%H:%M", 16),
                      ("%Y-%m-%d %H:%M:%S", 19), ("%Y-%m-%d %H:%M", 16),
                      ("%Y-%m-%d", 10)):
        try:
            parsed = time.mktime(time.strptime(text[:size], fmt))
            break
        except Exception:
            continue
    if parsed is None:
        return 0.0
    days = max(0.0, (time.time() - parsed) / 86400.0)
    return pow(2.718281828459045, -days / 30.0)


def search(con, config, query, limit, tags):
    warnings = []
    fts_limit = int(config.get("fts_candidates") or 200)
    vec_limit = int(config.get("vector_candidates") or 80)
    model = str(config.get("model") or "").strip()
    dims = int(config.get("dims") or 0)

    fts_rows = fts_candidates(con, query, fts_limit)
    fts_scores = {}
    total = max(len(fts_rows), 1)
    for index, row in enumerate(fts_rows):
        fts_scores[row["id"]] = 1.0 - index / total

    semantic_scores = {}
    vec_considered = 0
    if model and dims and query.strip():
        try:
            query_vector = embed_texts(config, [query])[0]
            vec_rows, vec_considered = vector_candidates(con, query_vector, vec_limit, model, dims)
            for score, row in vec_rows:
                semantic_scores[row["id"]] = max(-1.0, min(1.0, score))
        except Exception as err:
            warnings.append("语义检索已跳过：%s" % err)
    elif not model or not dims:
        warnings.append("语义检索已跳过：embedding model/dimensions 未配置")

    merged = {}
    for row in fts_rows:
        merged[row["id"]] = row
    if semantic_scores:
        ids = list(semantic_scores.keys())
        placeholders = ",".join("?" for _ in ids)
        for row in con.execute("SELECT * FROM facts WHERE id IN (%s)" % placeholders, ids):
            merged.setdefault(row["id"], row)

    # 融合前的量纲对齐：语义只在 0.3~0.5 活动，关键词却铺满 0~1，
    # 直接相加等于让量纲大的那个说了算（2026-10-09 实测确认）。
    fusion = str(config.get("fusion") or "minmax").lower()
    sem_final, fts_final = semantic_scores, fts_scores
    if fusion == "minmax":
        ids = list(merged.keys())
        sem_final = _minmax({i: semantic_scores.get(i, 0.0) for i in ids})
        fts_final = _minmax({i: fts_scores.get(i, 0.0) for i in ids})

    weights = _weights(config, fusion)
    query_tags = [t for t in (tags or []) if isinstance(t, str)]
    results = []
    for fact_id, row in merged.items():
        fact_tags = parse_tags(row["tags"])
        semantic = semantic_scores.get(fact_id, 0.0)
        fts_score = fts_scores.get(fact_id, 0.0)
        tag_score = score_tags(fact_tags, query_tags)
        recency = score_recency(row["time"] or row["created_at"])
        sem_used = sem_final.get(fact_id, 0.0)
        fts_used = fts_final.get(fact_id, 0.0)
        score = (weights["semantic"] * sem_used + weights["fts"] * fts_used
                 + weights["tag"] * tag_score + weights["recency"] * recency)
        source = "hybrid" if semantic and fts_score else ("vector" if semantic else "fts")
        results.append({
            "id": fact_id,
            "fact": row["fact"],
            "tags": fact_tags,
            "time": row["time"],
            "session_id": row["session_id"],
            "created_at": row["created_at"],
            "score": round(score, 6),
            "semanticScore": round(semantic, 6),
            "ftsScore": round(fts_score, 6),
            "semNorm": round(sem_used, 6),
            "ftsNorm": round(fts_used, 6),
            "tagScore": round(tag_score, 6),
            "recencyScore": round(recency, 6),
            "source": source,
        })
    results.sort(key=lambda item: item["score"], reverse=True)

    stale = con.execute(
        "SELECT COUNT(*) FROM fact_embeddings WHERE model <> ? OR dims <> ?", (model, dims)
    ).fetchone()[0] if model and dims else 0
    if stale:
        warnings.append("有 %d 条向量属于旧模型，跑一次补全即可重建" % stale)

    return {
        "results": results[:limit],
        "warnings": warnings,
        "vector_pool": vec_considered,
        "fts_pool": len(fts_rows),
    }


# ---------------------------------------------------------------- reports --- #

def db_stats(con, config):
    model = str(config.get("model") or "").strip()
    dims = int(config.get("dims") or 0)
    facts = con.execute("SELECT COUNT(*) FROM facts").fetchone()[0]
    embeddings = con.execute("SELECT COUNT(*) FROM fact_embeddings").fetchone()[0]
    pending = con.execute("SELECT COUNT(*) FROM fact_embedding_jobs").fetchone()[0]
    failed = con.execute(
        "SELECT COUNT(*) FROM fact_embedding_jobs WHERE COALESCE(last_error,'') <> ''"
    ).fetchone()[0]
    models = [
        {"model": row[0], "dims": row[1], "count": row[2]}
        for row in con.execute(
            "SELECT model, dims, COUNT(*) FROM fact_embeddings GROUP BY model, dims ORDER BY 3 DESC"
        )
    ]
    stale = con.execute(
        "SELECT COUNT(*) FROM fact_embeddings WHERE model <> ? OR dims <> ?", (model, dims)
    ).fetchone()[0] if model and dims else 0
    return {
        "facts": facts,
        "embeddings": embeddings,
        "missing": max(0, facts - embeddings),
        "pending_jobs": pending,
        "failed_jobs": failed,
        "coverage": (embeddings / facts) if facts else 1.0,
        "models": models,
        "stale_model_rows": stale,
    }


def cmd_agents(req):
    home = req.get("home")
    config = req.get("config") or {}
    out = []
    for agent, db in list_agents(home):
        try:
            con = open_db(db)
            if not has_table(con, "fact_embeddings"):
                init_schema(con)
            stats = db_stats(con, config)
            con.close()
            stats["agent"] = agent
            stats["db"] = db
            out.append(stats)
        except Exception as err:
            out.append({"agent": agent, "db": db, "error": str(err)})
    return {"agents": out}


def cmd_status(req):
    con = open_db(resolve_db(req))
    try:
        init_schema(con)
        stats = db_stats(con, req.get("config") or {})
        recent = [
            {"id": row[0], "fact": row[1], "created_at": row[2]}
            for row in con.execute(
                "SELECT id, fact, created_at FROM facts ORDER BY created_at DESC, id DESC LIMIT 5"
            )
        ]
        stats["recent"] = recent
        return stats
    finally:
        con.close()


def cmd_search(req):
    con = open_db(resolve_db(req), read_only=True)
    try:
        return search(con, req.get("config") or {}, str(req.get("query") or ""),
                      int(req.get("limit") or 10), req.get("tags") or [])
    finally:
        con.close()


def cmd_backfill(req):
    con = open_db(resolve_db(req))
    try:
        config = req.get("config") or {}
        pending = queue_missing(con, config)
        result = drain(con, config, int(req.get("limit") or 500))
        result["pending_after_queue"] = pending
        result["stats"] = db_stats(con, config)
        return result
    finally:
        con.close()


# ------------------------------------------------------------- 模型体检 --- #

PROBE_PARAPHRASE = [
    ("用户喜欢喝什么", "用户爱喝什么饮料"),
    ("今天股市怎么样", "A 股行情如何"),
    ("苹果手机电池续航", "iPhone 电量能用多久"),
]
PROBE_UNRELATED = [
    ("用户喜欢喝什么", "苹果手机电池续航"),
    ("用户喜欢喝什么", "今天股市怎么样"),
    ("苹果手机电池续航", "今天股市怎么样"),
]


def cmd_probe(req):
    """量一下当前 embedding 模型对中文到底有没有区分度。

    取几组「改写句对」和「无关句对」，看改写相似度是否明显高于无关相似度。
    只支持英文的模型（比如 nomic-embed-text-v1.5）会把不同中文句子压成近乎同一个
    向量，这时候语义通道不只是弱，还会主动误导排序。
    """
    config = req.get("config") or {}
    texts = sorted({t for pair in PROBE_PARAPHRASE + PROBE_UNRELATED for t in pair})
    vectors = embed_texts(config, texts)
    index = {text: vector for text, vector in zip(texts, vectors)}

    def sim(a, b):
        va, vb = index[a], index[b]
        return sum(x * y for x, y in zip(va, vb))

    para = [sim(a, b) for a, b in PROBE_PARAPHRASE]
    unrel = [sim(a, b) for a, b in PROBE_UNRELATED]
    all_pairs = [sim(a, b) for i, a in enumerate(texts) for b in texts[i + 1:]]
    identical = sum(1 for value in all_pairs if value >= 0.9999)
    avg_para = sum(para) / len(para)
    avg_unrel = sum(unrel) / len(unrel)
    gap = avg_para - avg_unrel

    if identical:
        verdict = "bad"
        advice = "有 %d 对不同句子拿到几乎相同的向量：这个模型基本无法区分中文，建议换成 bge-m3 或 Qwen3-Embedding。" % identical
    elif gap < 0.10:
        verdict = "weak"
        advice = "改写句与无关句的相似度几乎没拉开（差 %.3f）：中文区分度偏弱，建议换多语言嵌入模型。" % gap
    else:
        verdict = "ok"
        advice = "中文区分度正常。"

    return {
        "provider": config.get("base_url"),
        "model": config.get("model"),
        "dims": config.get("dims"),
        "paraphrase_sims": [round(v, 4) for v in para],
        "unrelated_sims": [round(v, 4) for v in unrel],
        "avg_paraphrase": round(avg_para, 4),
        "avg_unrelated": round(avg_unrel, 4),
        "gap": round(gap, 4),
        "identical_pairs": identical,
        "verdict": verdict,
        "advice": advice,
    }


def cmd_maintain(req):
    """扫描所有 agent 库，缺什么补什么。这是后台定时器真正调用的入口。"""
    home = req.get("home")
    config = req.get("config") or {}
    limit = int(req.get("limit") or 200)
    report = []
    for agent, db in list_agents(home):
        entry = {"agent": agent}
        try:
            con = open_db(db)
            try:
                pending = queue_missing(con, config)
                if pending:
                    entry.update(drain(con, config, limit))
                entry["pending"] = pending
                entry["stats"] = db_stats(con, config)
            finally:
                con.close()
        except Exception as err:
            entry["error"] = str(err)
        report.append(entry)
    return {"agents": report, "ts": _utc_now()}


COMMANDS = {
    "agents": cmd_agents,
    "status": cmd_status,
    "search": cmd_search,
    "backfill": cmd_backfill,
    "maintain": cmd_maintain,
    "probe": cmd_probe,
    "ping": lambda req: {"pong": True, "python": sys.version.split()[0]},
}


def main():
    raw = sys.stdin.read()
    try:
        req = json.loads(raw or "{}")
    except Exception as err:
        print(json.dumps({"ok": False, "error": "请求不是合法 JSON：%s" % err}, ensure_ascii=False))
        return
    cmd = req.get("cmd")
    handler = COMMANDS.get(cmd)
    if handler is None:
        print(json.dumps({"ok": False, "error": "未知命令：%s" % cmd}, ensure_ascii=False))
        return
    try:
        result = handler(req)
        payload = {"ok": True}
        payload.update(result if isinstance(result, dict) else {"result": result})
        print(json.dumps(payload, ensure_ascii=False))
    except Exception as err:
        log("命令 %s 失败：%s" % (cmd, err))
        print(json.dumps({"ok": False, "error": str(err), "cmd": cmd}, ensure_ascii=False))


if __name__ == "__main__":
    main()
