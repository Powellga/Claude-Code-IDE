"""Smoke test: exercise find_chat and read_chat exactly as the MCP tools do."""
import server

chats = server.find_chat.__dict__.get("fn", None)
# FastMCP wraps tools; call the underlying functions directly for the test
find_chat = getattr(server.find_chat, "fn", server.find_chat)
read_chat = getattr(server.read_chat, "fn", server.read_chat)
whoami = getattr(server.whoami, "fn", server.whoami)

print("whoami:", whoami())
found = find_chat("System Spec App")
print("find_chat:", [(c.get("label"), c.get("type")) for c in found[:3]])
cid = found[0]["chat_id"]
out = read_chat(cid, since="2026-09-20", max_messages=5)
print(f"read_chat: {out['returned']} of {out['in_window_total']} in window since 2026-09-20")
for m in out["messages"][:3]:
    print(f"  [{m['when']}] {m['from']}: {m['text'][:80]!r}")
