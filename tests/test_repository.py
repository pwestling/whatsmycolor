from datetime import datetime, timezone
from pathlib import Path

from whatsmycolor.models import BoardShare, Photo
from whatsmycolor.repository import PhotoRepository


def make_photo(photo_id: str, owner_id: str, captured_at: str) -> Photo:
    return Photo(
        id=photo_id,
        owner_id=owner_id,
        title=f"Model {photo_id}",
        captured_at=captured_at,
        time_source="photo metadata",
        x_position=32.0,
        hue=220.0,
        color_kind="hue",
        primary_color="#3366cc",
        color_source="automatic guess",
        image_url=f"data/uploads/{photo_id}.webp",
        storage_key=f"libraries/{owner_id}/{photo_id}.webp",
        original_filename=f"{photo_id}.jpg",
        width=100,
        height=120,
        created_at=datetime.now(timezone.utc).isoformat(),
    )


def repository_at(path: Path) -> PhotoRepository:
    repository = PhotoRepository(database_url="", sqlite_path=path)
    repository.initialize()
    return repository


def test_owner_libraries_are_isolated_and_sorted(tmp_path: Path) -> None:
    repository = repository_at(tmp_path / "photos.db")
    repository.insert(make_photo("old", "owner-a", "2021-01-01T12:00:00"))
    repository.insert(make_photo("new", "owner-a", "2024-01-01T12:00:00"))
    repository.insert(make_photo("other", "owner-b", "2025-01-01T12:00:00"))

    assert [photo.id for photo in repository.list_for_owner("owner-a")] == [
        "new",
        "old",
    ]
    assert repository.get_for_owner("other", "owner-a") is None


def test_updates_and_deletes_only_for_owner(tmp_path: Path) -> None:
    repository = repository_at(tmp_path / "photos.db")
    repository.insert(make_photo("one", "owner-a", "2024-01-01T12:00:00"))

    updated = repository.update_details(
        "one",
        "owner-a",
        title="Blue knight",
        captured_at="2024-02-01T12:00:00",
        time_source="set by you",
        x_position=98.0,
        hue=None,
        color_kind="black",
        primary_color="#171717",
        color_source="placed by you",
    )

    assert updated is not None
    assert updated.title == "Blue knight"
    assert updated.color_kind == "black"
    assert repository.delete("one", "owner-b") is None
    assert repository.delete("one", "owner-a") is not None
    assert repository.list_for_owner("owner-a") == []


def test_share_is_an_immutable_photo_snapshot(tmp_path: Path) -> None:
    repository = repository_at(tmp_path / "photos.db")
    photo = make_photo("one", "owner-a", "2024-01-01T12:00:00")
    repository.insert(photo)
    share = BoardShare(
        id="immutable-share-token-01",
        owner_id="owner-a",
        newest_first=False,
        created_at="2025-01-01T12:00:00+00:00",
    )
    repository.create_share(share, [photo])

    repository.update_details(
        "one",
        "owner-a",
        title="Changed later",
        captured_at="2025-02-01T12:00:00",
        time_source="set by you",
        x_position=98.0,
        hue=None,
        color_kind="black",
        primary_color="#171717",
        color_source="placed by you",
    )
    repository.delete("one", "owner-a")

    stored_share = repository.get_share(share.id)
    snapshot = repository.list_for_share(share.id)
    assert stored_share is not None
    assert stored_share.newest_first is False
    assert snapshot[0].title == "Model one"
    assert snapshot[0].x_position == 32.0
    assert repository.storage_is_shared(photo.storage_key)
