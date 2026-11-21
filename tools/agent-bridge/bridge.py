#!/usr/bin/env python3
"""agent-bridge: 跨 Agent 会话读取 + 共享记忆 MCP server (stdio, newline-delimited JSON-RPC).

让任意接入 MCPHub 的 Agent 都能列出/读取/搜索本机其他 Agent 的会话记录，
并通过共享记忆文件在 Agent 之间传递结论（记忆继承）。
数据源(只读):
  hermes   -> ~/.hermes/state.db (sessions + messages)
  devin    -> ~/.local/share/devin/cli/summaries/history_*.md
  codex    -> ~/.codex/state_5.sqlite threads(+rollout 文件,目前为空)
  workbuddy-> ~/.workbuddy/tasks/*/*.json (任务元数据,非完整对话)
共享记忆:   ~/.agent-manager/memory.jsonl (memory_save/memory_search 读写)
"""
import json, os, sys, glob, sqlite3, time
from pathlib import Path

HOME = Path.home()
MAX_CHARS = 30000
MEMORY_FILE = HOME / ".agent-manager" / "memory.jsonl"
MEMORY_MAX_CONTENT = 8000
MEMORY_READ_TAIL = 4000  # 只读末尾 N 行，控制开销

def _ro_db(path):
    return sqlite3.connect(f"file:{path}?mode=ro", uri=True)

# ---------- adapters: list / read ----------

def hermes_list(limit):
    db = _ro_db(HOME / ".hermes/state.db")
    try:
        rows = db.execute(
            "select id, coalesce(title, display_name, session_key), started_at, last_activity_at, message_count "
            "from sessions where archived=0 order by last_activity_at desc limit ?", (limit,)).fetchall()
    finally:
        db.close()
    return [{"id": r[0], "title": r[1] or r[0][:24], "started_at": r[2], "last_activity_at": r[3],
             "messages": r[4]} for r in rows]

def hermes_read(cid, max_chars):
    db = _ro_db(HOME / ".hermes/state.db")
    try:
        msgs = db.execute(
            "select role, content, timestamp from messages where session_id=? order by id", (cid,)).fetchall()
    finally:
        db.close()
    if not msgs:
        return None
    out = [f"# hermes session {cid}\n"]
    for role, content, ts in msgs:
        out.append(f"\n=== {role} @{ts} ===\n{content or ''}")
    return _truncate("".join(out), max_chars)

def devin_list(limit):
    d = HOME / ".local/share/devin/cli/summaries"
    files = sorted(d.glob("history_*.md"), key=lambda p: p.stat().st_mtime, reverse=True)[:limit]
    res = []
    for f in files:
        title = ""
        try:
            with open(f, errors="replace") as fh:
                for line in fh:
                    line = line.strip()
                    if line and not line.startswith("==="):
                        title = line[:80]; break
        except Exception:
            pass
        res.append({"id": f.stem, "title": title or f.stem, "mtime": f.stat().st_mtime})
    return res

def devin_read(cid, max_chars):
    f = HOME / ".local/share/devin/cli/summaries" / f"{cid}.md"
    if not f.exists() or not str(cid).startswith("history_"):
        return None
    return _truncate(f.read_text(errors="replace"), max_chars)

CODEX_SESSIONS = HOME / ".codex" / "sessions"

def _codex_rollouts():
    return sorted(glob.glob(str(CODEX_SESSIONS / "**" / "rollout-*.jsonl"), recursive=True),
                  key=lambda p: os.path.getmtime(p), reverse=True)

def _codex_meta(path, max_lines=60):
    """读 rollout 前 N 行，提取 session_meta 与首条 user 消息作标题。"""
    meta, title = {}, ""
    try:
        with open(path, errors="replace") as fh:
            for i, line in enumerate(fh):
                if i >= max_lines:
                    break
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                p = obj.get("payload") or {}
                if obj.get("type") == "session_meta" and not meta:
                    meta = p
                if p.get("type") == "message" and p.get("role") == "user" and not title:
                    for c in p.get("content") or []:
                        t = c.get("text") or ""
                        if t and not t.startswith("<"):
                            title = t.strip().replace("\n", " ")[:80]
                            break
                if meta and title:
                    break
    except Exception:
        pass
    return meta, title

