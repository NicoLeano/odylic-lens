"""Local Boards. Atelier's answer to Atria's saved-ad boards.

Why this exists
---------------
The Atria public API is read-only. there's no POST to save an ad to a
board, so the only way to use Atria's own boards is to leave Atelier and
click around the Atria web app. The user wants that ergonomic without
the context switch, so we run our own boards entirely on disk here.

Persistence is a single JSON file (`~/ad-connector/boards.json`) keyed by
board UUID. Same atomic write-then-rename pattern as
`ad_analysis_cache.json` so a crash mid-write can't truncate a board.

Shape
-----
{
  "boards": {
    "<uuid>": {
      "id": "<uuid>",
      "name": "Holiday inspo",
      "created_at": <unix>,
      "updated_at": <unix>,
      "ads": [
        {
          "source": "atria" | "atelier",
          "ad_id": "m123..." | "6669218270797",
          "brand": "Kinn Studios" | null,  # only meaningful for atelier
          "saved_at": <unix>,
          "snapshot": { ... }  # minimal projection. see SNAPSHOT_FIELDS
        }
      ]
    }
  }
}

Routes
------
GET    /api/boards                                 . list boards (no ad bodies)
POST   /api/boards                                 . create new board
PATCH  /api/boards/{board_id}                      . rename
DELETE /api/boards/{board_id}                      . delete
GET    /api/boards/{board_id}                      . full board incl. ads
POST   /api/boards/{board_id}/ads                  . pin ad
DELETE /api/boards/{board_id}/ads/{source}/{ad_id} . unpin (?brand=… for atelier)
GET    /api/boards/membership                      . which boards is this ad in?
"""

from __future__ import annotations

import json
import os
import time
import uuid
from typing import Any, Optional

from fastapi import APIRouter, Body, HTTPException, Query
from pydantic import BaseModel


router = APIRouter(prefix="/api/boards", tags=["boards"])

_HERE = os.path.dirname(os.path.abspath(__file__))
BOARDS_FILE = os.path.join(_HERE, "boards.json")


# Snapshot keys we persist per pinned ad. Just enough to render a board
# offline if the source de-indexes. no signed CDN URLs (those rotate),
# no per-day metric numbers (those become stale).
SNAPSHOT_FIELDS = (
    "brand_name", "brand_avatar_url",
    "title", "body",
    "display_format", "media_format",
    "thumbnail_url", "image_url", "preview_image_url", "video_id",
    "link_url", "cta_type", "cta_text",
    "start_date", "end_date", "status",
    "platforms", "categories",
)


def _load() -> dict:
    try:
        with open(BOARDS_FILE) as f:
            data = json.load(f) or {}
    except Exception:
        return {"boards": {}}
    if "boards" not in data:
        data["boards"] = {}
    return data


def _save(data: dict) -> None:
    tmp = BOARDS_FILE + ".tmp"
    with open(tmp, "w") as f:
        json.dump(data, f, indent=2)
    os.replace(tmp, BOARDS_FILE)


def _board_summary(b: dict) -> dict:
    """List-view projection. no ad bodies so the list payload stays small
    even when boards grow to thousands of pins."""
    return {
        "id": b["id"],
        "name": b.get("name") or "Untitled",
        "ad_count": len(b.get("ads") or []),
        "created_at": b.get("created_at"),
        "updated_at": b.get("updated_at"),
    }


def _pin_matches(pin: dict, source: str, ad_id: str, brand: Optional[str]) -> bool:
    """Atelier ads are scoped by (source, ad_id, brand) because the same
    ad_id can exist under different ad accounts. Atria ads are globally
    unique so brand is ignored on that side."""
    if pin.get("source") != source or str(pin.get("ad_id")) != str(ad_id):
        return False
    if source == "atelier" and brand is not None:
        return (pin.get("brand") or "") == brand
    return True


class CreateBoardBody(BaseModel):
    name: str


class RenameBoardBody(BaseModel):
    name: str


class PinAdBody(BaseModel):
    source: str  # "atria" | "atelier"
    ad_id: str
    brand: Optional[str] = None
    snapshot: dict[str, Any] = {}


# --- Endpoints --------------------------------------------------------------

@router.get("")
def list_boards():
    data = _load()
    items = [_board_summary(b) for b in data["boards"].values()]
    # Newest first. matches Reports UX
    items.sort(key=lambda x: x.get("updated_at") or 0, reverse=True)
    return {"items": items}


