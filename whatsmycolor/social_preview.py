from dataclasses import dataclass
from datetime import datetime
from io import BytesIO

from PIL import Image, ImageDraw, ImageOps, UnidentifiedImageError

from whatsmycolor.models import Photo


PREVIEW_WIDTH = 1200
PREVIEW_HEIGHT = 630
PREVIEW_COLORS = (
    "#ff4236",
    "#ff2d76",
    "#c737df",
    "#6947df",
    "#315cda",
    "#16a9de",
    "#14a79b",
    "#18a65c",
    "#8cc744",
    "#f2dc2d",
    "#fa9a2a",
    "#eee9df",
    "#121412",
)


@dataclass(frozen=True)
class PreviewPhoto:
    photo: Photo
    body: bytes


def share_summary(photos: list[Photo]) -> str:
    count = len(photos)
    label = "model" if count == 1 else "models"
    dates = sorted(datetime.fromisoformat(photo.captured_at) for photo in photos)
    if not dates:
        return f"{count} {label}"

    oldest = dates[0]
    newest = dates[-1]
    if oldest.year == newest.year and oldest.month == newest.month:
        date_range = oldest.strftime("%b %Y")
    elif oldest.year == newest.year:
        date_range = f"{oldest:%b} — {newest:%b %Y}"
    else:
        date_range = f"{oldest:%b %Y} — {newest:%b %Y}"
    return f"{count} {label} · {date_range}"


def _ordered_photos(
    photos: list[PreviewPhoto],
    newest_first: bool,
) -> list[PreviewPhoto]:
    return sorted(
        photos,
        key=lambda item: (
            datetime.fromisoformat(item.photo.captured_at),
            datetime.fromisoformat(item.photo.created_at),
        ),
        reverse=newest_first,
    )


def _placements(
    photos: list[PreviewPhoto],
    newest_first: bool,
    card_size: int,
) -> list[tuple[PreviewPhoto, int, int]]:
    left_edge = 48
    right_edge = PREVIEW_WIDTH - 48
    top = 104
    bottom = PREVIEW_HEIGHT - 30
    gap = 6
    row = 0
    occupied: list[tuple[float, float]] = []
    placements: list[tuple[PreviewPhoto, int, int]] = []

    for item in _ordered_photos(photos, newest_first):
        available_width = right_edge - left_edge
        center = left_edge + item.photo.x_position / 100.0 * available_width
        center = max(
            left_edge + card_size / 2,
            min(right_edge - card_size / 2, center),
        )
        card_left = center - card_size / 2 - gap / 2
        card_right = center + card_size / 2 + gap / 2
        if any(card_left < right and card_right > left for left, right in occupied):
            row += 1
            occupied = []

        y = top + row * (card_size + gap)
        if y + card_size > bottom:
            break
        occupied.append((card_left, card_right))
        placements.append((item, round(center - card_size / 2), y))

    return placements


def _best_placements(
    photos: list[PreviewPhoto],
    newest_first: bool,
) -> tuple[list[tuple[PreviewPhoto, int, int]], int]:
    candidates = (96, 84, 72, 60, 48)
    limited = photos[:36]
    for card_size in candidates:
        placements = _placements(limited, newest_first, card_size)
        if len(placements) == len(limited):
            return placements, card_size
    return _placements(limited, newest_first, candidates[-1]), candidates[-1]


def render_social_preview(
    photos: list[PreviewPhoto],
    newest_first: bool,
) -> bytes:
    canvas = Image.new("RGB", (PREVIEW_WIDTH, PREVIEW_HEIGHT), "#111412")
    draw = ImageDraw.Draw(canvas)
    segment_width = (PREVIEW_WIDTH - 96) / len(PREVIEW_COLORS)
    for index, color in enumerate(PREVIEW_COLORS):
        left = round(48 + index * segment_width)
        right = round(48 + (index + 1) * segment_width)
        draw.rounded_rectangle(
            (left, 34, right - 3, 76),
            radius=5,
            fill=color,
        )

    placements, card_size = _best_placements(photos, newest_first)
    for item, left, top in placements:
        try:
            with Image.open(BytesIO(item.body)) as source:
                thumbnail = ImageOps.fit(
                    source.convert("RGB"),
                    (card_size, card_size),
                    Image.Resampling.LANCZOS,
                )
        except (OSError, UnidentifiedImageError):
            continue
        mask = Image.new("L", (card_size, card_size), 0)
        ImageDraw.Draw(mask).rounded_rectangle(
            (0, 0, card_size - 1, card_size - 1),
            radius=max(4, card_size // 14),
            fill=255,
        )
        canvas.paste(thumbnail, (left, top), mask)

    output = BytesIO()
    canvas.save(output, format="PNG", optimize=True)
    return output.getvalue()
