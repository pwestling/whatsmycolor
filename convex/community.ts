import { ConvexError, v } from "convex/values";

import type { Doc, Id } from "./_generated/dataModel";
import { internal } from "./_generated/api";
import type { MutationCtx, QueryCtx } from "./_generated/server";
import { internalMutation, mutation, query } from "./_generated/server";

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const PHOTO_ID_PATTERN = /^[a-f0-9]{32}$/;
const MAX_BOARD_PHOTOS = 1_500;
const MAX_TITLE_LENGTH = 90;
const OPERATION_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const OPERATION_CLEANUP_BATCH = 500;

const photoArguments = {
  photoId: v.string(),
  title: v.string(),
  capturedAt: v.string(),
  timeSource: v.string(),
  xPosition: v.number(),
  hue: v.union(v.number(), v.null()),
  colorKind: v.string(),
  primaryColor: v.string(),
  colorSource: v.string(),
  imageUrl: v.string(),
  originalFilename: v.string(),
  width: v.number(),
  height: v.number(),
  createdAt: v.string(),
};

function requireSlug(slug: string): string {
  const cleaned = slug.trim().toLowerCase();
  if (!SLUG_PATTERN.test(cleaned)) {
    throw new ConvexError("Board not found.");
  }
  return cleaned;
}

function requirePhotoId(photoId: string): string {
  if (!PHOTO_ID_PATTERN.test(photoId)) {
    throw new ConvexError("Photo not found.");
  }
  return photoId;
}

function requirePublicId(value: string, message: string): string {
  if (!PHOTO_ID_PATTERN.test(value)) throw new ConvexError(message);
  return value;
}

function requireIsoDate(value: string): string {
  const cleaned = value.trim();
  const timestamp = Date.parse(cleaned);
  if (!Number.isFinite(timestamp)) {
    throw new ConvexError("Choose a valid date.");
  }
  const year = new Date(timestamp).getUTCFullYear();
  if (year < 1800 || year > 2200) {
    throw new ConvexError("Choose a date between 1800 and 2200.");
  }
  return cleaned;
}

function requirePosition(value: number): number {
  if (!Number.isFinite(value)) {
    throw new ConvexError("Choose a valid color position.");
  }
  return Math.round(Math.min(100, Math.max(0, value)) * 1_000) / 1_000;
}

function manualColor(xPosition: number): {
  hue: number | null;
  colorKind: string;
  primaryColor: string;
} {
  if (xPosition > 95) {
    return { hue: null, colorKind: "black", primaryColor: "#171717" };
  }
  if (xPosition > 87) {
    return { hue: null, colorKind: "white", primaryColor: "#f1efe9" };
  }
  const hue = xPosition <= 1
    ? 0
    : (360 - Math.min(xPosition, 86) / 86 * 330) % 360;
  const saturation = 0.72;
  const value = 0.86;
  const chroma = value * saturation;
  const section = hue / 60;
  const secondary = chroma * (1 - Math.abs(section % 2 - 1));
  const offset = value - chroma;
  let red = 0;
  let green = 0;
  let blue = 0;
  if (section < 1) [red, green, blue] = [chroma, secondary, 0];
  else if (section < 2) [red, green, blue] = [secondary, chroma, 0];
  else if (section < 3) [red, green, blue] = [0, chroma, secondary];
  else if (section < 4) [red, green, blue] = [0, secondary, chroma];
  else if (section < 5) [red, green, blue] = [secondary, 0, chroma];
  else [red, green, blue] = [chroma, 0, secondary];
  const hex = [red, green, blue]
    .map((component) => Math.round((component + offset) * 255).toString(16).padStart(2, "0"))
    .join("");
  return {
    hue: Math.round(hue * 100) / 100,
    colorKind: "hue",
    primaryColor: `#${hex}`,
  };
}

async function boardBySlug(
  ctx: QueryCtx | MutationCtx,
  slug: string,
): Promise<Doc<"boards"> | null> {
  return await ctx.db
    .query("boards")
    .withIndex("by_slug", (queryBuilder) => queryBuilder.eq("slug", slug))
    .unique();
}

async function photoByPublicId(
  ctx: QueryCtx | MutationCtx,
  boardId: Id<"boards">,
  photoId: string,
): Promise<Doc<"photos"> | null> {
  return await ctx.db
    .query("photos")
    .withIndex("by_boardId_and_photoId", (queryBuilder) => (
      queryBuilder.eq("boardId", boardId).eq("photoId", photoId)
    ))
    .unique();
}

