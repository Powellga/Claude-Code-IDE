"""One-off "dream" experiment: read a project's recent Claude Code transcripts
together with its memory files, find patterns, and propose memory changes.

Report only. Nothing is ever written to CLAUDE.md, docs/ or the memory folder.

Pipeline (plain Python does the mechanics, Claude only reads and proposes):
  1. pick the project's most recent JSONL transcripts
  2. digest each one (user turns, tool calls, errors, corrections; no file
     contents or long tool output), capped at ~15k tokens
  3. redact secrets (patterns + a literal blocklist read at run time)
  4. analyst calls (Sonnet, one per batch of digests) return findings
  5. one orchestrator call (Opus) turns findings into proposals
  6. Python re-checks every proposal (secret scan, target allowed, old_text
     present exactly once) and writes run.json + report.md

Runs headless Claude Code with --bare (no CLAUDE.md, hooks or auto memory),
--no-session-persistence (no transcript of its own), no tools, and a per-call
--max-budget-usd. The API key comes from SSM and is passed only in the
subprocess environment.

Usage:  python tools/dream_experiment.py <workdir> [--sessions 12] [--budget 5]
"""
import argparse
import hashlib
import json
import os
import re
import subprocess
import sys
from datetime import datetime
from pathlib import Path

IDE_DIR = Path(__file__).resolve().parent.parent
CLAUDE_PROJECTS = Path.home() / ".claude" / "projects"
ANALYST_MODEL = "claude-sonnet-5-5"
ORCHESTRATOR_MODEL = "claude-opus-5-5"
DIGEST_MAX_CHARS = 60_000          # ~15k tokens
BATCH_SIZE = 4


# ── secrets ──

