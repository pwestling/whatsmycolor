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

## Community boards

`/community/<slug>` is the shared-board surface. Everyone with the URL can add
photos, move any photo, and edit dates. Convex is the canonical metadata store
and pushes accepted changes to every connected client over its managed realtime
connection. Photo bytes remain in private Vercel Blob storage and are served by
the app's media proxy.

Mutations use idempotency keys and per-field versions. Conflicting moves are
accepted atomically or returned as stale; the client rebases its pending move on
the newest accepted position. Drag previews stay local and the final position is
written on release, which keeps message volume low even with many visitors.

Community boards are intentionally not self-created. Create one from an
authenticated Convex CLI session:

```bash
bunx convex run community:createBoard '{"slug":"models"}'
bunx convex run community:createBoard '{"slug":"models"}' --prod
```

Visitors can remove photos from the live board. Removal is soft: existing frozen
snapshots keep the image, and an administrator can restore it. Administrators can
also hide an upload directly:

```bash
bunx convex run community:tombstonePhoto \
  '{"slug":"models","photoId":"<32-character-photo-id>"}' --prod
bunx convex run community:restorePhoto \
  '{"slug":"models","photoId":"<32-character-photo-id>"}' --prod
```

## Run locally

```bash
uv sync
bun install
bunx convex dev
```

In another terminal:

```bash
uv run python main.py
```

Open <http://127.0.0.1:5001>. Local development uses SQLite at
`data/whatsmycolor.db` and files under `data/uploads` by default.

Run the tests with:

```bash
uv run pytest
bun run test:js
bun run typecheck
bun run test:convex
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

For Community, deploy the Convex functions first and set the production
deployment's `CONVEX_URL` and `CONVEX_SITE_URL` in Vercel. Build and commit the
browser bundle before the Python function is packaged.

```bash
bun run build:community
bunx convex deploy
vercel --prod
```

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
