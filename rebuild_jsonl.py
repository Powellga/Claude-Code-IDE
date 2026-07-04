"""Rebuild a pruned Claude Code transcript (.jsonl) from the IDE's saved session.

The IDE stores raw PTY output (raw_transcript) for every session. Claude Code's
own structured .jsonl transcripts get pruned by cleanupPeriodDays retention, which
breaks --resume. This reconstructs a valid, loadable .jsonl from the richest IDE
snapshot for a given claude_session_id so the session becomes resumable again.

The reconstruction is a TEXT approximation: the original structured tool_use/
tool_result blocks were never in the PTY stream, so the prior conversation is
injected as readable context, not byte-identical records.

Usage:
    python rebuild_jsonl.py <uuid-prefix>          # rebuild one session
    python rebuild_jsonl.py <uuid-prefix> --force  # overwrite if .jsonl exists
"""
import json, glob, os, re, sys, uuid as uuidlib

HOME = os.path.expanduser("~")
PROJ = os.path.join(HOME, ".claude", "projects")
DATA = os.path.join(os.path.dirname(os.path.abspath(__file__)), "data")
CLI_VERSION = "2.1.156"


def encode_workdir(p):
    return re.sub(r"[^a-zA-Z0-9]", "-", p)


def clean_transcript(raw):
    """Render raw PTY output to readable text (mirrors app.py _clean_transcript)."""
    import pyte
    screen = pyte.HistoryScreen(120, 50, history=300000)
    stream = pyte.Stream(screen)
    stream.feed(raw)
    lines = []
    for hl in screen.history.top:
        lines.append("".join(hl[c].data if c in hl else " " for c in range(120)).rstrip())
    for row in screen.display:
        lines.append(row.rstrip())
    text = "\n".join(lines)
    text = re.sub(r"\n{4,}", "\n\n\n", text)
    return text.strip()


def strip_chrome(text):
    """Remove TUI chrome that adds no conversational value."""
    out = []
    for ln in text.split("\n"):
        s = ln.strip()
        if not s:
            out.append("")
            continue
        # banner / box-drawing rules / footer chrome
        if re.fullmatch(r"[─━▀-▟▖-▟ ─]+", s):
            continue
        if s.startswith(("▐", "▝", "▘")):
            continue
        if "bypass permissions on" in s or "/clear to save" in s:
            continue
        if re.fullmatch(r">\s*", s):  # empty prompt box
            continue
        out.append(ln)
    cleaned = "\n".join(out)
    return re.sub(r"\n{3,}", "\n\n", cleaned).strip()


def find_richest_snapshot(uuid_prefix):
    best = None
    for f in glob.glob(os.path.join(DATA, "projects", "*", "sessions", "*.json")) + \
             glob.glob(os.path.join(DATA, "unsorted_sessions", "*.json")):
        try:
            d = json.load(open(f, encoding="utf-8"))
        except Exception:
            continue
        if (d.get("claude_session_id") or "").startswith(uuid_prefix):
            rt = d.get("raw_transcript", "") or ""
            if not best or len(rt) > len(best[1].get("raw_transcript", "") or ""):
                best = (f, d)
    return best


def build_records(sid, cwd, body, git_branch="master"):
    def nid():
        return str(uuidlib.uuid4())
    recs = []
    recs.append({"type": "mode", "mode": "normal", "sessionId": sid})
    recs.append({"type": "permission-mode", "permissionMode": "bypassPermissions", "sessionId": sid})
    base = {"isSidechain": False, "userType": "external", "entrypoint": "cli",
            "cwd": cwd, "sessionId": sid, "version": CLI_VERSION, "gitBranch": git_branch}
    u_uuid = nid()
    user_text = (
        "[SESSION RECOVERY] The structured transcript for this session was deleted by "
        "Claude Code's cleanupPeriodDays retention. Below is a reconstructed text record "
        "of our prior conversation, recovered from the IDE's saved raw output. Tool calls "
        "and their outputs appear as the terminal rendered them (some collapsed/summarized); "
        "file contents read or edited during the session are not all captured. Please treat "
        "everything below as the prior context of THIS session and continue from where we "
        "left off.\n\n===== RECONSTRUCTED TRANSCRIPT =====\n\n" + body +
        "\n\n===== END RECONSTRUCTED TRANSCRIPT =====\n\n(Ready to continue.)"
    )
    recs.append({**base, "parentUuid": None, "promptId": nid(), "type": "user",
                 "message": {"role": "user", "content": user_text},
                 "uuid": u_uuid, "timestamp": "2026-01-01T00:00:00.000Z"})
    a_uuid = nid()
    recs.append({**base, "parentUuid": u_uuid, "type": "assistant",
                 "requestId": "req_reconstructed",
                 "message": {"model": "claude-opus-4-8", "id": "msg_reconstructed",
                             "type": "message", "role": "assistant",
                             "content": [{"type": "text", "text":
                                "I've reviewed the reconstructed transcript of our prior session above. "
                                "I understand the context and where we left off. What would you like to do next?"}],
                             "stop_reason": "end_turn", "stop_sequence": None,
                             "usage": {"input_tokens": 0, "output_tokens": 0,
                                       "cache_creation_input_tokens": 0, "cache_read_input_tokens": 0,
                                       "service_tier": "standard"}},
                 "uuid": a_uuid, "timestamp": "2026-01-01T00:00:01.000Z"})
    return recs


def main():
    if len(sys.argv) < 2:
        print(__doc__); sys.exit(1)
    prefix = sys.argv[1]
    force = "--force" in sys.argv
    found = find_richest_snapshot(prefix)
    if not found:
        print(f"No saved snapshot found for uuid prefix {prefix!r}"); sys.exit(1)
    src, d = found
    sid = d["claude_session_id"]
    cwd = d.get("working_directory", "")
    enc = encode_workdir(cwd)
    out_dir = os.path.join(PROJ, enc)
    out_path = os.path.join(out_dir, sid + ".jsonl")

    print(f"  source snapshot : {os.path.relpath(src, DATA)}")
    print(f"  session id      : {sid}")
    print(f"  working dir     : {cwd}")
    print(f"  target .jsonl   : {out_path}")

    if os.path.exists(out_path) and not force:
        print(f"  ABORT: target already exists (use --force to overwrite)"); sys.exit(2)

    raw = d.get("raw_transcript", "") or ""
    body = strip_chrome(clean_transcript(raw))
    print(f"  cleaned context : {len(body)} chars (~{len(body)//4} tokens)")

    recs = build_records(sid, cwd, body)
    os.makedirs(out_dir, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as fh:
        for r in recs:
            fh.write(json.dumps(r, ensure_ascii=False) + "\n")
    print(f"  WROTE {len(recs)} records -> {out_path}")
    print("  Done. Resume from the IDE sidebar to test.")


if __name__ == "__main__":
    main()
