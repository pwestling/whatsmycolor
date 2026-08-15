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

const photo = board.photos[0];
const baseVersion = photo.hueVersion;
const opA = crypto.randomUUID().replaceAll("-", "");
const opB = crypto.randomUUID().replaceAll("-", "");
const common = {
  slug: "models",
  photoId: photo.photoId,
  baseVersion,
  clientId: crypto.randomUUID().replaceAll("-", ""),
};
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