def codex_list(limit):
    res = []
    # 优先 rollout 文件（真实会话），state_5.sqlite threads 表可能为空
    for f in _codex_rollouts()[:limit * 2]:
        if len(res) >= limit:
            break
        meta, title = _codex_meta(f)
        sid = meta.get("session_id") or meta.get("id") or Path(f).stem
        res.append({"id": sid, "title": title or sid[:24], "file": f,
                    "cwd": meta.get("cwd"), "mtime": os.path.getmtime(f)})
    if res:
        return res
    p = HOME / ".codex/state_5.sqlite"
    if not p.exists():
        return []
    db = _ro_db(p)
    try:
        rows = db.execute(
            "select id, coalesce(title, name, preview, first_user_message, id), created_at, updated_at, model "
            "from threads where archived=0 order by updated_at desc limit ?", (limit,)).fetchall()
    except sqlite3.Error:
        rows = []
    db.close()
    return [{"id": r[0], "title": (r[1] or r[0])[:80], "created_at": r[2], "updated_at": r[3], "model": r[4]} for r in rows]

def _codex_read_rollout(path, max_chars):
    out = []
    try:
        with open(path, errors="replace") as fh:
            for line in fh:
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                p = obj.get("payload") or {}
                if p.get("type") != "message" or p.get("role") not in ("user", "assistant"):
                    continue
                texts = [c.get("text", "") for c in p.get("content") or [] if isinstance(c, dict)]
                body = "\n".join(t for t in texts if t).strip()
                if not body:
                    continue
                out.append(f"\n=== {p['role']} ===\n{body[:4000]}")
    except Exception as e:
        return f"[rollout read error: {e}]"
    return _truncate("".join(out) or "[无消息内容]", max_chars)

def codex_read(cid, max_chars):
    # rollout 文件名含 session_id；按 id 匹配文件名或 session_meta
    for f in _codex_rollouts():
        if cid in f:
            return _codex_read_rollout(f, max_chars)
    # threads 表回退
    p = HOME / ".codex/state_5.sqlite"
    if p.exists():
        db = _ro_db(p)
        try:
            row = db.execute("select rollout_path, title, preview from threads where id=?", (cid,)).fetchone()
        except sqlite3.Error:
            row = None
        db.close()
        if row:
            rollout, title, preview = row
            rp = Path(rollout) if rollout else None
            if rp and rp.exists():
                return _codex_read_rollout(str(rp), max_chars)
            return _truncate(f"# codex thread {cid}\n{title or ''}\n\n[无 rollout 文件; preview: {preview or ''}]", max_chars)
    # session_id 形式的 id：在所有 rollout 的 meta 中找
    for f in _codex_rollouts()[:200]:
        meta, _ = _codex_meta(f, max_lines=5)
        if (meta.get("session_id") or meta.get("id")) == cid:
            return _codex_read_rollout(f, max_chars)
    return None

def workbuddy_list(limit):
    res = []
    for f in sorted(glob.glob(str(HOME / ".workbuddy/tasks/*/*.json")),
                    key=lambda p: os.path.getmtime(p), reverse=True)[:limit]:
        try:
            d = json.load(open(f))
        except Exception:
            continue
        res.append({"id": f"{Path(f).parent.name}:{d.get('id', Path(f).stem)}",
                    "title": d.get("subject") or d.get("description", "")[:60],
                    "status": d.get("status"), "mtime": os.path.getmtime(f)})
    return res

def workbuddy_read(cid, max_chars):
    # cid 形如 <taskdir>:<id> 或直接文件名匹配
    hits = []
    for f in glob.glob(str(HOME / ".workbuddy/tasks/*/*.json")):
        if cid in f or Path(f).stem == cid.split(":")[-1]:
            hits.append(f)
    if not hits:
        return None
    out = []
    for f in hits[:3]:
        try:
            out.append(f"# {f}\n" + json.dumps(json.load(open(f)), ensure_ascii=False, indent=2))
        except Exception:
            pass
    return _truncate("\n\n".join(out) or None, max_chars)

def _snippet(text, q, span=80):
    i = text.lower().find(q.lower())
    if i < 0:
        return text[:span * 2]
    s = max(0, i - span)
    return ("…" if s else "") + text[s:i + len(q) + span].replace("\n", " ") + ("…" if i + len(q) + span < len(text) else "")

