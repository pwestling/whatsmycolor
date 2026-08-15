import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

const photoFields = {
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
  hueVersion: v.number(),
  timeVersion: v.number(),
};

export default defineSchema({
  boards: defineTable({
    slug: v.string(),
    createdAt: v.string(),
    lastActivityAt: v.string(),
    photoCount: v.number(),
  }).index("by_slug", ["slug"]),

  photos: defineTable({
    boardId: v.id("boards"),
    deletedAt: v.optional(v.string()),
    ...photoFields,
  })
    .index("by_boardId", ["boardId"])
    .index("by_boardId_and_photoId", ["boardId", "photoId"]),

  operations: defineTable({
    boardId: v.id("boards"),
    opId: v.string(),
    photoId: v.string(),
    kind: v.string(),
    clientId: v.optional(v.string()),
    createdAt: v.string(),
  })
    .index("by_boardId_and_opId", ["boardId", "opId"])
    .index("by_createdAt", ["createdAt"]),

  snapshots: defineTable({
    boardId: v.id("boards"),
    snapshotId: v.string(),
    newestFirst: v.boolean(),
    createdAt: v.string(),
    photoCount: v.number(),
  }).index("by_boardId_and_snapshotId", ["boardId", "snapshotId"]),

  snapshotPhotos: defineTable({
    boardId: v.id("boards"),
    snapshotId: v.string(),
    ...photoFields,
  }).index("by_boardId_and_snapshotId", ["boardId", "snapshotId"]),
});