function isActivePhoto(photo: Doc<"photos">): boolean {
  return photo.deletedAt === undefined;
}

async function hasOperation(
  ctx: MutationCtx,
  boardId: Id<"boards">,
  opId: string,
): Promise<boolean> {
  const operation = await ctx.db
    .query("operations")
    .withIndex("by_boardId_and_opId", (queryBuilder) => (
      queryBuilder.eq("boardId", boardId).eq("opId", opId)
    ))
    .unique();
  return operation !== null;
}

async function recordOperation(
  ctx: MutationCtx,
  boardId: Id<"boards">,
  opId: string,
  photoId: string,
  kind: string,
  clientId: string,
): Promise<void> {
  await ctx.db.insert("operations", {
    boardId,
    opId,
    photoId,
    kind,
    clientId,
    createdAt: new Date().toISOString(),
  });
}

export const getBoard = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const board = await boardBySlug(ctx, slug);
    if (board === null) return null;
    const photos = await ctx.db
      .query("photos")
      .withIndex("by_boardId", (queryBuilder) => queryBuilder.eq("boardId", board._id))
      .collect();
    return { board, photos: photos.filter(isActivePhoto) };
  },
});

export const boardExists = query({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    return await boardBySlug(ctx, slug) !== null;
  },
});

export const createBoard = internalMutation({
  args: { slug: v.string() },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const existing = await boardBySlug(ctx, slug);
    if (existing !== null) return existing;
    const now = new Date().toISOString();
    const boardId = await ctx.db.insert("boards", {
      slug,
      createdAt: now,
      lastActivityAt: now,
      photoCount: 0,
    });
    return await ctx.db.get(boardId);
  },
});

export const tombstonePhoto = internalMutation({
  args: { slug: v.string(), photoId: v.string() },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const photoId = requirePhotoId(args.photoId);
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const photo = await photoByPublicId(ctx, board._id, photoId);
    if (photo === null) throw new ConvexError("Photo not found.");
    if (!isActivePhoto(photo)) return photo;
    const now = new Date().toISOString();
    await ctx.db.patch(photo._id, { deletedAt: now });
    await ctx.db.patch(board._id, {
      photoCount: Math.max(0, board.photoCount - 1),
      lastActivityAt: now,
    });
    return await ctx.db.get(photo._id);
  },
});

export const restorePhoto = internalMutation({
  args: { slug: v.string(), photoId: v.string() },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const photoId = requirePhotoId(args.photoId);
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const photo = await photoByPublicId(ctx, board._id, photoId);
    if (photo === null) throw new ConvexError("Photo not found.");
    if (isActivePhoto(photo)) return photo;
    const now = new Date().toISOString();
    await ctx.db.patch(photo._id, { deletedAt: undefined });
    await ctx.db.patch(board._id, {
      photoCount: board.photoCount + 1,
      lastActivityAt: now,
    });
    return await ctx.db.get(photo._id);
  },
});

export const deleteExpiredOperations = internalMutation({
  args: {},
  handler: async (ctx) => {
    const cutoff = new Date(Date.now() - OPERATION_RETENTION_MS).toISOString();
    const expired = await ctx.db
      .query("operations")
      .withIndex("by_createdAt", (queryBuilder) => queryBuilder.lt("createdAt", cutoff))
      .take(OPERATION_CLEANUP_BATCH);
    await Promise.all(expired.map((operation) => ctx.db.delete(operation._id)));
    if (expired.length === OPERATION_CLEANUP_BATCH) {
      await ctx.scheduler.runAfter(0, internal.community.deleteExpiredOperations, {});
    }
    return expired.length;
  },
});

