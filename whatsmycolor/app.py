import asyncio
import colorsys
from datetime import datetime, timezone
from hashlib import sha256
from html import escape
import json
import os
from pathlib import Path
import re
from secrets import token_urlsafe
from uuid import uuid4

from fasthtml.common import fast_app
from starlette.datastructures import UploadFile
from starlette.requests import Request
from starlette.responses import HTMLResponse, JSONResponse, Response
from starlette.staticfiles import StaticFiles

from whatsmycolor.analysis import InvalidImageError, analyze_image
from whatsmycolor.models import BoardShare, Photo
from whatsmycolor.repository import PhotoRepository
from whatsmycolor.social_preview import (
    PreviewPhoto,
    render_social_preview,
    share_summary,
)
from whatsmycolor.storage import PhotoStorage


ROOT_DIR = Path(__file__).resolve().parent.parent
STATIC_DIR = ROOT_DIR / "static"
OWNER_COOKIE = "wmc_library"
OWNER_TOKEN_PATTERN = re.compile(r"^[A-Za-z0-9_-]{32,64}$")
SHARE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{20,32}$")
MAX_TITLE_LENGTH = 90
MAX_LIBRARY_SIZE = 1_500
repository = PhotoRepository()
repository.initialize()
storage = PhotoStorage()


def _static_version() -> str:
    digest = sha256()
    for filename in ("styles.css", "app.js", "share.js"):
        path = STATIC_DIR / filename
        if path.exists():
            digest.update(path.read_bytes())
    return digest.hexdigest()[:12]


def _page_html() -> str:
    page = (STATIC_DIR / "index.html").read_text()
    return page.replace("__STATIC_VERSION__", _static_version())


def _share_page_html(share_url: str, preview_url: str, summary: str) -> str:
    page = (STATIC_DIR / "share.html").read_text()
    social_meta = "\n    ".join(
        (
            '<meta property="og:type" content="website">',
            '<meta property="og:title" content="Shared models">',
            f'<meta property="og:description" content="{escape(summary, quote=True)}">',
            f'<meta property="og:url" content="{escape(share_url, quote=True)}">',
            f'<meta property="og:image" content="{escape(preview_url, quote=True)}">',
            '<meta property="og:image:width" content="1200">',
            '<meta property="og:image:height" content="630">',
            '<meta property="og:image:type" content="image/png">',
            '<meta property="og:image:alt" content="Shared model photo board organized by color">',
            '<meta name="twitter:card" content="summary_large_image">',
            '<meta name="twitter:title" content="Shared models">',
            f'<meta name="twitter:description" content="{escape(summary, quote=True)}">',
            f'<meta name="twitter:image" content="{escape(preview_url, quote=True)}">',
            f'<link rel="canonical" href="{escape(share_url, quote=True)}">',
        )
    )
    return (
        page.replace("__STATIC_VERSION__", _static_version())
        .replace("__SOCIAL_META__", social_meta)
    )


def _new_owner() -> tuple[str, str]:
    token = token_urlsafe(32)
    owner_id = sha256(token.encode()).hexdigest()
    return owner_id, token


def _owner_from_request(request: Request) -> str | None:
    token = request.cookies.get(OWNER_COOKIE)
    if token is None or OWNER_TOKEN_PATTERN.fullmatch(token) is None:
        return None
    return sha256(token.encode()).hexdigest()


def _set_owner_cookie(response: Response, token: str, request: Request) -> None:
    response.set_cookie(
        OWNER_COOKIE,
        token,
        max_age=31_536_000,
        httponly=True,
        secure=bool(os.environ.get("VERCEL")) or request.url.scheme == "https",
        samesite="lax",
        path="/",
    )


def _api_error(message: str, status_code: int) -> JSONResponse:
    return JSONResponse(
        {"error": message},
        status_code=status_code,
        headers={"Cache-Control": "no-store"},
    )


