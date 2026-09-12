from __future__ import annotations

import asyncio
import ipaddress
import socket
from urllib.parse import parse_qsl, urlsplit, urlunsplit

SENSITIVE_QUERY_NAMES = {
    "accesstoken",
    "apikey",
    "apikey",
    "authorization",
    "code",
    "credential",
    "idtoken",
    "otp",
    "password",
    "secret",
    "session",
    "token",
}


def _is_sensitive_query_name(name: str) -> bool:
    normalized = "".join(character for character in name.lower() if character.isalnum())
    return normalized in SENSITIVE_QUERY_NAMES


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


def safe_public_url(url: str) -> str | None:
    """Return a safe public URL stripped of sensitive query values and fragments."""
    if not is_public_http_url(url):
        return None
    parsed = urlsplit(url)
    query_names = (name for name, _ in parse_qsl(parsed.query, keep_blank_values=True))
    query = "" if any(_is_sensitive_query_name(name) for name in query_names) else parsed.query
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, query, ""))


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
