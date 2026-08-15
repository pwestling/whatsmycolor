import assert from "node:assert/strict";

import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

const url = process.env.CONVEX_URL;
if (!url) throw new Error("CONVEX_URL is required.");

const slug = process.env.COMMUNITY_SLUG ?? "codex-test";
const clientCount = Number(process.env.COMMUNITY_CLIENTS ?? "200");
assert(Number.isInteger(clientCount) && clientCount > 0 && clientCount <= 500);

const api = anyApi.community;
const clients = [];
const unsubscribe = [];
const latestBoards = Array(clientCount).fill(null);
const initialResolvers = [];
const updateResolvers = [];

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

async function withTimeout(promise, label, milliseconds = 30_000) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(
      () => reject(new Error(`${label} timed out.`)),
      milliseconds,
    );
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

try {
  for (let index = 0; index < clientCount; index += 1) {
    const client = new ConvexClient(url, { unsavedChangesWarning: false });
    const initial = deferred();
    const updated = deferred();
    clients.push(client);
    initialResolvers.push(initial);
    updateResolvers.push(updated);
    unsubscribe.push(client.onUpdate(api.getBoard, { slug }, (board) => {
      latestBoards[index] = board;
      initial.resolve();
      if (board?.photos.some((photo) => (
        photo.photoId === updated.photoId && photo.hueVersion >= updated.version
      ))) {
        updated.resolve();
      }
    }, initial.reject));
  }

  await withTimeout(
    Promise.all(initialResolvers.map(({ promise }) => promise)),
    `${clientCount} initial subscriptions`,
  );
  const board = latestBoards[0];
  assert(board, `Board ${slug} was not found.`);
  assert(board.photos.length > 0, `Board ${slug} needs one test photo.`);
  let photo = board.photos[0];
  const visitorName = photo.uploaderName || "Load check";
  if (!photo.uploaderName) {
    const claimed = await clients[0].mutation(api.claimPhoto, {
      slug,
      photoId: photo.photoId,
      visitorName,
      opId: crypto.randomUUID().replaceAll("-", ""),
      clientId: crypto.randomUUID().replaceAll("-", ""),
    });
    assert.equal(claimed.status, "accepted");
    photo = claimed.photo;
  }
  const expectedVersion = photo.hueVersion + 1;
  for (const resolver of updateResolvers) {
    resolver.photoId = photo.photoId;
    resolver.version = expectedVersion;
  }
  const targetPosition = photo.xPosition > 50 ? 32 : 68;
  const result = await clients[0].mutation(api.movePhoto, {
    slug,
    photoId: photo.photoId,
    xPosition: targetPosition,
    baseVersion: photo.hueVersion,
    opId: crypto.randomUUID().replaceAll("-", ""),
    clientId: crypto.randomUUID().replaceAll("-", ""),
    visitorName,
  });
  assert.equal(result.status, "accepted");
  await withTimeout(
    Promise.all(updateResolvers.map(({ promise }) => promise)),
    `${clientCount} realtime updates`,
  );
  console.log(`${clientCount} Community clients received the accepted move.`);
} finally {
  unsubscribe.forEach((stop) => stop());
  clients.forEach((client) => client.close());
}
