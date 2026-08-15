import assert from "node:assert/strict";

import { ConvexHttpClient } from "convex/browser";
import { anyApi } from "convex/server";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("CONVEX_URL is required.");

const api = anyApi.community;
const firstClient = new ConvexHttpClient(url);
const secondClient = new ConvexHttpClient(url);
const board = await firstClient.query(api.getBoard, { slug: "models" });
assert(board, "Local models board is missing.");
assert(board.photos.length > 0, "Upload a local test photo before running this check.");

let photo = board.photos[0];
const visitorName = photo.uploaderName || "Convex check";
if (!photo.uploaderName) {
  const claimed = await firstClient.mutation(api.claimPhoto, {
    slug: "models",
    photoId: photo.photoId,
    visitorName,
    opId: crypto.randomUUID().replaceAll("-", ""),
    clientId: crypto.randomUUID().replaceAll("-", ""),
  });
  assert.equal(claimed.status, "accepted");
  photo = claimed.photo;
}
const sameClaim = await firstClient.mutation(api.claimPhoto, {
  slug: "models",
  photoId: photo.photoId,
  visitorName,
  opId: crypto.randomUUID().replaceAll("-", ""),
  clientId: crypto.randomUUID().replaceAll("-", ""),
});
assert.equal(sameClaim.status, "already-yours");
const takenClaim = await secondClient.mutation(api.claimPhoto, {
  slug: "models",
  photoId: photo.photoId,
  visitorName: "Someone else",
  opId: crypto.randomUUID().replaceAll("-", ""),
  clientId: crypto.randomUUID().replaceAll("-", ""),
});
assert.equal(takenClaim.status, "taken");
const baseVersion = photo.hueVersion;
const opA = crypto.randomUUID().replaceAll("-", "");
const opB = crypto.randomUUID().replaceAll("-", "");
const common = {
  slug: "models",
  photoId: photo.photoId,
  baseVersion,
  clientId: crypto.randomUUID().replaceAll("-", ""),
  visitorName,
};
await assert.rejects(
  secondClient.mutation(api.movePhoto, {
    ...common,
    visitorName: "Someone else",
    opId: crypto.randomUUID().replaceAll("-", ""),
    xPosition: 50,
  }),
  /belongs to someone else/,
);
const results = await Promise.all([
  firstClient.mutation(api.movePhoto, { ...common, opId: opA, xPosition: 24 }),
  secondClient.mutation(api.movePhoto, { ...common, opId: opB, xPosition: 76 }),
]);
assert.deepEqual(
  results.map((result) => result.status).sort(),
  ["accepted", "stale"],
  "Exactly one simultaneous move should be accepted.",
);

const acceptedIndex = results.findIndex((result) => result.status === "accepted");
const acceptedOpId = acceptedIndex === 0 ? opA : opB;
const acceptedPosition = acceptedIndex === 0 ? 24 : 76;
const duplicate = await firstClient.mutation(api.movePhoto, {
  ...common,
  opId: acceptedOpId,
  xPosition: acceptedPosition,
});
assert.equal(duplicate.status, "duplicate");
assert.equal(duplicate.photo.hueVersion, baseVersion + 1);

console.log("Convex concurrency check passed.");