export const addPhoto = mutation({
  args: {
    slug: v.string(),
    opId: v.string(),
    clientId: v.string(),
    ...photoArguments,
  },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const photoId = requirePhotoId(args.photoId);
    const opId = requirePublicId(args.opId, "Could not add that photo.");
    const clientId = requirePublicId(args.clientId, "Could not add that photo.");
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const existing = await photoByPublicId(ctx, board._id, photoId);
    if (existing !== null) return { status: "duplicate" as const, photo: existing };
    if (await hasOperation(ctx, board._id, opId)) {
      throw new ConvexError("This upload was already processed.");
    }
    if (board.photoCount >= MAX_BOARD_PHOTOS) {
      throw new ConvexError("This board has reached its photo limit.");
    }
    const title = args.title.trim().slice(0, MAX_TITLE_LENGTH) || "Untitled model";
    const xPosition = requirePosition(args.xPosition);
    const capturedAt = requireIsoDate(args.capturedAt);
    if (args.imageUrl !== `/community-media/${photoId}`) {
      throw new ConvexError("Could not use that photo.");
    }
    if (args.hue !== null && !Number.isFinite(args.hue)) {
      throw new ConvexError("Could not use that color.");
    }
    const hue = args.hue === null
      ? null
      : Math.round((((args.hue % 360) + 360) % 360) * 100) / 100;
    const colorKind = ["hue", "white", "black"].includes(args.colorKind)
      ? args.colorKind
      : "hue";
    const primaryColor = /^#[a-f0-9]{6}$/i.test(args.primaryColor)
      ? args.primaryColor.toLowerCase()
      : "#777777";
    const photoDocument = {
      boardId: board._id,
      photoId,
      title,
      capturedAt,
      timeSource: args.timeSource.slice(0, 40),
      xPosition,
      hue,
      colorKind,
      primaryColor,
      colorSource: args.colorSource.slice(0, 40),
      imageUrl: args.imageUrl.slice(0, 200),
      originalFilename: args.originalFilename.slice(0, 255),
      width: Math.min(2400, Math.max(1, Math.round(args.width))),
      height: Math.min(2400, Math.max(1, Math.round(args.height))),
      createdAt: requireIsoDate(args.createdAt),
      hueVersion: 0,
      timeVersion: 0,
    };
    const id = await ctx.db.insert("photos", photoDocument);
    await ctx.db.patch(board._id, {
      photoCount: board.photoCount + 1,
      lastActivityAt: new Date().toISOString(),
    });
    await recordOperation(ctx, board._id, opId, photoId, "photo.add", clientId);
    return { status: "accepted" as const, photo: await ctx.db.get(id) };
  },
});

export const movePhoto = mutation({
  args: {
    slug: v.string(),
    photoId: v.string(),
    xPosition: v.number(),
    baseVersion: v.number(),
    opId: v.string(),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const photoId = requirePhotoId(args.photoId);
    const opId = requirePublicId(args.opId, "Could not move that photo.");
    const clientId = requirePublicId(args.clientId, "Could not move that photo.");
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const photo = await photoByPublicId(ctx, board._id, photoId);
    if (photo === null || !isActivePhoto(photo)) throw new ConvexError("Photo not found.");
    if (await hasOperation(ctx, board._id, opId)) {
      return { status: "duplicate" as const, photo };
    }
    if (photo.hueVersion !== args.baseVersion) {
      return { status: "stale" as const, photo };
    }
    const xPosition = requirePosition(args.xPosition);
    const color = manualColor(xPosition);
    await ctx.db.patch(photo._id, {
      xPosition,
      ...color,
      colorSource: "placed by a visitor",
      hueVersion: photo.hueVersion + 1,
    });
    await ctx.db.patch(board._id, { lastActivityAt: new Date().toISOString() });
    await recordOperation(ctx, board._id, opId, photoId, "photo.hue.set", clientId);
    const updated = await ctx.db.get(photo._id);
    return { status: "accepted" as const, photo: updated };
  },
});

export const removePhoto = mutation({
  args: {
    slug: v.string(),
    photoId: v.string(),
    opId: v.string(),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const photoId = requirePhotoId(args.photoId);
    const opId = requirePublicId(args.opId, "Could not remove that photo.");
    const clientId = requirePublicId(args.clientId, "Could not remove that photo.");
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const photo = await photoByPublicId(ctx, board._id, photoId);
    if (await hasOperation(ctx, board._id, opId)) {
      return { status: "duplicate" as const, photoId };
    }
    if (photo === null || !isActivePhoto(photo)) {
      return { status: "missing" as const, photoId };
    }
    const now = new Date().toISOString();
    await ctx.db.patch(photo._id, { deletedAt: now });
    await ctx.db.patch(board._id, {
      photoCount: Math.max(0, board.photoCount - 1),
      lastActivityAt: now,
    });
    await recordOperation(ctx, board._id, opId, photoId, "photo.remove", clientId);
    return { status: "accepted" as const, photoId };
  },
});

