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
        share_page = client.get(share_url)
        assert share_page.status_code == 200
        assert "Shared models by color and time" in share_page.text
        assert '<meta property="og:title" content="Shared models">' in share_page.text
        assert 'content="1 model · Apr 2024"' in share_page.text
        preview_url = f"/social-preview/{share_id}"
        assert f'content="http://testserver{preview_url}"' in share_page.text

        preview = client.get(preview_url)
        assert preview.status_code == 200
        assert preview.headers["content-type"] == "image/png"
        assert preview.headers["cache-control"].endswith("immutable")
        with Image.open(BytesIO(preview.content)) as preview_image:
            assert preview_image.size == (1200, 630)


def test_community_upload_and_snapshot_routes(tmp_path: Path, monkeypatch) -> None:
    repository = PhotoRepository(database_url="", sqlite_path=tmp_path / "app.db")
    repository.initialize()
    storage = PhotoStorage(token="", local_path=tmp_path / "uploads")
    monkeypatch.setattr(app_module, "repository", repository)
    monkeypatch.setattr(app_module, "storage", storage)
    monkeypatch.setenv("CONVEX_URL", "http://127.0.0.1:3210")
    monkeypatch.setenv("CONVEX_SITE_URL", "http://127.0.0.1:3211")
    monkeypatch.setattr(app_module, "_community_board_exists", lambda slug: slug == "models")

    photo_id = "a" * 32
    with TestClient(app_module.app) as client:
        board = client.get("/community/models")
        assert board.status_code == 200
        assert 'data-board-slug="models"' in board.text
        assert 'content="http://127.0.0.1:3210"' in board.text

        uploaded = client.post(
            "/api/community/models/photos",
            files={"photo": ("blue-knight.jpg", jpeg_bytes(), "image/jpeg")},
            data={
                "photo_id": photo_id,
                "last_modified": "2024-04-12T10:30:00Z",
            },
        )
        assert uploaded.status_code == 201
        photo = uploaded.json()["photo"]
        assert photo["id"] == photo_id
        assert photo["imageUrl"] == f"/community-media/{photo_id}"
        media = client.get(photo["imageUrl"])
        assert media.status_code == 200
        assert media.headers["cache-control"].endswith("immutable")

        rejected = client.post(
            "/api/community/missing/photos",
            files={"photo": ("blue-knight.jpg", jpeg_bytes(), "image/jpeg")},
            data={"photo_id": "c" * 32},
        )
        assert rejected.status_code == 404

        snapshot_id = "b" * 32
        snapshot_payload = {
            "snapshot": {"newestFirst": False},
            "photos": [{**photo, "photoId": photo_id}],
        }
        monkeypatch.setattr(
            app_module,
            "_community_snapshot_payload",
            lambda slug, requested_id: snapshot_payload
            if (slug, requested_id) == ("models", snapshot_id)
            else None,
        )
        shared = client.get(f"/community/models/s/{snapshot_id}")
        assert shared.status_code == 200
        assert 'data-readonly="true"' in shared.text
        assert "1 model · Apr 2024" in shared.text

        preview = client.get(f"/community-social-preview/models/{snapshot_id}")
        assert preview.status_code == 200
        assert preview.headers["content-type"] == "image/png"
        with Image.open(BytesIO(preview.content)) as preview_image:
            assert preview_image.size == (1200, 630)
