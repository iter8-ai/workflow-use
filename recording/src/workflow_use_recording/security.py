from __future__ import annotations

import asyncio
import ipaddress
import socket
import time
from typing import Any
from urllib.parse import urlsplit


def is_public_http_url(url: str) -> bool:
    """Accept only a public HTTP(S) host with no embedded credentials."""
    try:
        parsed = urlsplit(url)
    except ValueError:
        return False
    if parsed.scheme not in {"http", "https"}:
        return False
    if not parsed.hostname or parsed.username or parsed.password:
        return False
    hostname = parsed.hostname.rstrip(".").lower()
    if hostname == "localhost" or hostname.endswith(".localhost"):
        return False
    try:
        return ipaddress.ip_address(hostname).is_global
    except ValueError:
        return True


def is_google_sign_in(url: str) -> bool:
    """Google's own sign-in pages, e.g. the window a site's "Continue with Google" button opens."""
    if not isinstance(url, str):
        return False
    try:
        hostname = urlsplit(url).hostname
    except ValueError:
        return False
    host = (hostname or "").rstrip(".").lower()
    parts = host.split(".")
    return host == "accounts.youtube.com" or (
        parts[:2] == ["accounts", "google"]
        and (
            (len(parts) == 3 and (parts[2] == "com" or len(parts[2]) == 2))
            or (len(parts) == 4 and len(parts[2]) >= 2 and len(parts[3]) == 2)
        )
        and all(part.isascii() and part.isalpha() for part in parts[2:])
    )


def has_google_session(cookies: list[dict[str, Any]]) -> bool:
    """Copy of FIRE web_agent/adapters/google_session.py GoogleSessionConnections.complete() predicate."""
    now = time.time()
    return any(
        cookie.get("name") in {"SID", "__Secure-1PSID"}
        and cookie.get("domain") in {"google.com", ".google.com"}
        and cookie.get("path") == "/"
        and (cookie.get("name") != "__Secure-1PSID" or cookie.get("secure") is True)
        and isinstance(cookie.get("value"), str)
        and bool(cookie["value"])
        and isinstance(cookie.get("expires"), (int, float))
        and not isinstance(cookie["expires"], bool)
        and (cookie["expires"] == -1 or cookie["expires"] > now)
        for cookie in cookies
    )


def safe_public_url(url: str) -> str | None:
    """Return a public URL only when it has no query parameters or fragment."""
    if not is_public_http_url(url):
        return None
    parsed = urlsplit(url)
    if parsed.query or parsed.fragment:
        return None
    return url


async def resolves_to_public_host(url: str) -> bool:
    """Fail closed when the recorder host cannot resolve a public destination."""
    if not is_public_http_url(url):
        return False
    hostname = urlsplit(url).hostname
    if hostname is None:
        return False
    try:
        addresses = await asyncio.wait_for(
            asyncio.get_running_loop().getaddrinfo(hostname, None, type=socket.SOCK_STREAM), timeout=2
        )
    except (OSError, TimeoutError):
        return False
    if not addresses:
        return False
    try:
        return all(ipaddress.ip_address(address[4][0]).is_global for address in addresses)
    except ValueError:
        return False
