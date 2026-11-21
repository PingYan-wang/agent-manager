#!/usr/bin/env python3
"""agent-bridge: 跨 Agent 会话读取 MCP server (stdio, newline-delimited JSON-RPC).

让任意接入 MCPHub 的 Agent 都能列出/读取本机其他 Agent 的会话记录。
数据源(只读):
  hermes   -> ~/.hermes/state.db (sessions + messages)
  devin    -> ~/.local/share/devin/cli/summaries/history_*.md
  codex    -> ~/.codex/state_5.sqlite threads(+rollout 文件,目前为空)
  workbuddy-> ~/.workbuddy/tasks/*/*.json (任务元数据,非完整对话)
"""
import json, os, sys, glob, sqlite3, time
from pathlib import Path

HOME = Path.home()
MAX_CHARS = 30000

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

def codex_list(limit):
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

def codex_read(cid, max_chars):
    p = HOME / ".codex/state_5.sqlite"
    if not p.exists():
        return None
    db = _ro_db(p)
    try:
        row = db.execute("select rollout_path, title, preview from threads where id=?", (cid,)).fetchone()
    except sqlite3.Error:
        row = None
    db.close()
    if not row:
        return None
    rollout, title, preview = row
    out = [f"# codex thread {cid}\n{title or ''}\n\n"]
    rp = Path(rollout) if rollout else None
    if rp and rp.exists():
        # rollout jsonl: 逐行提取 payload 文本
        try:
            for line in rp.read_text(errors="replace").splitlines():
                try:
                    obj = json.loads(line)
                except Exception:
                    continue
                s = json.dumps(obj, ensure_ascii=False)
                out.append(s[:2000] + "\n")
        except Exception as e:
            out.append(f"[rollout read error: {e}]")
    else:
        out.append(f"[无 rollout 文件; preview: {preview or ''}]")
    return _truncate("".join(out), max_chars)

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

ADAPTERS = {
    "hermes":    {"name": "Hermes",    "list": hermes_list,    "read": hermes_read,
                  "note": "~/.hermes/state.db 完整会话+消息"},
    "devin":     {"name": "Devin",     "list": devin_list,     "read": devin_read,
                  "note": "CLI 会话摘要/历史导出 (summaries/*.md)"},
    "codex":     {"name": "Codex",     "list": codex_list,     "read": codex_read,
                  "note": "state_5.sqlite threads; 本机暂无记录时为空"},
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
             "description": "列出本机有会话记录可读的 Agent 及数据源说明",
             "inputSchema": {"type": "object", "properties": {}}},
            {"name": "conversations_list",
             "description": "列出某个 Agent 的最近会话(id/标题/时间)。agent: hermes|devin|codex|workbuddy",
             "inputSchema": {"type": "object", "properties": {
                 "agent": {"type": "string"}, "limit": {"type": "integer", "default": 20}},
                 "required": ["agent"]}},
            {"name": "conversation_read",
             "description": "读取某个 Agent 的会话内容。agent 同上; id 来自 conversations_list,支持前缀匹配",
             "inputSchema": {"type": "object", "properties": {
                 "agent": {"type": "string"}, "id": {"type": "string"},
                 "max_chars": {"type": "integer", "default": MAX_CHARS}},
                 "required": ["agent", "id"]}},
        ]}
    if method == "tools/call":
        name, args = params.get("name"), params.get("arguments") or {}
        try:
            if name == "agents_list":
                data = {k: {"name": v["name"], "note": v["note"]} for k, v in ADAPTERS.items()}
                data.update({k: {"name": k, "note": "unsupported: " + v} for k, v in UNSUPPORTED.items()})
                return _text(json.dumps(data, ensure_ascii=False, indent=2))
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
