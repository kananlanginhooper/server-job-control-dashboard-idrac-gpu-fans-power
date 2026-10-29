"""Forward the UI's other /api/* calls to the classic dashboard API, until each part moves here."""
from __future__ import annotations

import httpx

HOP = {"connection", "keep-alive", "transfer-encoding", "te", "trailer", "upgrade", "content-length", "content-encoding", "host"}


async def forward(client: httpx.AsyncClient, base: str, method: str, path: str, params, headers, body: bytes | None) -> httpx.Response:
    hdrs = {k: v for k, v in headers.items() if k.lower() not in HOP}
    return await client.request(method, f"{base}/api/{path}", params=params, content=body, headers=hdrs)


def response_headers(r: httpx.Response) -> dict[str, str]:
    return {k: v for k, v in r.headers.items() if k.lower() not in HOP}
