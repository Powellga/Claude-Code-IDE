"""Shared MSAL auth for the TEMARK Teams Chat MCP server.

Delegated device-code flow as Gregg; token cache on disk so sign-in is a
one-time event (refresh tokens renew silently). Scopes: Chat.ReadWrite
(read + send in chats the signed-in user is a member of).
"""
import json
from pathlib import Path

import msal

HERE = Path(__file__).parent
CONFIG = json.loads((HERE / "config.json").read_text(encoding="utf-8"))
CACHE_FILE = HERE / "token_cache.json"
SCOPES = ["Chat.ReadWrite"]


def _app():
    cache = msal.SerializableTokenCache()
    if CACHE_FILE.exists():
        cache.deserialize(CACHE_FILE.read_text(encoding="utf-8"))
    app = msal.PublicClientApplication(
        CONFIG["client_id"],
        authority=f"https://login.microsoftonline.com/{CONFIG['tenant_id']}",
        token_cache=cache,
    )
    return app, cache


def _save(cache):
    if cache.has_state_changed:
        CACHE_FILE.write_text(cache.serialize(), encoding="utf-8")


def get_token():
    """Silent token from cache. Raises with sign-in instructions if absent."""
    app, cache = _app()
    accounts = app.get_accounts()
    if accounts:
        result = app.acquire_token_silent(SCOPES, account=accounts[0])
        _save(cache)
        if result and "access_token" in result:
            return result["access_token"]
    raise RuntimeError(
        "Not signed in (or the refresh token expired). Ask Gregg to run:\n"
        f'  "{HERE / ".venv/Scripts/python.exe"}" "{HERE / "login.py"}"\n'
        "and finish the device-code sign-in in a browser."
    )


def account_username():
    """UPN of the cached signed-in account, without a Graph call."""
    app, _ = _app()
    accounts = app.get_accounts()
    return accounts[0].get("username") if accounts else None


def device_login():
    """Interactive device-code sign-in; prints the code, blocks until done."""
    app, cache = _app()
    flow = app.initiate_device_flow(scopes=SCOPES)
    if "user_code" not in flow:
        raise RuntimeError(f"Could not start device flow: {flow}")
    print(flow["message"], flush=True)
    result = app.acquire_token_by_device_flow(flow)
    _save(cache)
    if "access_token" not in result:
        raise RuntimeError(f"Sign-in failed: {result.get('error_description', result)}")
    who = result.get("id_token_claims", {}).get("preferred_username", "?")
    print(f"Signed in as {who}. Token cache saved - the MCP server is ready.")


if __name__ == "__main__":
    device_login()
