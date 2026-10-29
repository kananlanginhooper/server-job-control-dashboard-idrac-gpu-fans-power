from __future__ import annotations

import httpx
from fastapi import APIRouter, Depends, HTTPException, Request, Response

from ...core.config import Settings, get_settings
from ...services.legacy import forward, response_headers
from ..deps import lan_only

router = APIRouter(tags=["legacy"])


@router.api_route("/api/{path:path}", methods=["GET", "POST"], include_in_schema=False)
async def legacy(path: str, req: Request, s: Settings = Depends(get_settings)):
    """Forward the classic dashboard API (the UI's /api/state etc.) when SJC_LEGACY_API is set. POSTs: LAN only."""
    if path.startswith("v1/") or not s.legacy_base:
        raise HTTPException(404, "not found")
    if req.method == "POST":
        lan_only(req, s)
    try:
        r = await forward(req.app.state.http, s.legacy_base, req.method, path, req.query_params, req.headers,
                          await req.body() if req.method == "POST" else None)
    except httpx.HTTPError as e:
        raise HTTPException(502, f"legacy API unreachable: {e.__class__.__name__}")
    return Response(r.content, r.status_code, response_headers(r))
