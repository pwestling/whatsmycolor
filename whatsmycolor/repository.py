from contextlib import contextmanager
import os
from pathlib import Path
import sqlite3

import psycopg
from psycopg.rows import dict_row

from whatsmycolor.models import BoardShare, CommunityMedia, Photo


SQLITE_SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    time_source TEXT NOT NULL,
    x_position REAL NOT NULL,
    hue REAL,
    color_kind TEXT NOT NULL,
    primary_color TEXT NOT NULL,
    color_source TEXT NOT NULL,
    image_url TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_owner_time_idx
ON photos(owner_id, captured_at DESC);
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    newest_first INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_owner_created_idx
ON shares(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS share_photos (
    share_id TEXT NOT NULL,
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    time_source TEXT NOT NULL,
    x_position REAL NOT NULL,
    hue REAL,
    color_kind TEXT NOT NULL,
    primary_color TEXT NOT NULL,
    color_source TEXT NOT NULL,
    image_url TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (share_id, id)
);
CREATE INDEX IF NOT EXISTS share_photos_storage_idx
ON share_photos(storage_key);
CREATE TABLE IF NOT EXISTS community_media (
    photo_id TEXT PRIMARY KEY,
    board_slug TEXT NOT NULL,
    image_url TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_media_board_idx
ON community_media(board_slug, created_at DESC);
"""

POSTGRES_SCHEMA = """
CREATE TABLE IF NOT EXISTS photos (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    time_source TEXT NOT NULL,
    x_position DOUBLE PRECISION NOT NULL,
    hue DOUBLE PRECISION,
    color_kind TEXT NOT NULL,
    primary_color TEXT NOT NULL,
    color_source TEXT NOT NULL,
    image_url TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS photos_owner_time_idx
ON photos(owner_id, captured_at DESC);
CREATE TABLE IF NOT EXISTS shares (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    newest_first BOOLEAN NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS shares_owner_created_idx
ON shares(owner_id, created_at DESC);
CREATE TABLE IF NOT EXISTS share_photos (
    share_id TEXT NOT NULL,
    id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    title TEXT NOT NULL,
    captured_at TEXT NOT NULL,
    time_source TEXT NOT NULL,
    x_position DOUBLE PRECISION NOT NULL,
    hue DOUBLE PRECISION,
    color_kind TEXT NOT NULL,
    primary_color TEXT NOT NULL,
    color_source TEXT NOT NULL,
    image_url TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (share_id, id)
);
CREATE INDEX IF NOT EXISTS share_photos_storage_idx
ON share_photos(storage_key);
CREATE TABLE IF NOT EXISTS community_media (
    photo_id TEXT PRIMARY KEY,
    board_slug TEXT NOT NULL,
    image_url TEXT NOT NULL,
    storage_key TEXT NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL,
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS community_media_board_idx
ON community_media(board_slug, created_at DESC);
"""

PHOTO_COLUMNS = (
    "id, owner_id, title, captured_at, time_source, x_position, hue, "
    "color_kind, primary_color, color_source, image_url, storage_key, "
    "original_filename, width, height, created_at"
)


def _photo_from_row(row: object) -> Photo:
    values = dict(row)
    return Photo(
        id=str(values["id"]),
        owner_id=str(values["owner_id"]),
        title=str(values["title"]),
        captured_at=str(values["captured_at"]),
        time_source=str(values["time_source"]),
        x_position=float(values["x_position"]),
        hue=float(values["hue"]) if values["hue"] is not None else None,
        color_kind=str(values["color_kind"]),
        primary_color=str(values["primary_color"]),
        color_source=str(values["color_source"]),
        image_url=str(values["image_url"]),
        storage_key=str(values["storage_key"]),
        original_filename=str(values["original_filename"]),
        width=int(values["width"]),
        height=int(values["height"]),
        created_at=str(values["created_at"]),
    )


def _share_from_row(row: object) -> BoardShare:
    values = dict(row)
    return BoardShare(
        id=str(values["id"]),
        owner_id=str(values["owner_id"]),
        newest_first=bool(values["newest_first"]),
        created_at=str(values["created_at"]),
    )


def _community_media_from_row(row: object) -> CommunityMedia:
    values = dict(row)
    return CommunityMedia(
        photo_id=str(values["photo_id"]),
        board_slug=str(values["board_slug"]),
        image_url=str(values["image_url"]),
        storage_key=str(values["storage_key"]),
        width=int(values["width"]),
        height=int(values["height"]),
        created_at=str(values["created_at"]),
    )


class PhotoRepository:
    def __init__(
        self,
        database_url: str | None = None,
        sqlite_path: Path | None = None,
    ) -> None:
        self.database_url = (
            os.environ.get("DATABASE_URL")
            if database_url is None
            else database_url
        )
        if sqlite_path is not None:
            default_path = sqlite_path
        elif os.environ.get("VERCEL"):
            default_path = Path("/tmp/whatsmycolor.db")
        else:
            default_path = Path("data/whatsmycolor.db")
        self.sqlite_path = Path(
            os.environ.get("WHATSMYCOLOR_DB_PATH", str(default_path))
        )
        self.is_postgres = bool(
            self.database_url
            and self.database_url.startswith(("postgres://", "postgresql://"))
        )

    @contextmanager
    def _connection(self):
        if self.is_postgres:
            if self.database_url is None:
                raise RuntimeError("Postgres connection URL is missing.")
            with psycopg.connect(
                self.database_url,
                row_factory=dict_row,
            ) as connection:
                yield connection
            return

        self.sqlite_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(self.sqlite_path, timeout=15)
        connection.row_factory = sqlite3.Row
        try:
            yield connection
            connection.commit()
        finally:
            connection.close()

    def initialize(self) -> None:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(POSTGRES_SCHEMA)
            else:
                connection.executescript(SQLITE_SCHEMA)

    def list_for_owner(self, owner_id: str) -> list[Photo]:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"SELECT {PHOTO_COLUMNS} FROM photos "
                        "WHERE owner_id = %s ORDER BY captured_at DESC, created_at DESC",
                        (owner_id,),
                    )
                    rows = cursor.fetchall()
            else:
                rows = connection.execute(
                    f"SELECT {PHOTO_COLUMNS} FROM photos "
                    "WHERE owner_id = ? ORDER BY captured_at DESC, created_at DESC",
                    (owner_id,),
                ).fetchall()
        return [_photo_from_row(row) for row in rows]

    def get_for_owner(self, photo_id: str, owner_id: str) -> Photo | None:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"SELECT {PHOTO_COLUMNS} FROM photos "
                        "WHERE id = %s AND owner_id = %s",
                        (photo_id, owner_id),
                    )
                    row = cursor.fetchone()
            else:
                row = connection.execute(
                    f"SELECT {PHOTO_COLUMNS} FROM photos "
                    "WHERE id = ? AND owner_id = ?",
                    (photo_id, owner_id),
                ).fetchone()
        return _photo_from_row(row) if row is not None else None

    def insert(self, photo: Photo) -> None:
        values = (
            photo.id,
            photo.owner_id,
            photo.title,
            photo.captured_at,
            photo.time_source,
            photo.x_position,
            photo.hue,
            photo.color_kind,
            photo.primary_color,
            photo.color_source,
            photo.image_url,
            photo.storage_key,
            photo.original_filename,
            photo.width,
            photo.height,
            photo.created_at,
        )
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"INSERT INTO photos ({PHOTO_COLUMNS}) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, "
                        "%s, %s, %s, %s, %s, %s, %s, %s)",
                        values,
                    )
            else:
                connection.execute(
                    f"INSERT INTO photos ({PHOTO_COLUMNS}) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    values,
                )

    def update_details(
        self,
        photo_id: str,
        owner_id: str,
        *,
        title: str,
        captured_at: str,
        time_source: str,
        x_position: float,
        hue: float | None,
        color_kind: str,
        primary_color: str,
        color_source: str,
    ) -> Photo | None:
        values = (
            title,
            captured_at,
            time_source,
            x_position,
            hue,
            color_kind,
            primary_color,
            color_source,
            photo_id,
            owner_id,
        )
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        UPDATE photos SET
                            title = %s,
                            captured_at = %s,
                            time_source = %s,
                            x_position = %s,
                            hue = %s,
                            color_kind = %s,
                            primary_color = %s,
                            color_source = %s
                        WHERE id = %s AND owner_id = %s
                        """,
                        values,
                    )
            else:
                connection.execute(
                    """
                    UPDATE photos SET
                        title = ?,
                        captured_at = ?,
                        time_source = ?,
                        x_position = ?,
                        hue = ?,
                        color_kind = ?,
                        primary_color = ?,
                        color_source = ?
                    WHERE id = ? AND owner_id = ?
                    """,
                    values,
                )
        return self.get_for_owner(photo_id, owner_id)

    def delete(self, photo_id: str, owner_id: str) -> Photo | None:
        photo = self.get_for_owner(photo_id, owner_id)
        if photo is None:
            return None
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "DELETE FROM photos WHERE id = %s AND owner_id = %s",
                        (photo_id, owner_id),
                    )
            else:
                connection.execute(
                    "DELETE FROM photos WHERE id = ? AND owner_id = ?",
                    (photo_id, owner_id),
                )
        return photo

    def create_share(
        self,
        share: BoardShare,
        photos: list[Photo],
    ) -> None:
        photo_values = [
            (
                share.id,
                photo.id,
                photo.owner_id,
                photo.title,
                photo.captured_at,
                photo.time_source,
                photo.x_position,
                photo.hue,
                photo.color_kind,
                photo.primary_color,
                photo.color_source,
                photo.image_url,
                photo.storage_key,
                photo.original_filename,
                photo.width,
                photo.height,
                photo.created_at,
            )
            for photo in photos
        ]
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "INSERT INTO shares (id, owner_id, newest_first, created_at) "
                        "VALUES (%s, %s, %s, %s)",
                        (share.id, share.owner_id, share.newest_first, share.created_at),
                    )
                    cursor.executemany(
                        f"INSERT INTO share_photos (share_id, {PHOTO_COLUMNS}) "
                        "VALUES (%s, %s, %s, %s, %s, %s, %s, %s, %s, "
                        "%s, %s, %s, %s, %s, %s, %s, %s)",
                        photo_values,
                    )
            else:
                connection.execute(
                    "INSERT INTO shares (id, owner_id, newest_first, created_at) "
                    "VALUES (?, ?, ?, ?)",
                    (share.id, share.owner_id, share.newest_first, share.created_at),
                )
                connection.executemany(
                    f"INSERT INTO share_photos (share_id, {PHOTO_COLUMNS}) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    photo_values,
                )

    def get_share(self, share_id: str) -> BoardShare | None:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT id, owner_id, newest_first, created_at "
                        "FROM shares WHERE id = %s",
                        (share_id,),
                    )
                    row = cursor.fetchone()
            else:
                row = connection.execute(
                    "SELECT id, owner_id, newest_first, created_at "
                    "FROM shares WHERE id = ?",
                    (share_id,),
                ).fetchone()
        return _share_from_row(row) if row is not None else None

    def list_for_share(self, share_id: str) -> list[Photo]:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"SELECT {PHOTO_COLUMNS} FROM share_photos "
                        "WHERE share_id = %s ORDER BY captured_at DESC, created_at DESC",
                        (share_id,),
                    )
                    rows = cursor.fetchall()
            else:
                rows = connection.execute(
                    f"SELECT {PHOTO_COLUMNS} FROM share_photos "
                    "WHERE share_id = ? ORDER BY captured_at DESC, created_at DESC",
                    (share_id,),
                ).fetchall()
        return [_photo_from_row(row) for row in rows]

    def get_share_photo(self, share_id: str, photo_id: str) -> Photo | None:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        f"SELECT {PHOTO_COLUMNS} FROM share_photos "
                        "WHERE share_id = %s AND id = %s",
                        (share_id, photo_id),
                    )
                    row = cursor.fetchone()
            else:
                row = connection.execute(
                    f"SELECT {PHOTO_COLUMNS} FROM share_photos "
                    "WHERE share_id = ? AND id = ?",
                    (share_id, photo_id),
                ).fetchone()
        return _photo_from_row(row) if row is not None else None

    def storage_is_shared(self, storage_key: str) -> bool:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        "SELECT 1 FROM share_photos WHERE storage_key = %s LIMIT 1",
                        (storage_key,),
                    )
                    row = cursor.fetchone()
            else:
                row = connection.execute(
                    "SELECT 1 FROM share_photos WHERE storage_key = ? LIMIT 1",
                    (storage_key,),
                ).fetchone()
        return row is not None

    def insert_community_media(self, media: CommunityMedia) -> None:
        values = (
            media.photo_id,
            media.board_slug,
            media.image_url,
            media.storage_key,
            media.width,
            media.height,
            media.created_at,
        )
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        INSERT INTO community_media (
                            photo_id, board_slug, image_url, storage_key,
                            width, height, created_at
                        ) VALUES (%s, %s, %s, %s, %s, %s, %s)
                        ON CONFLICT (photo_id) DO NOTHING
                        """,
                        values,
                    )
            else:
                connection.execute(
                    """
                    INSERT OR IGNORE INTO community_media (
                        photo_id, board_slug, image_url, storage_key,
                        width, height, created_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?)
                    """,
                    values,
                )

    def get_community_media(self, photo_id: str) -> CommunityMedia | None:
        with self._connection() as connection:
            if self.is_postgres:
                with connection.cursor() as cursor:
                    cursor.execute(
                        """
                        SELECT photo_id, board_slug, image_url, storage_key,
                               width, height, created_at
                        FROM community_media WHERE photo_id = %s
                        """,
                        (photo_id,),
                    )
                    row = cursor.fetchone()
            else:
                row = connection.execute(
                    """
                    SELECT photo_id, board_slug, image_url, storage_key,
                           width, height, created_at
                    FROM community_media WHERE photo_id = ?
                    """,
                    (photo_id,),
                ).fetchone()
        return _community_media_from_row(row) if row is not None else None
