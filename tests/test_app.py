from io import BytesIO
from pathlib import Path

from PIL import Image
from starlette.testclient import TestClient

import whatsmycolor.app as app_module
from whatsmycolor.repository import PhotoRepository
from whatsmycolor.storage import PhotoStorage


def jpeg_bytes() -> bytes:
    image = Image.new("RGB", (160, 120), (35, 95, 210))
    output = BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


def test_photo_lifecycle(tmp_path: Path, monkeypatch) -> None:
    repository = PhotoRepository(database_url="", sqlite_path=tmp_path / "app.db")
    repository.initialize()
    storage = PhotoStorage(token="", local_path=tmp_path / "uploads")
    monkeypatch.setattr(app_module, "repository", repository)
    monkeypatch.setattr(app_module, "storage", storage)

    with TestClient(app_module.app) as client:
        home = client.get("/")
        assert home.status_code == 200
        assert "Models by color and time" in home.text

        uploaded = client.post(
            "/api/photos",
            files={"photo": ("blue-knight.jpg", jpeg_bytes(), "image/jpeg")},
            data={"last_modified": "2024-04-12T10:30:00Z"},
        )
        assert uploaded.status_code == 201
        photo = uploaded.json()["photo"]
        assert photo["title"] == "blue knight"
        assert photo["capturedAt"] == "2024-04-12T10:30:00"

        listing = client.get("/api/photos")
        assert [item["id"] for item in listing.json()["photos"]] == [photo["id"]]

        media = client.get(photo["imageUrl"])
        assert media.status_code == 200
        assert media.headers["content-type"] == "image/webp"

        updated = client.patch(
            f"/api/photos/{photo['id']}",
            json={"xPosition": 98, "title": "Night Knight"},
        )
        assert updated.status_code == 200
        assert updated.json()["photo"]["colorKind"] == "black"

        deleted = client.delete(f"/api/photos/{photo['id']}")
        assert deleted.status_code == 204
        assert client.get(photo["imageUrl"]).status_code == 404


def test_shared_board_stays_frozen_after_edits_and_deletion(tmp_path: Path, monkeypatch) -> None:
    repository = PhotoRepository(database_url="", sqlite_path=tmp_path / "app.db")
    repository.initialize()
    storage = PhotoStorage(token="", local_path=tmp_path / "uploads")
    monkeypatch.setattr(app_module, "repository", repository)
    monkeypatch.setattr(app_module, "storage", storage)

    with TestClient(app_module.app) as client:
        client.get("/")
        uploaded = client.post(
            "/api/photos",
            files={"photo": ("blue-knight.jpg", jpeg_bytes(), "image/jpeg")},
            data={"last_modified": "2024-04-12T10:30:00Z"},
        )
        photo = uploaded.json()["photo"]
        shared = client.post("/api/shares", json={"newestFirst": False})
        assert shared.status_code == 201
        share_url = shared.json()["url"]
        share_id = shared.json()["id"]

        client.patch(
            f"/api/photos/{photo['id']}",
            json={"title": "Changed later", "xPosition": 98},
        )
        client.delete(f"/api/photos/{photo['id']}")

        snapshot = client.get(f"/api/shares/{share_id}")
        assert snapshot.status_code == 200
        assert snapshot.json()["share"]["newestFirst"] is False
        assert snapshot.json()["photos"][0]["title"] == "blue knight"
        assert snapshot.json()["photos"][0]["xPosition"] != 98
        shared_media = snapshot.json()["photos"][0]["imageUrl"]
        assert client.get(shared_media).status_code == 200
        assert client.get(share_url).status_code == 200
        assert "Shared models by color and time" in client.get(share_url).text
