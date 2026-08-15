from dataclasses import asdict, dataclass


@dataclass(frozen=True)
class Photo:
    id: str
    owner_id: str
    title: str
    captured_at: str
    time_source: str
    x_position: float
    hue: float | None
    color_kind: str
    primary_color: str
    color_source: str
    image_url: str
    storage_key: str
    original_filename: str
    width: int
    height: int
    created_at: str

    def as_api_dict(self, image_url: str | None = None) -> dict[str, object]:
        values = asdict(self)
        values.pop("owner_id")
        values.pop("image_url")
        values.pop("storage_key")
        return {
            "id": values["id"],
            "title": values["title"],
            "capturedAt": values["captured_at"],
            "timeSource": values["time_source"],
            "xPosition": values["x_position"],
            "hue": values["hue"],
            "colorKind": values["color_kind"],
            "primaryColor": values["primary_color"],
            "colorSource": values["color_source"],
            "imageUrl": image_url or f"/media/{self.id}",
            "originalFilename": values["original_filename"],
            "width": values["width"],
            "height": values["height"],
            "createdAt": values["created_at"],
        }


@dataclass(frozen=True)
class BoardShare:
    id: str
    owner_id: str
    newest_first: bool
    created_at: str


@dataclass(frozen=True)
class ImageAnalysis:
    image_bytes: bytes
    width: int
    height: int
    captured_at: str
    time_source: str
    hue: float | None
    color_kind: str
    primary_color: str
    x_position: float


@dataclass(frozen=True)
class CommunityMedia:
    photo_id: str
    board_slug: str
    image_url: str
    storage_key: str
    width: int
    height: int
    created_at: str