SECRET_PATTERNS = [
    re.compile(r"sk-ant-[A-Za-z0-9_\-]{20,}"),
    re.compile(r"\bAKIA[0-9A-Z]{16}\b"),
    re.compile(r"(?i)aws_secret_access_key\s*[=:]\s*\S+"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\bxox[abprs]-[A-Za-z0-9\-]{10,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{5,}"),
    re.compile(r"(?i)\bbearer\s+[A-Za-z0-9._\-]{20,}"),
    re.compile(r"(?i)\b(password|passwd|pwd|secret|api[_-]?key|token)\b(\s*[=:]\s*)[\"']?[^\s\"']{6,}"),
]
HIGH_ENTROPY = re.compile(r"(?<![A-Za-z0-9/+_\-])[A-Za-z0-9/+_\-]{32,}={0,2}(?![A-Za-z0-9/+_\-])")


def _looks_random(s):
    classes = sum(bool(re.search(p, s)) for p in (r"[a-z]", r"[A-Z]", r"[0-9]"))
    return classes >= 3 and not re.fullmatch(r"[0-9a-f\-]+", s)   # leave hex ids / UUIDs / shas


def build_blocklist(api_key):
    """Literal secret values to scrub, read at run time and never logged."""
    values = {api_key}
    cf = Path.home() / ".cloudflare"
    if cf.is_dir():
        for f in cf.glob("*.txt"):
            v = f.read_text(encoding="utf-8", errors="ignore").strip()
            if len(v) >= 12:
                values.add(v)
    for name in ("/temarkbox/monday/token",):
        v = _ssm(name)
        if v:
            values.add(v)
    return sorted((v for v in values if v), key=len, reverse=True)


def redact(text, blocklist):
    for v in blocklist:
        text = text.replace(v, "[REDACTED]")
    for p in SECRET_PATTERNS:
        text = p.sub(lambda m: (m.group(1) + m.group(2) + "[REDACTED]") if m.lastindex and m.lastindex >= 2 else "[REDACTED]", text)
    return HIGH_ENTROPY.sub(lambda m: "[REDACTED]" if _looks_random(m.group(0)) else m.group(0), text)


def has_secret(text):
    return any(p.search(text) for p in SECRET_PATTERNS[:8]) or any(_looks_random(m.group(0)) for m in HIGH_ENTROPY.finditer(text))


# ── AWS ──

def _ssm(name):
    r = subprocess.run(["aws", "ssm", "get-parameter", "--region", "us-west-2", "--name", name,
                        "--with-decryption", "--query", "Parameter.Value", "--output", "text"],
                       capture_output=True, text=True, env={**os.environ, "MSYS_NO_PATHCONV": "1"})
    return r.stdout.strip() if r.returncode == 0 else ""


# ── digest ──

NOISE = [re.compile(p, re.S) for p in (
    r"<system-reminder>.*?</system-reminder>",
    r"<local-command-caveat>.*?</local-command-caveat>",
    r"<local-command-stdout>.*?</local-command-stdout>",
    r"<command-(name|message|args)>.*?</command-\1>",
    r"<task-notification>.*?</task-notification>",
    r"<agent-message.*?</agent-message>",
)]
CORRECTION = re.compile(
    r"(?i)\b(no[,.!]|that'?s (wrong|not)|not what i|i (told|asked|said)|you (didn'?t|did not|keep|forgot|missed|stopped)|"
    r"again\b|why did you|stop\b|don'?t\b|do not\b|never\b|wrong\b|incorrect|mistake|repeat(edly|ing)?|not acting)")


def _short_args(name, inp):
    if not isinstance(inp, dict):
        return ""
    for k in ("command", "file_path", "path", "pattern", "url", "query", "description", "prompt", "skill"):
        if k in inp and inp[k]:
            return f"{k}={str(inp[k])[:220]}"
    return json.dumps(inp)[:160]


def digest(path):
    events, tool_names = [], {}
    for line in open(path, encoding="utf-8", errors="replace"):
        try:
            d = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = d.get("type")
        content = (d.get("message") or {}).get("content")
        if kind == "user":
            parts = [{"type": "text", "text": content}] if isinstance(content, str) else (content or [])
            for part in parts:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "text":
                    t = part.get("text") or ""
                    for n in NOISE:
                        t = n.sub("", t)
                    t = t.strip()
                    if not t or t.startswith("Caveat:") or "Tool loaded." == t:
                        continue
                    if "[Request interrupted by user" in t:
                        events.append(("I", "[INTERRUPTED BY GREGG]"))
                        continue
                    tag = "U-CORRECTION?" if CORRECTION.search(t[:600]) else "U"
                    events.append((tag, f"[{tag}] {t[:1500]}"))
                elif part.get("type") == "tool_result" and part.get("is_error"):
                    c = part.get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    name = tool_names.get(part.get("tool_use_id"), "tool")
                    events.append(("E", f"[ERROR {name}] {str(c)[:400]}"))
        elif kind == "assistant":
            for part in content or []:
                if not isinstance(part, dict):
                    continue
                if part.get("type") == "tool_use":
                    tool_names[part.get("id")] = part.get("name", "tool")
                    events.append(("T", f"[TOOL {part.get('name')}] {_short_args(part.get('name'), part.get('input'))}"))
                elif part.get("type") == "text" and (part.get("text") or "").strip():
                    events.append(("A", f"[CLAUDE] {part['text'].strip()[:300]}"))

    def size(evs):
        return sum(len(e[1]) + 1 for e in evs)

    # Shrink to budget: drop Claude's prose first, then tool calls, keeping
    # Gregg's words, corrections, interruptions and errors.
    for drop in ("A", "T"):
        if size(events) <= DIGEST_MAX_CHARS:
            break
        events = [e for e in events if e[0] != drop]
    if size(events) > DIGEST_MAX_CHARS:
        events = [(k, v[:600]) for k, v in events]
    if size(events) > DIGEST_MAX_CHARS:
        head, tail, out, budget = [], [], events, DIGEST_MAX_CHARS
        keep_head = int(budget * 0.35)
        acc = 0
        for e in out:
            if acc + len(e[1]) > keep_head:
                break
            head.append(e); acc += len(e[1]) + 1
        acc = 0
        for e in reversed(out):
            if acc + len(e[1]) > budget - keep_head:
                break
            tail.insert(0, e); acc += len(e[1]) + 1
        events = head + [("X", "[... middle of session omitted for length ...]")] + tail
    return "\n".join(v for _, v in events)


# ── Claude calls ──

def call_claude(model, instruction, stdin_text, schema, budget, api_key, staging):
    cmd = ["claude", "-p", instruction, "--bare", "--no-session-persistence",
           "--model", model, "--output-format", "json", "--json-schema", json.dumps(schema),
           "--tools", "", "--permission-mode", "dontAsk", "--max-budget-usd", f"{budget:.2f}"]
    env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDE_CODE_")}
    env["ANTHROPIC_API_KEY"] = api_key
    r = subprocess.run(cmd, input=stdin_text, capture_output=True, text=True, encoding="utf-8",
                       cwd=str(staging), env=env, timeout=1800)
    try:
        out = json.loads(r.stdout)
    except json.JSONDecodeError:
        raise RuntimeError(f"claude -p returned non-JSON (exit {r.returncode}): {r.stdout[:400]} {r.stderr[:400]}")
    data = out.get("structured_output")
    if data is None:
        try:
            data = json.loads(out.get("result") or "")
        except (json.JSONDecodeError, TypeError):
            raise RuntimeError(f"no structured_output; result was: {str(out.get('result'))[:400]}")
    return data, float(out.get("total_cost_usd") or 0)


EVIDENCE = {"type": "array", "items": {"type": "object", "properties": {
    "session_id": {"type": "string"}, "quote": {"type": "string"}}, "required": ["session_id", "quote"]}}

FINDINGS_SCHEMA = {"type": "object", "properties": {"findings": {"type": "array", "items": {
    "type": "object", "properties": {
        "type": {"type": "string", "enum": ["missing_knowledge", "wrong_or_stale_memory", "repeated_mistake",
                                            "tool_failure", "preference", "rule_ignored"]},
        "description": {"type": "string"},
        "evidence": EVIDENCE,
        "session_count": {"type": "integer"}},
    "required": ["type", "description", "evidence", "session_count"]}}}, "required": ["findings"]}

PROPOSALS_SCHEMA = {"type": "object", "properties": {"proposals": {"type": "array", "items": {
    "type": "object", "properties": {
        "id": {"type": "string"},
        "target_file": {"type": "string"},
        "action": {"type": "string", "enum": ["add", "edit", "delete", "move_to_doc", "global_candidate"]},
        "old_text": {"type": "string"},
        "new_text": {"type": "string"},
        "insert_after": {"type": "string"},
        "rationale": {"type": "string"},
        "evidence": EVIDENCE,
        "prevalence": {"type": "string"}},
    "required": ["id", "target_file", "action", "old_text", "new_text", "rationale", "evidence", "prevalence"]}},
    "observations": {"type": "array", "items": {"type": "string"}}}, "required": ["proposals", "observations"]}

ANALYST_INSTRUCTION = """You are reviewing digests of past Claude Code sessions for one software project, together with the project's current memory (its CLAUDE.md). The digests and memory are in the input below. Lines tagged [U] are Gregg (the developer) speaking; [U-CORRECTION?] are his messages that may be corrections (judge for yourself); [TOOL] are Claude's tool calls; [ERROR] are failed tool calls; [INTERRUPTED BY GREGG] means he stopped Claude.

Find patterns that better memory would fix:
- missing_knowledge: Claude had to discover, guess or ask about something durable that memory should have told it.
- wrong_or_stale_memory: memory says one thing, the sessions show another.
- repeated_mistake: the same kind of mistake in more than one session.
- tool_failure: commands or tools that keep failing for the same reason (give the cause).
- preference: Gregg corrected how Claude works or writes.
- rule_ignored: memory already states a rule, but sessions still broke it (this means the rule is unclear, buried, or mis-placed).

Rules: every finding needs evidence quotes copied verbatim from the digests (short, under 200 characters each) with the session id shown in that digest's header. Ignore one-off debugging and task content that is not about how Claude should work. Do not propose edits; only report findings. Never repeat a credential or anything marked [REDACTED]. Return JSON matching the schema."""

ORCHESTRATOR_INSTRUCTION = """You are the orchestrator of a memory review ("dream") for one software project. The input holds (1) findings from analysts who read recent session digests, and (2) the project's current memory files with their exact text. Turn the findings into a short list of concrete memory changes for Gregg to accept or reject one by one.

Rules:
- Propose a change only for a pattern seen in at least 2 sessions, or one clear correction by Gregg.
- Prefer editing or deleting over adding. Keep CLAUDE.md under 250 lines: long procedures and history belong in a docs/ file with a one-line pointer in CLAUDE.md (action move_to_doc).
- For a rule_ignored finding, propose making the existing rule clearer or more prominent rather than adding a duplicate.
- For edit, delete and move_to_doc, old_text must be copied EXACTLY from the target file (a whole line or more, unique in that file). For add, give insert_after as an exact existing line to insert after (or leave it empty to append), and leave old_text empty.
- target_file must be one of the memory file names exactly as listed in the input. If a pattern clearly applies to all of Gregg's projects, use action global_candidate with target_file "GLOBAL" (it will not be applied from a single-project dream).
- Never propose a rule the GLOBAL RULES already state, and never re-propose anything in PAST DREAM DECISIONS.
- Never include credentials. Write new text in plain, whole sentences; never use em dashes.
- Use observations for anything worth telling Gregg that is not a memory change (for example: memory looked healthy in an area, or a finding was too weak to act on).
Return JSON matching the schema."""


# ── main ──

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workdir")
    ap.add_argument("--sessions", type=int, default=12)
    ap.add_argument("--budget", type=float, default=5.0)
    args = ap.parse_args()

    workdir = Path(args.workdir).resolve()
    munged = re.sub(r"[^A-Za-z0-9]", "-", os.path.normpath(str(workdir)))
    tdir = CLAUDE_PROJECTS / munged
    transcripts = sorted((p for p in tdir.glob("*.jsonl") if p.stat().st_size > 50_000),
                         key=lambda p: p.stat().st_mtime, reverse=True)[:args.sessions]
    if not transcripts:
        sys.exit(f"no transcripts under {tdir}")

    api_key = _ssm("/temarkbox/anthropic/dreaming-key")
    if not api_key:
        sys.exit("could not read /temarkbox/anthropic/dreaming-key from SSM")
    blocklist = build_blocklist(api_key)

    run_id = datetime.now().strftime("dream_%Y%m%d_%H%M%S")
    staging = IDE_DIR / "data" / "dreams" / run_id
    staging.mkdir(parents=True)
    print(f"[dream] {run_id}: {len(transcripts)} sessions from {tdir.name}")

    # Memory files (read-only copies go to staging for the record)
    mem = {"CLAUDE.md": workdir / "CLAUDE.md"}
    mdir = tdir / "memory"
    if mdir.is_dir():
        for f in sorted(mdir.glob("*.md")):
            mem[f"memory/{f.name}"] = f
    memory_text = {k: v.read_text(encoding="utf-8") for k, v in mem.items() if v.exists()}
    docs = sorted(p.name for p in (workdir / "docs").glob("*.md")) if (workdir / "docs").is_dir() else []
    target_sha = {k: hashlib.sha256(v.encode()).hexdigest() for k, v in memory_text.items()}

    global_md = Path.home() / ".claude" / "CLAUDE.md"
    global_text = global_md.read_text(encoding="utf-8") if global_md.exists() else ""

    # Decisions from earlier dreams on this workdir, so nothing is re-proposed
    past = []
    for rj in sorted((IDE_DIR / "data" / "dreams").glob("dream_*/run.json")):
        try:
            prev = json.loads(rj.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if prev.get("workdir") != str(workdir):
            continue
        for pp in prev.get("proposals", []):
            if pp.get("decision"):
                past.append({"run": prev.get("run_id"), "proposal": pp.get("new_text") or pp.get("old_text"),
                             "decision": pp["decision"].get("status"), "note": pp["decision"].get("note", "")})

    def memory_block(full_memory_folder):
        out = []
        if global_text:
            out.append("===== GLOBAL RULES (~/.claude/CLAUDE.md, loaded in every project; read-only context, "
                       "never propose a project rule that duplicates one of these) =====\n" + global_text)
        for k, t in memory_text.items():
            if k == "CLAUDE.md" or full_memory_folder:
                out.append(f"===== MEMORY FILE: {k} =====\n{t}")
        if not full_memory_folder:
            out.append("===== OTHER MEMORY FILES (names only) =====\n" + "\n".join(k for k in memory_text if k != "CLAUDE.md"))
        out.append("===== docs/ reference files (not loaded at startup) =====\n" + "\n".join(docs))
        return redact("\n\n".join(out), blocklist)

    # Digest + redact
    digests = []
    for t in transcripts:
        d = redact(digest(t), blocklist)
        (staging / f"digest_{t.stem}.txt").write_text(d, encoding="utf-8")
        digests.append((t.stem, d))
        print(f"[dream]   digest {t.stem[:8]}: {len(d):,} chars")

    cost, findings, log = 0.0, [], []
    per_batch = min(1.25, args.budget / 4)
    for i in range(0, len(digests), BATCH_SIZE):
        if cost >= args.budget * 0.7:
            log.append(f"stopped analyst batches at {i}: cost {cost:.2f} near budget")
            break
        batch = digests[i:i + BATCH_SIZE]
        body = memory_block(False) + "\n\n" + "\n\n".join(
            f"##### SESSION DIGEST  session_id={sid}\n{d}" for sid, d in batch)
        data, c = call_claude(ANALYST_MODEL, ANALYST_INSTRUCTION, body, FINDINGS_SCHEMA, per_batch, api_key, staging)
        cost += c
        found = data.get("findings", [])
        findings.extend(found)
        print(f"[dream]   batch {i // BATCH_SIZE + 1}: {len(found)} findings, ${c:.3f}")

    remaining = max(0.5, args.budget - cost)
    body = ("===== FINDINGS =====\n" + json.dumps(findings, indent=1) + "\n\n"
            + ("===== PAST DREAM DECISIONS (already accepted, modified or rejected by Gregg; never "
               "re-propose these, and treat a 'modified' note as the rule that stands) =====\n"
               + redact(json.dumps(past, indent=1), blocklist) + "\n\n" if past else "")
            + memory_block(True))
    data, c = call_claude(ORCHESTRATOR_MODEL, ORCHESTRATOR_INSTRUCTION, body, PROPOSALS_SCHEMA,
                          min(2.0, remaining), api_key, staging)
    cost += c
    print(f"[dream]   orchestrator: {len(data.get('proposals', []))} proposals, ${c:.3f}")

    # Python checks on every proposal
    proposals = data.get("proposals", [])
    for p in proposals:
        problems = []
        if has_secret(p.get("new_text", "")):
            problems.append("new_text looks like it contains a secret")
        if "—" in p.get("new_text", ""):
            problems.append("new_text contains an em dash")
        tf = p.get("target_file", "")
        if p.get("action") == "global_candidate":
            p["applicable"] = False
            problems.append("global candidate: not applicable from a single-project dream")
        elif tf not in memory_text:
            problems.append(f"target_file {tf!r} is not a known memory file")
        else:
            if p.get("action") in ("edit", "delete", "move_to_doc"):
                n = memory_text[tf].count(p.get("old_text", "")) if p.get("old_text") else 0
                if n != 1:
                    problems.append(f"old_text found {n} times in {tf} (must be exactly 1)")
            if p.get("action") == "add" and p.get("insert_after") and memory_text[tf].count(p["insert_after"]) != 1:
                problems.append("insert_after line not found exactly once")
            p["target_sha256"] = target_sha[tf]
        p["checks"] = problems or ["ok"]

    run = {"run_id": run_id, "workdir": str(workdir), "sessions": [s for s, _ in digests],
           "models": {"analyst": ANALYST_MODEL, "orchestrator": ORCHESTRATOR_MODEL},
           "total_cost_usd": round(cost, 4), "findings": findings, "proposals": proposals,
           "observations": data.get("observations", []), "log": log, "status": "review"}
    (staging / "run.json").write_text(json.dumps(run, indent=1), encoding="utf-8")

    lines = [f"# Dream report: {workdir.name}", "",
             f"Run {run_id}. {len(digests)} sessions, {len(findings)} findings, {len(proposals)} proposals, "
             f"cost ${cost:.2f}. Nothing has been applied.", ""]
    for p in proposals:
        lines += [f"## {p.get('id')}: {p.get('action')} in {p.get('target_file')}",
                  f"Seen: {p.get('prevalence')}. Checks: {'; '.join(p['checks'])}", "",
                  f"Why: {p.get('rationale')}", ""]
        if p.get("old_text"):
            lines += ["Old text:", "```", p["old_text"], "```"]
        if p.get("new_text"):
            lines += ["New text:", "```", p["new_text"], "```"]
        lines += ["Evidence:"] + [f"- ({e['session_id'][:8]}) {e['quote']}" for e in p.get("evidence", [])] + [""]
    if run["observations"]:
        lines += ["## Observations"] + [f"- {o}" for o in run["observations"]]
    (staging / "report.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"[dream] done: {staging / 'report.md'}  (total ${cost:.2f})")


if __name__ == "__main__":
    main()