def _clean_title(filename: str) -> str:
    stem = Path(filename).stem
    cleaned = re.sub(r"[_-]+", " ", stem).strip()
    cleaned = re.sub(r"\s+", " ", cleaned)
    return (cleaned or "Untitled model")[:MAX_TITLE_LENGTH]


def _form_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = value.strip()
    return cleaned or None


def _parse_captured_at(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    if parsed.year < 1800 or parsed.year > 2200:
        return None
    return parsed.isoformat(timespec="seconds")


def _manual_color(x_position: float) -> tuple[float | None, str, str]:
    if x_position > 95.0:
        return None, "black", "#171717"
    if x_position > 87.0:
        return None, "white", "#f1efe9"
    if x_position <= 1.0:
        hue = 0.0
    else:
        hue = (360.0 - min(x_position, 86.0) / 86.0 * 330.0) % 360.0
    red, green, blue = colorsys.hsv_to_rgb(hue / 360.0, 0.72, 0.86)
    color = f"#{round(red * 255):02x}{round(green * 255):02x}{round(blue * 255):02x}"
    return round(hue, 2), "hue", color


app, rt = fast_app(
    title="What's My Color?",
    secret_key=os.environ.get("FASTHTML_SECRET_KEY") or token_urlsafe(32),
)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@rt("/", methods=["GET"])
async def home(request: Request):
    owner_id = _owner_from_request(request)
    owner_token = None
    if owner_id is None:
        owner_id, owner_token = _new_owner()
    response = HTMLResponse(
        _page_html(),
        headers={
            "Cache-Control": "private, no-store",
            "Content-Security-Policy": (
                "default-src 'self'; img-src 'self' data: blob:; "
                "style-src 'self' 'unsafe-inline'; script-src 'self'; "
                "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
            ),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )
    if owner_token is not None:
        _set_owner_cookie(response, owner_token, request)
    return response


@rt("/s/{share_id}", methods=["GET"])
async def shared_board(share_id: str, request: Request):
    if SHARE_ID_PATTERN.fullmatch(share_id) is None:
        return Response(status_code=404)
    share = repository.get_share(share_id)
    if share is None:
        return Response(status_code=404)
    photos = repository.list_for_share(share_id)
    share_url = str(request.url)
    preview_url = str(request.url_for("shared_board_preview", share_id=share_id))
    return HTMLResponse(
        _share_page_html(share_url, preview_url, share_summary(photos)),
        headers={
            "Cache-Control": "public, max-age=300",
            "Content-Security-Policy": (
                "default-src 'self'; img-src 'self' data: blob:; "
                "style-src 'self' 'unsafe-inline'; script-src 'self'; "
                "connect-src 'self'; frame-ancestors 'none'; base-uri 'self'"
            ),
            "Referrer-Policy": "no-referrer",
            "X-Content-Type-Options": "nosniff",
        },
    )


@rt("/social-preview/{share_id}", methods=["GET"])
async def shared_board_preview(share_id: str):
    if SHARE_ID_PATTERN.fullmatch(share_id) is None:
        return Response(status_code=404)
    share = repository.get_share(share_id)
    if share is None:
        return Response(status_code=404)
    photos = repository.list_for_share(share_id)
    preview_source = photos[:36] if share.newest_first else photos[-36:]
    bodies = await asyncio.gather(
        *(
            storage.read(photo.image_url, photo.storage_key)
            for photo in preview_source
        ),
        return_exceptions=True,
    )
    preview_photos = [
        PreviewPhoto(photo=photo, body=body)
        for photo, body in zip(preview_source, bodies, strict=True)
        if isinstance(body, bytes)
    ]
    return Response(
        render_social_preview(preview_photos, share.newest_first),
        media_type="image/png",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "Content-Disposition": 'inline; filename="shared-models.png"',
            "X-Content-Type-Options": "nosniff",
        },
    )


@rt("/api/photos", methods=["GET"])
async def list_photos(request: Request):
    owner_id = _owner_from_request(request)
    if owner_id is None:
        return _api_error("Your library session has expired. Refresh the page.", 401)
    photos = repository.list_for_owner(owner_id)
    return JSONResponse(
        {"photos": [photo.as_api_dict() for photo in photos]},
        headers={"Cache-Control": "no-store"},
    )


@rt("/api/shares", methods=["POST"])
async def create_share(request: Request):
    owner_id = _owner_from_request(request)
    if owner_id is None:
        return _api_error("Your library session has expired. Refresh the page.", 401)
    photos = repository.list_for_owner(owner_id)
    if not photos:
        return _api_error("Add a photo before sharing.", 409)
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        payload = {}
    if not isinstance(payload, dict):
        return _api_error("Send a valid share request.", 400)
    newest_first = payload.get("newestFirst", True)
    if not isinstance(newest_first, bool):
        return _api_error("Timeline direction must be true or false.", 422)
    share = BoardShare(
        id=token_urlsafe(18),
        owner_id=owner_id,
        newest_first=newest_first,
        created_at=datetime.now(timezone.utc).isoformat(timespec="seconds"),
    )
    repository.create_share(share, photos)
    return JSONResponse(
        {"id": share.id, "url": f"/s/{share.id}"},
        status_code=201,
        headers={"Cache-Control": "no-store"},
    )


@rt("/api/shares/{share_id}", methods=["GET"])
async def get_share(share_id: str):
    if SHARE_ID_PATTERN.fullmatch(share_id) is None:
        return _api_error("Shared board not found.", 404)
    share = repository.get_share(share_id)
    if share is None:
        return _api_error("Shared board not found.", 404)
    photos = repository.list_for_share(share_id)
    return JSONResponse(
        {
            "share": {
                "id": share.id,
                "createdAt": share.created_at,
                "newestFirst": share.newest_first,
            },
            "photos": [
                photo.as_api_dict(f"/shared-media/{share.id}/{photo.id}")
                for photo in photos
            ],
        },
        headers={"Cache-Control": "public, max-age=31536000, immutable"},
    )


@rt("/api/photos", methods=["POST"])
async def upload_photo(request: Request):
    owner_id = _owner_from_request(request)
    if owner_id is None:
        return _api_error("Your library session has expired. Refresh the page.", 401)
    if len(repository.list_for_owner(owner_id)) >= MAX_LIBRARY_SIZE:
        return _api_error("This library has reached its 1,500 photo limit.", 409)

    form = await request.form()
    upload = form.get("photo")
    if not isinstance(upload, UploadFile):
        return _api_error("Choose a photo to upload.", 400)
    source_bytes = await upload.read()
    original_filename = upload.filename or "photo"
    try:
        analysis = analyze_image(
            source_bytes,
            original_filename,
            captured_at_hint=_form_text(form.get("captured_at_hint")),
            last_modified_hint=_form_text(form.get("last_modified")),
        )
    except InvalidImageError as error:
        return _api_error(str(error), 422)

    photo_id = uuid4().hex
    try:
        stored = await storage.put(owner_id, photo_id, analysis.image_bytes)
    except RuntimeError as error:
        return _api_error(str(error), 503)
    now = datetime.now(timezone.utc).isoformat(timespec="seconds")
    photo = Photo(
        id=photo_id,
        owner_id=owner_id,
        title=_clean_title(original_filename),
        captured_at=analysis.captured_at,
        time_source=analysis.time_source,
        x_position=analysis.x_position,
        hue=analysis.hue,
        color_kind=analysis.color_kind,
        primary_color=analysis.primary_color,
        color_source="automatic guess",
        image_url=stored.url,
        storage_key=stored.key,
        original_filename=original_filename[:255],
        width=analysis.width,
        height=analysis.height,
        created_at=now,
    )
    try:
        repository.insert(photo)
    except Exception:
        await storage.delete(stored.url, stored.key)
        raise
    return JSONResponse(
        {"photo": photo.as_api_dict()},
        status_code=201,
        headers={"Cache-Control": "no-store"},
    )


@rt("/api/photos/{photo_id}", methods=["PATCH"])
async def update_photo(photo_id: str, request: Request):
    owner_id = _owner_from_request(request)
    if owner_id is None:
        return _api_error("Your library session has expired. Refresh the page.", 401)
    current = repository.get_for_owner(photo_id, owner_id)
    if current is None:
        return _api_error("Photo not found.", 404)
    try:
        payload = await request.json()
    except json.JSONDecodeError:
        return _api_error("Send a valid JSON update.", 400)
    if not isinstance(payload, dict):
        return _api_error("Send a valid JSON update.", 400)

    title = current.title
    if "title" in payload:
        if not isinstance(payload["title"], str):
            return _api_error("Title must be text.", 422)
        title = payload["title"].strip()[:MAX_TITLE_LENGTH]
        if not title:
            return _api_error("Title cannot be empty.", 422)

    captured_at = current.captured_at
    time_source = current.time_source
    if "capturedAt" in payload:
        parsed_date = _parse_captured_at(payload["capturedAt"])
        if parsed_date is None:
            return _api_error("Choose a valid date between 1800 and 2200.", 422)
        captured_at = parsed_date
        time_source = "set by you"

    x_position = current.x_position
    hue = current.hue
    color_kind = current.color_kind
    primary_color = current.primary_color
    color_source = current.color_source
    if "xPosition" in payload:
        raw_x = payload["xPosition"]
        if not isinstance(raw_x, (int, float)):
            return _api_error("Color position must be a number.", 422)
        x_position = round(min(100.0, max(0.0, float(raw_x))), 3)
        hue, color_kind, primary_color = _manual_color(x_position)
        color_source = "placed by you"

    updated = repository.update_details(
        photo_id,
        owner_id,
        title=title,
        captured_at=captured_at,
        time_source=time_source,
        x_position=x_position,
        hue=hue,
        color_kind=color_kind,
        primary_color=primary_color,
        color_source=color_source,
    )
    if updated is None:
        return _api_error("Photo not found.", 404)
    return JSONResponse(
        {"photo": updated.as_api_dict()},
        headers={"Cache-Control": "no-store"},
    )


@rt("/api/photos/{photo_id}", methods=["DELETE"])
async def delete_photo(photo_id: str, request: Request):
    owner_id = _owner_from_request(request)
    if owner_id is None:
        return _api_error("Your library session has expired. Refresh the page.", 401)
    photo = repository.delete(photo_id, owner_id)
    if photo is None:
        return _api_error("Photo not found.", 404)
    if not repository.storage_is_shared(photo.storage_key):
        await storage.delete(photo.image_url, photo.storage_key)
    return Response(status_code=204, headers={"Cache-Control": "no-store"})


@rt("/media/{photo_id}", methods=["GET"])
async def photo_media(photo_id: str, request: Request):
    owner_id = _owner_from_request(request)
    if owner_id is None:
        return Response(status_code=404)
    photo = repository.get_for_owner(photo_id, owner_id)
    if photo is None:
        return Response(status_code=404)
    try:
        body = await storage.read(photo.image_url, photo.storage_key)
    except FileNotFoundError:
        return Response(status_code=404)
    return Response(
        body,
        media_type="image/webp",
        headers={
            "Cache-Control": "private, max-age=86400",
            "X-Content-Type-Options": "nosniff",
        },
    )


@rt("/shared-media/{share_id}/{photo_id}", methods=["GET"])
async def shared_photo_media(share_id: str, photo_id: str):
    if SHARE_ID_PATTERN.fullmatch(share_id) is None:
        return Response(status_code=404)
    photo = repository.get_share_photo(share_id, photo_id)
    if photo is None:
        return Response(status_code=404)
    try:
        body = await storage.read(photo.image_url, photo.storage_key)
    except FileNotFoundError:
        return Response(status_code=404)
    return Response(
        body,
        media_type="image/webp",
        headers={
            "Cache-Control": "public, max-age=31536000, immutable",
            "X-Content-Type-Options": "nosniff",
        },
    )


@rt("/healthz", methods=["GET"])
async def health():
    return JSONResponse({"ok": True})