@router.post("")
def create_board(body: CreateBoardBody):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    data = _load()
    board_id = uuid.uuid4().hex[:12]
    now = time.time()
    data["boards"][board_id] = {
        "id": board_id,
        "name": name,
        "created_at": now,
        "updated_at": now,
        "ads": [],
    }
    _save(data)
    return _board_summary(data["boards"][board_id])


@router.patch("/{board_id}")
def rename_board(board_id: str, body: RenameBoardBody):
    name = (body.name or "").strip()
    if not name:
        raise HTTPException(status_code=400, detail="name is required")
    data = _load()
    b = data["boards"].get(board_id)
    if not b:
        raise HTTPException(status_code=404, detail="board not found")
    b["name"] = name
    b["updated_at"] = time.time()
    _save(data)
    return _board_summary(b)


@router.delete("/{board_id}", status_code=204)
def delete_board(board_id: str):
    data = _load()
    if board_id not in data["boards"]:
        raise HTTPException(status_code=404, detail="board not found")
    del data["boards"][board_id]
    _save(data)
    return None


@router.get("/{board_id}")
def get_board(board_id: str):
    data = _load()
    b = data["boards"].get(board_id)
    if not b:
        raise HTTPException(status_code=404, detail="board not found")
    # Newest pin first so the user sees their most-recent saves on top.
    ads = sorted(b.get("ads") or [], key=lambda p: p.get("saved_at") or 0, reverse=True)
    return {**_board_summary(b), "ads": ads}


@router.post("/{board_id}/ads")
def pin_ad(board_id: str, body: PinAdBody):
    if body.source not in ("atria", "atelier"):
        raise HTTPException(status_code=400, detail="source must be 'atria' or 'atelier'")
    data = _load()
    b = data["boards"].get(board_id)
    if not b:
        raise HTTPException(status_code=404, detail="board not found")
    # Project snapshot down to known fields so callers can't bloat the
    # file with whatever junk they happen to have in scope.
    snap = {k: body.snapshot.get(k) for k in SNAPSHOT_FIELDS if k in body.snapshot}
    now = time.time()
    pins = b.setdefault("ads", [])
    # Dedupe: re-pinning bumps saved_at + refreshes snapshot rather than
    # appending a duplicate row.
    existing = next(
        (p for p in pins if _pin_matches(p, body.source, body.ad_id, body.brand)),
        None,
    )
    if existing:
        existing["saved_at"] = now
        if snap:
            existing["snapshot"] = {**existing.get("snapshot", {}), **snap}
    else:
        pins.append({
            "source": body.source,
            "ad_id": str(body.ad_id),
            "brand": body.brand,
            "saved_at": now,
            "snapshot": snap,
        })
    b["updated_at"] = now
    _save(data)
    return {"ok": True, "ad_count": len(pins)}


@router.delete("/{board_id}/ads/{source}/{ad_id}", status_code=204)
def unpin_ad(
    board_id: str,
    source: str,
    ad_id: str,
    brand: Optional[str] = Query(None),
):
    data = _load()
    b = data["boards"].get(board_id)
    if not b:
        raise HTTPException(status_code=404, detail="board not found")
    pins = b.get("ads") or []
    new_pins = [p for p in pins if not _pin_matches(p, source, ad_id, brand)]
    if len(new_pins) == len(pins):
        # Idempotent. return 204 even when the pin wasn't there. Cleaner
        # for clients than a 404 on a no-op.
        return None
    b["ads"] = new_pins
    b["updated_at"] = time.time()
    _save(data)
    return None


@router.get("/membership/check")
def membership(
    source: str = Query(...),
    ad_id: str = Query(...),
    brand: Optional[str] = Query(None),
):
    """Returns the list of board_ids this ad is pinned to. Used by the UI
    to render filled vs empty bookmark state without loading every board."""
    if source not in ("atria", "atelier"):
        raise HTTPException(status_code=400, detail="source must be 'atria' or 'atelier'")
    data = _load()
    hits = []
    for b in data["boards"].values():
        for p in (b.get("ads") or []):
            if _pin_matches(p, source, ad_id, brand):
                hits.append(b["id"])
                break
    return {"board_ids": hits}
