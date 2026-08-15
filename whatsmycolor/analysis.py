import colorsys
from datetime import datetime, timezone
from io import BytesIO
import math
import re

from PIL import ExifTags, Image, ImageOps, UnidentifiedImageError
import pillow_heif

from whatsmycolor.models import ImageAnalysis


pillow_heif.register_heif_opener()
Image.MAX_IMAGE_PIXELS = 45_000_000

MAX_SOURCE_BYTES = 18 * 1024 * 1024
MAX_IMAGE_EDGE = 2400
ANALYSIS_EDGE = 144
HUE_BIN_COUNT = 48
CHROMATIC_X_END = 86.0
CHROMATIC_HUE_SPAN = 330.0
SUPPORTED_FORMATS = {"AVIF", "HEIF", "HEIC", "JPEG", "PNG", "WEBP"}
EXIF_DATE_TAGS = (36867, 36868, 306)
EXIF_DATE_FORMATS = (
    "%Y:%m:%d %H:%M:%S",
    "%Y-%m-%d %H:%M:%S",
    "%Y:%m:%d",
    "%Y-%m-%d",
)
FILENAME_DATE_PATTERNS = (
    re.compile(r"(?<!\d)(20\d{2})[-_]?([01]\d)[-_]?([0-3]\d)[-_ T]?([0-2]\d)?[-_.:]?([0-5]\d)?[-_.:]?([0-5]\d)?"),
    re.compile(r"(?<!\d)(19\d{2})[-_]?([01]\d)[-_]?([0-3]\d)"),
)


class InvalidImageError(ValueError):
    """Raised when an upload cannot be safely treated as a supported image."""


def hue_to_x_position(hue: float) -> float:
    normalized = hue % 360.0
    if normalized < 18.0 or normalized > 345.0:
        return 0.0
    visual_hue = min((360.0 - normalized) % 360.0, CHROMATIC_HUE_SPAN)
    return round(visual_hue / CHROMATIC_HUE_SPAN * CHROMATIC_X_END, 3)


def _parse_exif_date(value: object) -> datetime | None:
    if not isinstance(value, (str, bytes)):
        return None
    text = value.decode(errors="ignore") if isinstance(value, bytes) else value
    text = text.strip().strip("\x00")
    for date_format in EXIF_DATE_FORMATS:
        try:
            return datetime.strptime(text, date_format)
        except ValueError:
            continue
    return None


def _parse_iso_hint(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.strip().replace("Z", "+00:00"))
    except ValueError:
        return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _date_from_filename(filename: str) -> datetime | None:
    for pattern in FILENAME_DATE_PATTERNS:
        match = pattern.search(filename)
        if match is None:
            continue
        parts = list(match.groups(default="0"))
        parts.extend(["0"] * (6 - len(parts)))
        try:
            year, month, day, hour, minute, second = (
                int(part) for part in parts[:6]
            )
            return datetime(year, month, day, hour, minute, second)
        except ValueError:
            continue
    return None


def _capture_time(
    image: Image.Image,
    original_filename: str,
    captured_at_hint: str | None,
    last_modified_hint: str | None,
) -> tuple[str, str]:
    exif = image.getexif()
    exif_details = exif.get_ifd(ExifTags.IFD.Exif)
    for values in (exif_details, exif):
        for tag in EXIF_DATE_TAGS:
            parsed = _parse_exif_date(values.get(tag))
            if parsed is not None:
                return parsed.isoformat(timespec="seconds"), "photo metadata"

    explicit_hint = _parse_iso_hint(captured_at_hint)
    if explicit_hint is not None:
        return explicit_hint.isoformat(timespec="seconds"), "photo metadata"

    filename_date = _date_from_filename(original_filename)
    if filename_date is not None:
        return filename_date.isoformat(timespec="seconds"), "filename"

    modified = _parse_iso_hint(last_modified_hint)
    if modified is not None:
        return modified.isoformat(timespec="seconds"), "file date"

    now = datetime.now(timezone.utc).replace(tzinfo=None)
    return now.isoformat(timespec="seconds"), "upload time"


