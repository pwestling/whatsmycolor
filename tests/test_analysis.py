from io import BytesIO

from PIL import Image

from whatsmycolor.analysis import analyze_image, hue_to_x_position


def image_bytes(color: tuple[int, int, int], exif_date: str | None = None) -> bytes:
    image = Image.new("RGB", (120, 90), color)
    exif = image.getexif()
    if exif_date is not None:
        exif[36867] = exif_date
    output = BytesIO()
    image.save(output, format="JPEG", exif=exif)
    return output.getvalue()


def test_extracts_exif_date_and_places_red_at_start() -> None:
    result = analyze_image(
        image_bytes((220, 35, 38), "2024:05:06 14:30:02"),
        "model.jpg",
    )

    assert result.captured_at == "2024-05-06T14:30:02"
    assert result.time_source == "photo metadata"
    assert result.color_kind == "hue"
    assert result.hue is not None
    assert result.hue < 8 or result.hue > 352
    assert result.x_position < 3
    assert result.image_bytes.startswith(b"RIFF")


def test_uses_filename_date_before_file_modified_hint() -> None:
    result = analyze_image(
        image_bytes((80, 120, 210)),
        "mini_2021-03-14.jpg",
        last_modified_hint="2026-08-14T10:00:00Z",
    )

    assert result.captured_at == "2021-03-14T00:00:00"
    assert result.time_source == "filename"


def test_places_neutral_images_in_white_or_black_zones() -> None:
    white = analyze_image(image_bytes((238, 238, 235)), "white.jpg")
    black = analyze_image(image_bytes((22, 24, 22)), "black.jpg")

    assert (white.color_kind, white.x_position) == ("white", 93.0)
    assert (black.color_kind, black.x_position) == ("black", 98.0)


def test_hue_axis_follows_reference_order() -> None:
    assert hue_to_x_position(0) < hue_to_x_position(300)
    assert hue_to_x_position(300) < hue_to_x_position(240)
    assert hue_to_x_position(240) < hue_to_x_position(120)
    assert hue_to_x_position(120) < hue_to_x_position(60)