export const setPhotoDate = mutation({
  args: {
    slug: v.string(),
    photoId: v.string(),
    capturedAt: v.string(),
    baseVersion: v.number(),
    opId: v.string(),
    clientId: v.string(),
  },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    const photoId = requirePhotoId(args.photoId);
    const opId = requirePublicId(args.opId, "Could not set that date.");
    const clientId = requirePublicId(args.clientId, "Could not set that date.");
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const photo = await photoByPublicId(ctx, board._id, photoId);
    if (photo === null || !isActivePhoto(photo)) throw new ConvexError("Photo not found.");
    if (await hasOperation(ctx, board._id, opId)) {
      return { status: "duplicate" as const, photo };
    }
    if (photo.timeVersion !== args.baseVersion) {
      return { status: "stale" as const, photo };
    }
    await ctx.db.patch(photo._id, {
      capturedAt: requireIsoDate(args.capturedAt),
      timeSource: "set by a visitor",
      timeVersion: photo.timeVersion + 1,
    });
    await ctx.db.patch(board._id, { lastActivityAt: new Date().toISOString() });
    await recordOperation(ctx, board._id, opId, photoId, "photo.time.set", clientId);
    const updated = await ctx.db.get(photo._id);
    return { status: "accepted" as const, photo: updated };
  },
});

export const createSnapshot = mutation({
  args: {
    slug: v.string(),
    snapshotId: v.string(),
    newestFirst: v.boolean(),
  },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    if (!PHOTO_ID_PATTERN.test(args.snapshotId)) {
      throw new ConvexError("Could not create that snapshot.");
    }
    const board = await boardBySlug(ctx, slug);
    if (board === null) throw new ConvexError("Board not found.");
    const existing = await ctx.db
      .query("snapshots")
      .withIndex("by_boardId_and_snapshotId", (queryBuilder) => (
        queryBuilder.eq("boardId", board._id).eq("snapshotId", args.snapshotId)
      ))
      .unique();
    if (existing !== null) return existing;
    const photos = await ctx.db
      .query("photos")
      .withIndex("by_boardId", (queryBuilder) => queryBuilder.eq("boardId", board._id))
      .collect();
    const activePhotos = photos.filter(isActivePhoto);
    if (activePhotos.length === 0) throw new ConvexError("Add a photo before sharing.");
    const now = new Date().toISOString();
    const snapshotDocumentId = await ctx.db.insert("snapshots", {
      boardId: board._id,
      snapshotId: args.snapshotId,
      newestFirst: args.newestFirst,
      createdAt: now,
      photoCount: activePhotos.length,
    });
    for (const photo of activePhotos) {
      await ctx.db.insert("snapshotPhotos", {
        boardId: board._id,
        snapshotId: args.snapshotId,
        photoId: photo.photoId,
        title: photo.title,
        capturedAt: photo.capturedAt,
        timeSource: photo.timeSource,
        xPosition: photo.xPosition,
        hue: photo.hue,
        colorKind: photo.colorKind,
        primaryColor: photo.primaryColor,
        colorSource: photo.colorSource,
        imageUrl: photo.imageUrl,
        originalFilename: photo.originalFilename,
        width: photo.width,
        height: photo.height,
        createdAt: photo.createdAt,
        hueVersion: photo.hueVersion,
        timeVersion: photo.timeVersion,
      });
    }
    return await ctx.db.get(snapshotDocumentId);
  },
});

export const getSnapshot = query({
  args: { slug: v.string(), snapshotId: v.string() },
  handler: async (ctx, args) => {
    const slug = requireSlug(args.slug);
    if (!PHOTO_ID_PATTERN.test(args.snapshotId)) return null;
    const board = await boardBySlug(ctx, slug);
    if (board === null) return null;
    const snapshot = await ctx.db
      .query("snapshots")
      .withIndex("by_boardId_and_snapshotId", (queryBuilder) => (
        queryBuilder.eq("boardId", board._id).eq("snapshotId", args.snapshotId)
      ))
      .unique();
    if (snapshot === null) return null;
    const photos = await ctx.db
      .query("snapshotPhotos")
      .withIndex("by_boardId_and_snapshotId", (queryBuilder) => (
        queryBuilder.eq("boardId", board._id).eq("snapshotId", args.snapshotId)
      ))
      .collect();
    return { board, snapshot, photos };
  },
});