def _pixel_hue_profile(image: Image.Image) -> tuple[float | None, str, str, float]:
    sample = image.copy()
    sample.thumbnail((ANALYSIS_EDGE, ANALYSIS_EDGE), Image.Resampling.LANCZOS)
    rgb = sample.convert("RGB")
    pixels = list(rgb.get_flattened_data())
    if not pixels:
        return None, "black", "#171717", 98.0

    histogram = [0.0] * HUE_BIN_COUNT
    weighted_colors: list[tuple[float, float, float, float, float]] = []
    brightnesses: list[float] = []

    for red_byte, green_byte, blue_byte in pixels:
        red = red_byte / 255.0
        green = green_byte / 255.0
        blue = blue_byte / 255.0
        hue, saturation, value = colorsys.rgb_to_hsv(red, green, blue)
        brightnesses.append(value)
        if saturation < 0.16 or value < 0.10 or value > 0.98:
            continue
        hue_degrees = hue * 360.0
        weight = saturation**1.75 * (0.35 + value * 0.65)
        bin_index = int(hue_degrees / 360.0 * HUE_BIN_COUNT) % HUE_BIN_COUNT
        histogram[bin_index] += weight
        weighted_colors.append((hue_degrees, weight, red, green, blue))

    chromatic_weight = sum(histogram)
    if chromatic_weight < len(pixels) * 0.035:
        brightnesses.sort()
        median = brightnesses[len(brightnesses) // 2]
        if median >= 0.56:
            return None, "white", "#f1efe9", 93.0
        return None, "black", "#171717", 98.0

    smoothed = []
    for index in range(HUE_BIN_COUNT):
        score = (
            histogram[index] * 1.0
            + histogram[(index - 1) % HUE_BIN_COUNT] * 0.58
            + histogram[(index + 1) % HUE_BIN_COUNT] * 0.58
            + histogram[(index - 2) % HUE_BIN_COUNT] * 0.18
            + histogram[(index + 2) % HUE_BIN_COUNT] * 0.18
        )
        smoothed.append(score)
    dominant_index = max(range(HUE_BIN_COUNT), key=smoothed.__getitem__)
    bin_width = 360.0 / HUE_BIN_COUNT
    center = (dominant_index + 0.5) * bin_width

    nearby = []
    for color in weighted_colors:
        distance = abs((color[0] - center + 180.0) % 360.0 - 180.0)
        if distance <= bin_width * 2.4:
            nearby.append(color)
    if not nearby:
        nearby = weighted_colors

    sine = sum(math.sin(math.radians(color[0])) * color[1] for color in nearby)
    cosine = sum(math.cos(math.radians(color[0])) * color[1] for color in nearby)
    hue = math.degrees(math.atan2(sine, cosine)) % 360.0
    total_weight = sum(color[1] for color in nearby)
    red = sum(color[2] * color[1] for color in nearby) / total_weight
    green = sum(color[3] * color[1] for color in nearby) / total_weight
    blue = sum(color[4] * color[1] for color in nearby) / total_weight
    primary_color = f"#{round(red * 255):02x}{round(green * 255):02x}{round(blue * 255):02x}"
    return round(hue, 2), "hue", primary_color, hue_to_x_position(hue)


def analyze_image(
    source_bytes: bytes,
    original_filename: str,
    captured_at_hint: str | None = None,
    last_modified_hint: str | None = None,
) -> ImageAnalysis:
    if not source_bytes:
        raise InvalidImageError("That file is empty.")
    if len(source_bytes) > MAX_SOURCE_BYTES:
        raise InvalidImageError("That photo is larger than the 18 MB upload limit.")

    try:
        with Image.open(BytesIO(source_bytes)) as source:
            source.load()
            if source.format not in SUPPORTED_FORMATS:
                raise InvalidImageError(
                    "Use a JPEG, PNG, WebP, AVIF, HEIC, or HEIF image."
                )
            captured_at, time_source = _capture_time(
                source,
                original_filename,
                captured_at_hint,
                last_modified_hint,
            )
            image = ImageOps.exif_transpose(source).convert("RGB")
    except (Image.DecompressionBombError, OSError, UnidentifiedImageError) as error:
        raise InvalidImageError("That file could not be read as an image.") from error

    image.thumbnail((MAX_IMAGE_EDGE, MAX_IMAGE_EDGE), Image.Resampling.LANCZOS)
    hue, color_kind, primary_color, x_position = _pixel_hue_profile(image)
    output = BytesIO()
    image.save(output, format="WEBP", quality=88, method=6)

    return ImageAnalysis(
        image_bytes=output.getvalue(),
        width=image.width,
        height=image.height,
        captured_at=captured_at,
        time_source=time_source,
        hue=hue,
        color_kind=color_kind,
        primary_color=primary_color,
        x_position=x_position,
    )
