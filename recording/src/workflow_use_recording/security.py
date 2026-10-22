from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import time
from typing import Any
from urllib.parse import urlsplit

import idna


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


def url_origin(url: str) -> str | None:
    """The canonical ``scheme://host[:port]`` of an HTTP(S) URL, lowercase and without a default port."""
    try:
        parsed = urlsplit(url)
        port = parsed.port
    except ValueError:
        return None
    if parsed.scheme not in {"http", "https"} or not parsed.hostname or parsed.username or parsed.password:
        return None
    host = parsed.hostname.lower()
    if ":" in host:
        host = f"[{host}]"
    elif not host.isascii():
        try:
            host = idna.encode(host, uts46=True, transitional=False).decode("ascii")
        except idna.IDNAError:
            return None
    default = 80 if parsed.scheme == "http" else 443
    return f"{parsed.scheme}://{host}" + (f":{port}" if port is not None and port != default else "")


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
    """Return a public HTTP(S) URL without changing its path, query, or fragment."""
    return url if is_public_http_url(url) else None


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


# Copy of FIRE web_agent/adapters/executor.py; challenge verdicts are session/IP specific.
_CLOUDFLARE_COOKIES = re.compile(r"^(cf_clearance|__cf_bm|_cfuvid|__cflb|cf_chl_.*)$")


def is_google_origin(origin: str) -> bool:
    host = (urlsplit(origin).hostname or "").rstrip(".").lower()
    parts = host.split(".")
    return any(is_google_sign_in("https://accounts." + ".".join(parts[index:])) for index in range(len(parts)))


def website_state(state: dict[str, Any], origin: str) -> dict[str, Any]:
    """Copy of FIRE website_state: site cookies and exact-origin localStorage only."""
    if is_google_origin(origin):
        return {"cookies": [], "origins": []}
    host = urlsplit(origin).hostname or ""
    now = time.time()
    cookies = []
    for cookie in state.get("cookies", []):
        domain = cookie.get("domain", "").lower()
        bare = domain.lstrip(".")
        if not bare or is_google_origin("https://" + bare):
            continue
        applicable = host == bare or domain.startswith(".") and host.endswith("." + bare)
        expiry = cookie.get("expires", -1)
        if (
            applicable
            and cookie.get("path")
            and (expiry <= 0 or expiry > now)
            and not _CLOUDFLARE_COOKIES.fullmatch(cookie.get("name", ""))
        ):
            cookies.append(cookie)
    return {
        "cookies": cookies,
        "origins": [
            {"origin": origin, "localStorage": item.get("localStorage", [])}
            for item in state.get("origins", [])
            if item.get("origin") == origin and item.get("localStorage")
        ],
    }