# ---------- adapters: search ----------

def _like_pat(q):
    return "%" + q.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_") + "%"

def hermes_search(query, limit):
    db = _ro_db(HOME / ".hermes/state.db")
    try:
        pat = _like_pat(query)
        rows = db.execute(
            "select m.session_id, coalesce(s.title, s.display_name, s.session_key), count(*), max(m.timestamp) "
            "from messages m join sessions s on s.id = m.session_id "
            "where m.content like ? escape '\\' or coalesce(s.title,'') like ? escape '\\' "
            "   or coalesce(s.display_name,'') like ? escape '\\' "
            "group by m.session_id order by max(m.timestamp) desc limit ?",
            (pat, pat, pat, limit)).fetchall()
    finally:
        db.close()
    return [{"id": r[0], "title": r[1] or r[0][:24], "matches": r[2], "last_at": r[3]} for r in rows]

def devin_search(query, limit):
    res = []
    for f in sorted(glob.glob(str(HOME / ".local/share/devin/cli/summaries/history_*.md")),
                    key=lambda p: os.path.getmtime(p), reverse=True):
        if len(res) >= limit:
            break
        try:
            text = open(f, errors="replace").read()
        except Exception:
            continue
        if query.lower() not in text.lower():
            continue
        title = ""
        for line in text.splitlines():
            line = line.strip()
            if line and not line.startswith("==="):
                title = line[:80]; break
        res.append({"id": f.split("/")[-1][:-3], "title": title or f, "matches": text.lower().count(query.lower()),
                    "snippet": _snippet(text, query), "mtime": os.path.getmtime(f)})
    return res

def codex_search(query, limit):
    res = []
    q = query.lower()
    for f in _codex_rollouts():
        if len(res) >= limit:
            break
        try:
            text = open(f, errors="replace").read()
        except Exception:
            continue
        if q not in text.lower():
            continue
        meta, title = _codex_meta(f)
        res.append({"id": meta.get("session_id") or meta.get("id") or Path(f).stem,
                    "title": title or Path(f).stem[:24], "file": f,
                    "snippet": _snippet(text, query), "mtime": os.path.getmtime(f)})
    if res:
        return res
    p = HOME / ".codex/state_5.sqlite"
    if not p.exists():
        return []
    db = _ro_db(p)
    try:
        pat = _like_pat(query)
        rows = db.execute(
            "select id, coalesce(title, name, preview, first_user_message, id), updated_at, coalesce(preview,'') "
            "from threads where archived=0 and (coalesce(title,'') like ? escape '\\' or coalesce(preview,'') like ? escape '\\' "
            "or coalesce(name,'') like ? escape '\\' or coalesce(first_user_message,'') like ? escape '\\') "
            "order by updated_at desc limit ?", (pat, pat, pat, pat, limit)).fetchall()
    except sqlite3.Error:
        rows = []
    db.close()
    return [{"id": r[0], "title": (r[1] or r[0])[:80], "updated_at": r[2], "snippet": _snippet(r[3] or "", query)} for r in rows]

def workbuddy_search(query, limit):
    res = []
    q = query.lower()
    for f in sorted(glob.glob(str(HOME / ".workbuddy/tasks/*/*.json")),
                    key=lambda p: os.path.getmtime(p), reverse=True):
        if len(res) >= limit:
            break
        try:
            d = json.load(open(f))
        except Exception:
            continue
        hay = json.dumps(d, ensure_ascii=False)
        if q not in hay.lower():
            continue
        res.append({"id": f"{Path(f).parent.name}:{d.get('id', Path(f).stem)}",
                    "title": d.get("subject") or str(d.get("description", ""))[:60],
                    "status": d.get("status"), "snippet": _snippet(hay, query), "mtime": os.path.getmtime(f)})
    return res

SEARCH_FNS = {"hermes": hermes_search, "devin": devin_search, "codex": codex_search, "workbuddy": workbuddy_search}

# ---------- shared memory ----------

