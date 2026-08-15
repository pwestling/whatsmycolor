# What's My Color?

A photo board that orders painted models chronologically (vertical) and places
them by primary color (horizontal).

## What it does

- Reads `DateTimeOriginal` from JPEG, HEIC, and HEIF metadata when available.
- Falls back to a date in the filename, the file-modified date, or upload time.
- Guesses a dominant chromatic hue while treating neutral images as white or black.
- Packs consecutive photos into rows without overlap; a row may contain several dates.
- Lets the user drag a photo horizontally or edit its date, name, and color position.
- Exports the full board as a high-resolution PNG.
- Creates immutable, read-only share links that retain their original photos and layout.
- Converts uploads to orientation-corrected, metadata-free WebP images.
- Keeps each library separate with an anonymous, HTTP-only browser cookie.

## Run locally

```bash
uv sync
uv run python main.py
```

Open <http://127.0.0.1:5001>. Local development uses SQLite at
`data/whatsmycolor.db` and files under `data/uploads` by default.

Run the tests with:

```bash
uv run pytest
```

## Deploy to Vercel

The setup follows the same Python/FastHTML pattern as Colorslice:

1. Create a Vercel project from this repository.
2. Add a Postgres integration (Neon is a sensible default) and expose its pooled
   connection as `DATABASE_URL`.
3. Create and connect a **private** Vercel Blob store. Vercel adds
   `BLOB_READ_WRITE_TOKEN` to the project.
4. Deploy. `api/index.py` is the Vercel ASGI entrypoint; `main.py` runs the app
   locally.

Without `DATABASE_URL`, local development uses SQLite. A Vercel deployment can
boot without Postgres, but its `/tmp` SQLite database is ephemeral and should
not be used for real libraries. Uploads on Vercel are disabled until a Blob
store is connected.

Browser uploads larger than the Vercel Function request limit are resized before
they reach the server. Large HEIC files depend on browser decoding; exporting a
JPEG is the fallback when a browser cannot decode one.

## Current identity model

This first version is anonymous and device-bound: the browser cookie is the key
to its library. There is no account recovery or cross-device sync yet. The
database already scopes every photo to an owner id, so a sign-in provider can
replace the anonymous owner without changing the board or photo schema.
