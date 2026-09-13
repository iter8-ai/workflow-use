from __future__ import annotations

import asyncio
import ipaddress
import socket
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
