from dataclasses import dataclass
import os
from pathlib import Path

from vercel.blob import AsyncBlobClient


@dataclass(frozen=True)
class StoredImage:
    url: str
    key: str


class PhotoStorage:
    def __init__(
        self,
        token: str | None = None,
        local_path: Path | None = None,
    ) -> None:
        self.token = (
            os.environ.get("BLOB_READ_WRITE_TOKEN")
            if token is None
            else token
        )
        self.local_path = local_path or Path(
            os.environ.get("WHATSMYCOLOR_UPLOAD_PATH", "data/uploads")
        )
        self.client = AsyncBlobClient(token=self.token) if self.token else None

    @property
    def is_blob(self) -> bool:
        return self.client is not None

    async def put(self, owner_id: str, photo_id: str, body: bytes) -> StoredImage:
        key = f"libraries/{owner_id[:12]}/{photo_id}.webp"
        if self.client is not None:
            uploaded = await self.client.put(
                key,
                body,
                access="private",
                content_type="image/webp",
                cache_control_max_age=31_536_000,
            )
            return StoredImage(url=uploaded.url, key=uploaded.pathname)

        if os.environ.get("VERCEL"):
            raise RuntimeError(
                "Connect a private Vercel Blob store before uploading photos."
            )
        destination = self.local_path / key
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(body)
        return StoredImage(url=str(destination), key=key)

    async def read(self, url: str, key: str) -> bytes:
        if self.client is not None:
            result = await self.client.get(url, access="private")
            return result.content
        path = self.local_path / key
        return path.read_bytes()

    async def delete(self, url: str, key: str) -> None:
        if self.client is not None:
            await self.client.delete(url)
            return
        path = self.local_path / key
        path.unlink(missing_ok=True)