def _memory_append(entry):
    MEMORY_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(MEMORY_FILE, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")

def _memory_tail(n=MEMORY_READ_TAIL):
    try:
        with open(MEMORY_FILE, encoding="utf-8", errors="replace") as fh:
            return fh.readlines()[-n:]
    except Exception:
        return []

def memory_save(args):
    agent = str(args.get("agent") or "unknown")[:40]
    title = str(args.get("title") or "")[:200]
    content = str(args.get("content") or "")[:MEMORY_MAX_CONTENT]
    tags = [str(t)[:40] for t in (args.get("tags") or [])][:10] if isinstance(args.get("tags"), list) else []
    if not content.strip():
        return _err("content 不能为空")
    entry = {"ts": time.time(), "agent": agent, "title": title, "content": content, "tags": tags}
    _memory_append(entry)
    return _text(json.dumps({"ok": True, "saved": True, "agent": agent, "title": title}, ensure_ascii=False))

def memory_search(args):
    query = str(args.get("query") or "").strip()
    if not query:
        return _err("query 不能为空")
    agent = args.get("agent")
    limit = int(args.get("limit", 10))
    q = query.lower()
    hits = []
    for line in reversed(_memory_tail()):
        try:
            e = json.loads(line)
        except Exception:
            continue
        if agent and e.get("agent") != agent:
            continue
        hay = (e.get("title", "") + " " + e.get("content", "") + " " + " ".join(e.get("tags") or [])).lower()
        if q in hay:
            hits.append(e)
            if len(hits) >= limit:
                break
    return _text(json.dumps(hits, ensure_ascii=False, indent=2))

ADAPTERS = {
    "hermes":    {"name": "Hermes",    "list": hermes_list,    "read": hermes_read,
                  "note": "~/.hermes/state.db 完整会话+消息"},
    "devin":     {"name": "Devin",     "list": devin_list,     "read": devin_read,
                  "note": "CLI 会话摘要/历史导出 (summaries/*.md)"},
    "codex":     {"name": "Codex",     "list": codex_list,     "read": codex_read,
                  "note": "~/.codex/sessions/**/rollout-*.jsonl 会话文件（state_5.sqlite 为辅）"},
    "workbuddy": {"name": "WorkBuddy", "list": workbuddy_list, "read": workbuddy_read,
                  "note": "任务元数据(tasks/*.json)，非完整对话流"},
}
UNSUPPORTED = {"claude": "未发现本地会话存储", "cursor": "未发现本地会话存储",
               "windsurf": "未发现本地会话存储", "gemini": "未发现本地会话存储"}

def _truncate(text, max_chars):
    if not text:
        return None
    if len(text) <= max_chars:
        return text
    return text[:max_chars] + f"\n\n...[已截断, 共 {len(text)} 字符]"

def _find_conv(agent, cid):
    ad = ADAPTERS[agent]
    lst = ad["list"](200)
    if any(c["id"] == cid for c in lst):
        return cid
    pref = [c["id"] for c in lst if c["id"].startswith(cid)]
    return pref[0] if pref else (lst[0]["id"] if lst and len(lst) == 1 else None)

def dispatch(method, params):
    if method == "initialize":
        return {"protocolVersion": params.get("protocolVersion", "2024-11-05")
                if isinstance(params, dict) else "2024-11-05",
                "capabilities": {"tools": {}},
                "serverInfo": {"name": "agent-bridge", "version": "1.0.0"}}
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": [
            {"name": "agents_list",
             "description": "【触发条件】用户提到其他 Agent、其他项目、之前的对话或历史工作，或你拿不准上下文来源时，先调用本工具了解本机有哪些 Agent 留下了可读的会话记录，再决定用 conversations_search/conversation_read 继承上下文，避免从零重复劳动",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "conversations_list",
             "description": "【触发条件】已知要查某个 Agent 的历史会话列表时使用（如用户说「看看 Devin 上次聊了什么」）。agent: hermes|devin|codex|workbuddy。不确定关键词在哪个会话时改用 conversations_search",
             "inputSchema": {"type": "object", "properties": {
                 "agent": {"type": "string"}, "limit": {"type": "integer", "default": 20}},
                 "required": ["agent"]}},
            {"name": "conversation_read",
             "description": "【触发条件】conversations_search/list 已定位到目标会话后，用它读取完整上下文再继续工作。支持前缀匹配 id",
             "inputSchema": {"type": "object", "properties": {
                 "agent": {"type": "string"}, "id": {"type": "string"},
                 "max_chars": {"type": "integer", "default": MAX_CHARS}},
                 "required": ["agent", "id"]}},
            {"name": "conversations_search",
             "description": "【触发条件·最常用】用户提到其他 Agent 做过的事、其他项目、某个目录/仓库的来历、之前的方案或结论，或任务需要复用他人工作时——先用本工具按关键词搜遍全部 Agent 会话，命中后再 conversation_read 细读。这是记忆继承的第一入口，不要直接去文件系统里猜",
             "inputSchema": {"type": "object", "properties": {
                 "query": {"type": "string"}, "agent": {"type": "string"},
                 "limit": {"type": "integer", "default": 10}},
                 "required": ["query"]}},
            {"name": "memory_save",
             "description": "【触发条件】完成有价值的排查/配置/结论后，把可复用的结论写入共享记忆库，供其他 Agent 或你自己的未来会话检索。一次任务只需沉淀一次",
             "inputSchema": {"type": "object", "properties": {
                 "agent": {"type": "string", "description": "写入方 Agent 名"},
                 "title": {"type": "string"}, "content": {"type": "string"},
                 "tags": {"type": "array", "items": {"type": "string"}}},
                 "required": ["agent", "content"]}},
            {"name": "memory_search",
             "description": "【触发条件】conversations_search 没命中、或想找更早沉淀的结论/笔记时使用。会话存原始记录，记忆库存提炼后的结论，两者配合",
             "inputSchema": {"type": "object", "properties": {
                 "query": {"type": "string"}, "agent": {"type": "string"},
                 "limit": {"type": "integer", "default": 10}},
                 "required": ["query"]}},
        ]}
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            if name == "agents_list":
                data = {k: {"name": v["name"], "note": v["note"]} for k, v in ADAPTERS.items()}
                data.update({k: {"name": k, "note": "unsupported: " + v} for k, v in UNSUPPORTED.items()})
                return _text(json.dumps(data, ensure_ascii=False, indent=2))
            if name == "conversations_search":
                query = str(args.get("query") or "").strip()
                if not query:
                    return _err("query 不能为空")
                agent = args.get("agent") or ""
                limit = int(args.get("limit", 10))
                targets = [agent] if agent in SEARCH_FNS else list(SEARCH_FNS)
                if agent and agent not in SEARCH_FNS:
                    return _err(f"未知 agent '{agent}'。可搜: {', '.join(SEARCH_FNS)}")
                merged = []
                for ag in targets:
                    for hit in SEARCH_FNS[ag](query, limit):
                        hit["agent"] = ag
                        merged.append(hit)
                merged.sort(key=lambda h: h.get("last_at") or h.get("updated_at") or h.get("mtime") or 0, reverse=True)
                return _text(json.dumps(merged[:limit], ensure_ascii=False, indent=2))
            if name == "memory_save":
                return memory_save(args)
            if name == "memory_search":
                return memory_search(args)
            agent = args.get("agent", "")
            if agent not in ADAPTERS:
                return _err(f"未知 agent '{agent}'。可用: {', '.join(ADAPTERS)}")
            ad = ADAPTERS[agent]
            if name == "conversations_list":
                return _text(json.dumps(ad["list"](int(args.get("limit", 20))), ensure_ascii=False, indent=2))
            if name == "conversation_read":
                cid = _find_conv(agent, args.get("id", ""))
                if not cid:
                    return _err(f"agent '{agent}' 下找不到会话 '{args.get('id')}'")
                content = ad["read"](cid, int(args.get("max_chars", MAX_CHARS)))
                if content is None:
                    return _err(f"会话 '{cid}' 无内容或无法读取")
                return _text(content)
            return _err(f"unknown tool: {name}")
        except Exception as e:
            return _err(f"{type(e).__name__}: {e}")
    return None

def _text(t):
    return {"content": [{"type": "text", "text": t}]}

def _err(t):
    return {"content": [{"type": "text", "text": t}], "isError": True}

def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            msg = json.loads(line)
        except Exception:
            continue
        mid, method, params = msg.get("id"), msg.get("method"), msg.get("params") or {}
        if method and method.startswith("notifications/"):
            continue
        result = dispatch(method, params)
        if result is not None and mid is not None:
            sys.stdout.write(json.dumps({"jsonrpc": "2.0", "id": mid, "result": result}, ensure_ascii=False) + "\n")
            sys.stdout.flush()

if __name__ == "__main__":
    main()
