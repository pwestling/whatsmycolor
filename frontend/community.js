import { ConvexClient } from "convex/browser";
import { anyApi } from "convex/server";

import {
  AXIS_WIDTH,
  CARD_HEIGHT,
  CARD_WIDTH,
  COLOR_AXIS_HEIGHT,
  ROW_GAP,
  TIMELINE_BOTTOM_PADDING,
  TIMELINE_TOP_PADDING,
  chronologicalPlacements,
  clamp,
  contentHeight,
  displayedXPosition,
  parsePhotoDate,
} from "./layout.js";
import { jpegCaptureDate, localIsoDate, prepareUploadFile } from "./upload.js";

const body = document.body;
const boardSlug = body.dataset.boardSlug;
const snapshotId = body.dataset.snapshotId;
const readonly = body.dataset.readonly === "true";
const convexUrl = document.querySelector('meta[name="convex-url"]')?.content ?? "";
const communityApi = anyApi.community;

const MINIMUM_TIMELINE_HEIGHT = 420;
const MIN_ZOOM = 0.001;
const MAX_ZOOM = 12;
const ZOOM_STEP = 1.2;
const EXPORT_SCALE = 2;
const MAX_EXPORT_EDGE = 16_384;
const MAX_EXPORT_PIXELS = 40_000_000;
const EXPORT_COLORS = [
  "#ff4236", "#ff2d76", "#c737df", "#6947df", "#315cda", "#16a9de",
  "#14a79b", "#18a65c", "#8cc744", "#f2dc2d", "#fa9a2a", "#eee9df", "#121412",
];

const elements = {
  input: document.querySelector("#photo-input"),
  rangeReadout: document.querySelector("#range-readout"),
  connectionDot: document.querySelector("#connection-dot"),
  atlasScroll: document.querySelector("#atlas-scroll"),
  atlas: document.querySelector("#atlas"),
  timelineDirection: document.querySelector("#timeline-direction"),
  timeDirectionTop: document.querySelector("#time-direction-top"),
  timeDirectionBottom: document.querySelector("#time-direction-bottom"),
  timelineBody: document.querySelector("#timeline-body"),
  photoField: document.querySelector("#photo-field"),
  emptyState: document.querySelector("#empty-state"),
  emptyTitle: document.querySelector("#empty-title"),
  emptyUpload: document.querySelector("#empty-upload"),
  hueGuide: document.querySelector("#hue-guide"),
  uploadTray: document.querySelector("#upload-tray"),
  uploadSummary: document.querySelector("#upload-summary"),
  uploadProgressBar: document.querySelector("#upload-progress-bar"),
  uploadList: document.querySelector("#upload-list"),
  dialog: document.querySelector("#photo-dialog"),
  dialogForm: document.querySelector("#photo-form"),
  dialogImage: document.querySelector("#dialog-image"),
  dialogDate: document.querySelector("#dialog-date"),
  dialogPosition: document.querySelector("#dialog-position"),
  dialogTimeSource: document.querySelector("#dialog-time-source"),
  saveButton: document.querySelector("#save-button"),
  exportButton: document.querySelector("#export-board"),
  shareButton: document.querySelector("#share-board"),
  shareDialog: document.querySelector("#share-dialog"),
  shareLink: document.querySelector("#share-link"),
  openShare: document.querySelector("#open-share"),
  copyShare: document.querySelector("#copy-share"),
  toast: document.querySelector("#toast"),
};

const state = {
  boardExists: null,
  canonicalPhotos: new Map(),
  cards: new Map(),
  pendingPositions: new Map(),
  moveControls: new Map(),
  activeId: null,
  newestFirst: true,
  directionInitialized: false,
  zoom: 1,
  baseFieldWidth: null,
  toastTimer: null,
};

function newPublicId() {
  return crypto.randomUUID().replaceAll("-", "");
}

function clientId() {
  const key = "wmc-community-client";
  let value = localStorage.getItem(key);
  if (!value || !/^[a-f0-9]{32}$/.test(value)) {
    value = newPublicId();
    localStorage.setItem(key, value);
  }
  return value;
}

const anonymousClientId = clientId();

function normalizePhoto(photo) {
  return {
    ...photo,
    id: photo.photoId ?? photo.id,
  };
}

function canonicalPhoto(photoId) {
  return state.canonicalPhotos.get(photoId) ?? null;
}

function displayPhoto(photo) {
  if (!state.pendingPositions.has(photo.id)) return photo;
  return { ...photo, xPosition: state.pendingPositions.get(photo.id) };
}

function displayedPhotos() {
  return [...state.canonicalPhotos.values()].map(displayPhoto);
}

function errorMessage(error) {
  if (typeof error?.data === "string") return error.data;
  if (typeof error?.message === "string") {
    const convexMessage = error.message.match(/ConvexError:\s*([^\n]+)/);
    if (convexMessage) return convexMessage[1];
    return error.message;
  }
  return "Something went wrong.";
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function setConnection(status) {
  elements.connectionDot.className = `connection-dot ${status}`;
  const labels = {
    live: readonly ? "Snapshot" : "Live",
    offline: "Offline",
    error: "Connection error",
    connecting: "Connecting",
  };
  elements.connectionDot.setAttribute("aria-label", labels[status] ?? "Connecting");
  elements.connectionDot.title = labels[status] ?? "Connecting";
}

function formatRangeDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(date);
}

function formatCardDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsePhotoDate(value));
}

function updateSummary() {
  if (state.boardExists === null) {
    elements.rangeReadout.textContent = "Loading…";
    elements.emptyState.hidden = false;
    elements.emptyTitle.textContent = "Loading…";
    elements.emptyUpload.hidden = true;
    return;
  }
  if (!state.boardExists) {
    elements.rangeReadout.textContent = "Not found";
    elements.emptyState.hidden = false;
    elements.emptyTitle.textContent = "Board not found";
    elements.emptyUpload.hidden = true;
    return;
  }
  const photos = displayedPhotos();
  elements.emptyState.hidden = photos.length !== 0;
  elements.emptyTitle.textContent = readonly ? "No photos" : "Add photos";
  elements.emptyUpload.hidden = readonly || photos.length !== 0;
  if (!photos.length) {
    elements.rangeReadout.textContent = "No photos";
    return;
  }
  const dates = photos.map((photo) => parsePhotoDate(photo.capturedAt));
  const newest = new Date(Math.max(...dates.map((date) => date.valueOf())));
  const oldest = new Date(Math.min(...dates.map((date) => date.valueOf())));
  const range = newest.getFullYear() === oldest.getFullYear()
    ? String(newest.getFullYear())
    : `${formatRangeDate(oldest)} — ${formatRangeDate(newest)}`;
  const count = photos.length;
  elements.rangeReadout.textContent = `${count} ${count === 1 ? "model" : "models"} · ${range}`;
}

function createCard(photoId) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = readonly ? "photo-card shared-photo" : "photo-card";
  card.dataset.photoId = photoId;
  const image = document.createElement("img");
  image.alt = "";
  image.draggable = false;
  card.append(image);
  if (!readonly) bindCardInteractions(card, photoId);
  elements.photoField.append(card);
  state.cards.set(photoId, card);
  return card;
}

function updateCard(card, photo, xPercent, y) {
  const image = card.querySelector("img");
  if (image.getAttribute("src") !== photo.imageUrl) image.src = photo.imageUrl;
  card.setAttribute(
    "aria-label",
    `${photo.title}, ${formatCardDate(photo.capturedAt)}${readonly ? "" : ". Drag sideways to change color."}`,
  );
  card.style.setProperty("--x", `${xPercent}%`);
  card.style.setProperty("--y", `${y * state.zoom}px`);
  card.style.setProperty("--card-size", `${CARD_WIDTH * state.zoom}px`);
}

function removeStaleCards(currentIds) {
  state.cards.forEach((card, photoId) => {
    if (currentIds.has(photoId)) return;
    card.remove();
    state.cards.delete(photoId);
  });
}

function fitZoomFor(photos) {
  if (state.baseFieldWidth === null) return 1;
  const widthZoom = Math.max(0.001, (
    elements.atlasScroll.clientWidth - AXIS_WIDTH
  ) / state.baseFieldWidth);
  if (!photos.length) return widthZoom;
  const { rowCount } = chronologicalPlacements(
    photos,
    state.baseFieldWidth,
    state.newestFirst,
  );
  const heightZoom = Math.max(0.001, (
    elements.atlasScroll.clientHeight - COLOR_AXIS_HEIGHT
  ) / contentHeight(rowCount));
  return Math.min(widthZoom, heightZoom);
}

function renderTimeline() {
  updateSummary();
  elements.timeDirectionTop.textContent = state.newestFirst ? "Newer" : "Older";
  elements.timeDirectionBottom.textContent = state.newestFirst ? "Older" : "Newer";
  elements.timelineDirection.textContent = state.newestFirst ? "↓" : "↑";
  elements.timelineDirection.setAttribute(
    "aria-label",
    state.newestFirst ? "Show oldest first" : "Show newest first",
  );
  elements.timelineDirection.title = state.newestFirst ? "Show oldest first" : "Show newest first";
  if (state.baseFieldWidth === null) {
    state.baseFieldWidth = Math.max(elements.atlasScroll.clientWidth - AXIS_WIDTH, 1008);
  }
  const photos = displayedPhotos();
  const minimumZoom = Math.max(MIN_ZOOM, fitZoomFor(photos));
  if (state.zoom < minimumZoom) state.zoom = minimumZoom;
  const fieldWidth = state.baseFieldWidth * state.zoom;
  elements.atlas.style.width = `${AXIS_WIDTH + fieldWidth}px`;
  const viewportHeight = Math.max(
    MINIMUM_TIMELINE_HEIGHT,
    elements.atlasScroll.clientHeight - COLOR_AXIS_HEIGHT,
  );
  const { placements, rowCount } = chronologicalPlacements(
    photos,
    state.baseFieldWidth,
    state.newestFirst,
  );
  const scaledContentHeight = contentHeight(rowCount) * state.zoom;
  elements.timelineBody.style.height = `${Math.max(viewportHeight, scaledContentHeight)}px`;
  const currentIds = new Set(photos.map((photo) => photo.id));
  removeStaleCards(currentIds);
  placements.forEach(({ photo, xPercent, y }) => {
    const card = state.cards.get(photo.id) ?? createCard(photo.id);
    if (!card.classList.contains("dragging")) updateCard(card, photo, xPercent, y);
  });
}

function setZoom(nextZoom, clientX, clientY) {
  const minimumZoom = Math.max(MIN_ZOOM, fitZoomFor(displayedPhotos()));
  const zoom = clamp(nextZoom, minimumZoom, MAX_ZOOM);
  if (Math.abs(zoom - state.zoom) < 0.001) return;
  const rect = elements.atlasScroll.getBoundingClientRect();
  const viewportX = (clientX ?? rect.left + rect.width / 2) - rect.left;
  const viewportY = (clientY ?? rect.top + rect.height / 2) - rect.top;
  const worldX = (elements.atlasScroll.scrollLeft + viewportX - AXIS_WIDTH) / state.zoom;
  const worldY = (elements.atlasScroll.scrollTop + viewportY - COLOR_AXIS_HEIGHT) / state.zoom;
  state.zoom = zoom;
  renderTimeline();
  elements.atlasScroll.scrollLeft = AXIS_WIDTH + worldX * zoom - viewportX;
  elements.atlasScroll.scrollTop = COLOR_AXIS_HEIGHT + worldY * zoom - viewportY;
}

function fitTimeline() {
  if (state.baseFieldWidth === null) renderTimeline();
  setZoom(fitZoomFor(displayedPhotos()));
  elements.atlasScroll.scrollTo({ left: 0, top: 0 });
}

function replaceCanonicalPhoto(photo) {
  if (!photo) return;
  const normalized = normalizePhoto(photo);
  state.canonicalPhotos.set(normalized.id, normalized);
}

async function flushMove(photoId, control) {
  try {
    while (control.queuedPosition !== null) {
      const position = control.queuedPosition;
      control.queuedPosition = null;
      const photo = canonicalPhoto(photoId);
      if (!photo) throw new Error("Photo not found.");
      const result = await convex.mutation(communityApi.movePhoto, {
        slug: boardSlug,
        photoId,
        xPosition: position,
        baseVersion: photo.hueVersion,
        opId: newPublicId(),
        clientId: anonymousClientId,
      });
      replaceCanonicalPhoto(result.photo);
      if (result.status === "stale" && control.queuedPosition === null) {
        showToast("That photo moved elsewhere.");
      }
    }
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    control.running = false;
    state.pendingPositions.delete(photoId);
    state.moveControls.delete(photoId);
    renderTimeline();
  }
}

function movePhoto(photoId, position) {
  if (readonly) return Promise.resolve();
  let control = state.moveControls.get(photoId);
  if (!control) {
    control = { running: false, queuedPosition: null, promise: null };
    state.moveControls.set(photoId, control);
  }
  const rounded = Math.round(clamp(position, 0, 100) * 1_000) / 1_000;
  control.queuedPosition = rounded;
  state.pendingPositions.set(photoId, rounded);
  renderTimeline();
  if (!control.running) {
    control.running = true;
    control.promise = flushMove(photoId, control);
  }
  return control.promise;
}

function bindCardInteractions(card, photoId) {
  let pointerId = null;
  let startX = 0;
  let moved = false;
  let suppressClick = false;

  card.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return;
    pointerId = event.pointerId;
    startX = event.clientX;
    moved = false;
    card.setPointerCapture(pointerId);
  });

  card.addEventListener("pointermove", (event) => {
    if (event.pointerId !== pointerId) return;
    if (!moved && Math.abs(event.clientX - startX) < 5) return;
    moved = true;
    const fieldRect = elements.photoField.getBoundingClientRect();
    const position = clamp((event.clientX - fieldRect.left) / fieldRect.width * 100, 0, 100);
    card.classList.add("dragging");
    card.style.setProperty(
      "--x",
      `${displayedXPosition(position, fieldRect.width, CARD_WIDTH * state.zoom)}%`,
    );
    card.dataset.pendingPosition = String(position);
    elements.hueGuide.hidden = false;
    elements.hueGuide.style.setProperty("--guide-x", `${position}%`);
  });

  const releasePointer = (event) => {
    if (event.pointerId !== pointerId) return false;
    if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
    pointerId = null;
    elements.hueGuide.hidden = true;
    card.classList.remove("dragging");
    return true;
  };

  card.addEventListener("pointerup", (event) => {
    if (!releasePointer(event) || !moved) return;
    suppressClick = true;
    const position = Number(card.dataset.pendingPosition);
    delete card.dataset.pendingPosition;
    void movePhoto(photoId, position);
    window.setTimeout(() => { suppressClick = false; }, 0);
  });

  card.addEventListener("pointercancel", (event) => {
    if (!releasePointer(event)) return;
    delete card.dataset.pendingPosition;
    renderTimeline();
  });

  card.addEventListener("click", () => {
    if (!suppressClick) openPhotoDialog(photoId);
  });

  card.addEventListener("keydown", (event) => {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const photo = canonicalPhoto(photoId);
    if (!photo) return;
    const change = event.key === "ArrowLeft" ? -0.5 : 0.5;
    void movePhoto(photoId, photo.xPosition + change);
  });
}

function openPhotoDialog(photoId) {
  if (readonly) return;
  const photo = canonicalPhoto(photoId);
  if (!photo) return;
  state.activeId = photo.id;
  elements.dialogImage.src = photo.imageUrl;
  elements.dialogImage.alt = photo.title;
  elements.dialogDate.value = photo.capturedAt.slice(0, 16);
  elements.dialogPosition.value = String(photo.xPosition);
  elements.dialogTimeSource.textContent = photo.timeSource;
  elements.dialog.showModal();
}

async function savePhotoDetails(event) {
  event.preventDefault();
  const photo = canonicalPhoto(state.activeId);
  if (!photo) return;
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = "Saving…";
  try {
    const capturedAt = elements.dialogDate.value.length === 16
      ? `${elements.dialogDate.value}:00`
      : elements.dialogDate.value;
    const desiredPosition = Number(elements.dialogPosition.value);
    if (capturedAt !== photo.capturedAt) {
      const result = await convex.mutation(communityApi.setPhotoDate, {
        slug: boardSlug,
        photoId: photo.id,
        capturedAt,
        baseVersion: photo.timeVersion,
        opId: newPublicId(),
        clientId: anonymousClientId,
      });
      replaceCanonicalPhoto(result.photo);
      if (result.status === "stale") showToast("That date changed elsewhere.");
    }
    const current = canonicalPhoto(photo.id);
    if (current && Math.abs(desiredPosition - current.xPosition) >= 0.001) {
      await movePhoto(photo.id, desiredPosition);
    }
    elements.dialog.close();
    renderTimeline();
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent = "Save";
  }
}

async function apiFetch(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = "Something went wrong.";
    try {
      const payload = await response.json();
      if (payload.error) message = payload.error;
    } catch {
      if (response.status === 413) message = "That upload is too large.";
    }
    throw new Error(message);
  }
  return response.json();
}

async function addAnalyzedPhoto(photo) {
  const result = await convex.mutation(communityApi.addPhoto, {
    slug: boardSlug,
    opId: newPublicId(),
    clientId: anonymousClientId,
    photoId: photo.id,
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
  });
  replaceCanonicalPhoto(result.photo);
}

async function uploadFiles(fileList) {
  if (readonly || !state.boardExists) return;
  const files = [...fileList].filter((file) => (
    file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name)
  ));
  if (!files.length) {
    showToast("Choose an image file.");
    return;
  }
  elements.uploadTray.hidden = false;
  elements.uploadList.replaceChildren();
  elements.uploadProgressBar.style.width = "0%";
  const rows = files.map((file) => {
    const row = document.createElement("li");
    const name = document.createElement("span");
    const status = document.createElement("b");
    name.textContent = file.name;
    status.textContent = "Waiting";
    row.append(name, status);
    elements.uploadList.append(row);
    return { row, status };
  });

  let completed = 0;
  let succeeded = 0;
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const { row, status } = rows[index];
    status.textContent = "Reading";
    try {
      const captureDate = await jpegCaptureDate(file);
      status.textContent = file.size > 3_650_000 ? "Resizing" : "Uploading";
      const prepared = await prepareUploadFile(file);
      const photoId = newPublicId();
      const form = new FormData();
      form.append("photo", prepared, prepared.name);
      form.append("photo_id", photoId);
      form.append("last_modified", localIsoDate(new Date(file.lastModified)));
      if (captureDate) form.append("captured_at_hint", captureDate);
      status.textContent = "Analyzing";
      const payload = await apiFetch(`/api/community/${encodeURIComponent(boardSlug)}/photos`, {
        method: "POST",
        body: form,
      });
      status.textContent = "Adding";
      await addAnalyzedPhoto(payload.photo);
      row.classList.add("done");
      status.textContent = "Added";
      succeeded += 1;
    } catch (error) {
      row.classList.add("failed");
      status.textContent = errorMessage(error);
    }
    completed += 1;
    elements.uploadSummary.textContent = completed === files.length
      ? `${succeeded} of ${files.length} added`
      : `${completed + 1} of ${files.length}`;
    elements.uploadProgressBar.style.width = `${completed / files.length * 100}%`;
    renderTimeline();
  }
  elements.input.value = "";
}

function exportImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("A photo could not be included."));
    image.src = url;
  });
}

function exportCanvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This browser could not create the PNG."));
    }, "image/png");
  });
}

function drawCoverImage(context, image, left, top, size) {
  const sourceSize = Math.min(image.naturalWidth, image.naturalHeight);
  const sourceX = (image.naturalWidth - sourceSize) / 2;
  const sourceY = (image.naturalHeight - sourceSize) / 2;
  context.drawImage(image, sourceX, sourceY, sourceSize, sourceSize, left, top, size, size);
}

function drawExportFrame(context, width, height) {
  context.fillStyle = "#111412";
  context.fillRect(0, 0, width, height);
  context.fillStyle = "#141714";
  context.fillRect(0, COLOR_AXIS_HEIGHT, AXIS_WIDTH, height - COLOR_AXIS_HEIGHT);
  context.strokeStyle = "rgba(255,255,255,.12)";
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(AXIS_WIDTH - 0.5, 0);
  context.lineTo(AXIS_WIDTH - 0.5, height);
  context.stroke();
  const gap = 3;
  const padding = 12;
  const weights = EXPORT_COLORS.map((_, index) => index < 11 ? 1 : 0.9);
  const unit = (width - AXIS_WIDTH - padding * 2 - gap * (weights.length - 1))
    / weights.reduce((total, weight) => total + weight, 0);
  let left = AXIS_WIDTH + padding;
  EXPORT_COLORS.forEach((color, index) => {
    const segmentWidth = unit * weights[index];
    context.fillStyle = color;
    context.fillRect(left, 10, segmentWidth, 58);
    left += segmentWidth + gap;
  });
  context.fillStyle = "#747c73";
  context.font = "800 8px sans-serif";
  context.textBaseline = "top";
  context.fillText(state.newestFirst ? "NEWER" : "OLDER", 20, COLOR_AXIS_HEIGHT + 21);
  context.textBaseline = "bottom";
  context.fillText(state.newestFirst ? "OLDER" : "NEWER", 20, height - 21);
}

async function exportBoard() {
  const photos = displayedPhotos();
  if (!photos.length) {
    showToast("No photos to export.");
    return;
  }
  elements.exportButton.disabled = true;
  elements.exportButton.textContent = "Exporting…";
  try {
    if (state.baseFieldWidth === null) renderTimeline();
    const { placements, rowCount } = chronologicalPlacements(
      photos,
      state.baseFieldWidth,
      state.newestFirst,
    );
    const boardWidth = AXIS_WIDTH + state.baseFieldWidth;
    const boardHeight = COLOR_AXIS_HEIGHT + contentHeight(rowCount);
    const scale = Math.min(
      EXPORT_SCALE,
      MAX_EXPORT_EDGE / boardWidth,
      MAX_EXPORT_EDGE / boardHeight,
      Math.sqrt(MAX_EXPORT_PIXELS / (boardWidth * boardHeight)),
    );
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.floor(boardWidth * scale));
    canvas.height = Math.max(1, Math.floor(boardHeight * scale));
    const context = canvas.getContext("2d", { alpha: false });
    context.scale(scale, scale);
    drawExportFrame(context, boardWidth, boardHeight);
    for (const { photo, xPercent, y } of placements) {
      const image = await exportImage(photo.imageUrl);
      const center = AXIS_WIDTH + xPercent / 100 * state.baseFieldWidth;
      drawCoverImage(context, image, center - CARD_WIDTH / 2, COLOR_AXIS_HEIGHT + y, CARD_WIDTH);
    }
    const blob = await exportCanvasBlob(canvas);
    const downloadUrl = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = downloadUrl;
    link.download = `${boardSlug}-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    elements.exportButton.disabled = false;
    elements.exportButton.textContent = "Export";
  }
}

async function createShare() {
  if (!state.canonicalPhotos.size) {
    showToast("Add a photo first.");
    return;
  }
  elements.shareButton.disabled = true;
  elements.shareButton.textContent = "Sharing…";
  try {
    const id = newPublicId();
    await convex.mutation(communityApi.createSnapshot, {
      slug: boardSlug,
      snapshotId: id,
      newestFirst: state.newestFirst,
    });
    const shareUrl = new URL(`/community/${boardSlug}/s/${id}`, window.location.href).href;
    elements.shareLink.value = shareUrl;
    elements.openShare.href = shareUrl;
    elements.shareDialog.showModal();
  } catch (error) {
    showToast(errorMessage(error));
  } finally {
    elements.shareButton.disabled = false;
    elements.shareButton.textContent = "Share";
  }
}

function receiveBoard(result) {
  if (result === null) {
    state.boardExists = false;
    state.canonicalPhotos.clear();
    setConnection("live");
    renderTimeline();
    return;
  }
  state.boardExists = true;
  if (readonly && !state.directionInitialized) {
    state.newestFirst = result.snapshot.newestFirst;
    state.directionInitialized = true;
  }
  state.canonicalPhotos = new Map(
    result.photos.map((photo) => {
      const normalized = normalizePhoto(photo);
      return [normalized.id, normalized];
    }),
  );
  setConnection("live");
  renderTimeline();
}

function subscribe() {
  if (!convexUrl) {
    state.boardExists = false;
    setConnection("error");
    elements.rangeReadout.textContent = "Not configured";
    elements.emptyTitle.textContent = "Board unavailable";
    return () => {};
  }
  const reference = readonly ? communityApi.getSnapshot : communityApi.getBoard;
  const args = readonly ? { slug: boardSlug, snapshotId } : { slug: boardSlug };
  return convex.onUpdate(reference, args, receiveBoard, (error) => {
    setConnection("error");
    showToast(errorMessage(error));
  });
}

if (readonly) {
  document.querySelectorAll(".community-edit-control").forEach((element) => {
    element.hidden = true;
  });
  elements.dialog.remove();
  elements.uploadTray.remove();
}

const convex = convexUrl ? new ConvexClient(convexUrl, { unsavedChangesWarning: false }) : null;
setConnection(navigator.onLine ? "connecting" : "offline");
const unsubscribe = subscribe();

elements.timelineDirection.addEventListener("click", () => {
  state.newestFirst = !state.newestFirst;
  state.directionInitialized = true;
  renderTimeline();
});
document.querySelector("#zoom-out").addEventListener("click", () => setZoom(state.zoom / ZOOM_STEP));
document.querySelector("#zoom-in").addEventListener("click", () => setZoom(state.zoom * ZOOM_STEP));
document.querySelector("#zoom-fit").addEventListener("click", fitTimeline);
elements.exportButton.addEventListener("click", exportBoard);
if (!readonly) {
  elements.dialogForm.addEventListener("submit", savePhotoDetails);
  elements.dialog.addEventListener("close", () => {
    state.activeId = null;
    elements.dialogImage.removeAttribute("src");
  });
  elements.shareButton.addEventListener("click", createShare);
  elements.copyShare.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(elements.shareLink.value);
      elements.copyShare.textContent = "Copied";
      window.setTimeout(() => { elements.copyShare.textContent = "Copy"; }, 1500);
    } catch {
      elements.shareLink.select();
      showToast("Copy the selected link.");
    }
  });
  document.querySelectorAll("#toolbar-upload, #empty-upload").forEach((button) => {
    button.addEventListener("click", () => elements.input.click());
  });
  elements.input.addEventListener("change", () => uploadFiles(elements.input.files));
  document.querySelector("#upload-tray-close").addEventListener("click", () => {
    elements.uploadTray.hidden = true;
  });
}

elements.atlasScroll.addEventListener("wheel", (event) => {
  event.preventDefault();
  const delta = event.deltaY || event.deltaX;
  setZoom(state.zoom * Math.exp(-delta * 0.0015), event.clientX, event.clientY);
}, { passive: false });

let panPointerId = null;
let panStartX = 0;
let panStartY = 0;
let panStartLeft = 0;
let panStartTop = 0;

elements.photoField.addEventListener("pointerdown", (event) => {
  if (event.button !== 0 || event.target.closest(".photo-card, button")) return;
  panPointerId = event.pointerId;
  panStartX = event.clientX;
  panStartY = event.clientY;
  panStartLeft = elements.atlasScroll.scrollLeft;
  panStartTop = elements.atlasScroll.scrollTop;
  elements.photoField.classList.add("panning");
  elements.photoField.setPointerCapture(panPointerId);
});

elements.photoField.addEventListener("pointermove", (event) => {
  if (event.pointerId !== panPointerId) return;
  event.preventDefault();
  elements.atlasScroll.scrollLeft = panStartLeft - (event.clientX - panStartX);
  elements.atlasScroll.scrollTop = panStartTop - (event.clientY - panStartY);
});

function finishPanning(event) {
  if (event.pointerId !== panPointerId) return;
  if (elements.photoField.hasPointerCapture(panPointerId)) {
    elements.photoField.releasePointerCapture(panPointerId);
  }
  panPointerId = null;
  elements.photoField.classList.remove("panning");
}

elements.photoField.addEventListener("pointerup", finishPanning);
elements.photoField.addEventListener("pointercancel", finishPanning);

if (!readonly) {
  elements.photoField.addEventListener("dragover", (event) => {
    event.preventDefault();
    elements.photoField.classList.add("drop-ready");
  });
  elements.photoField.addEventListener("dragleave", () => {
    elements.photoField.classList.remove("drop-ready");
  });
  elements.photoField.addEventListener("drop", (event) => {
    event.preventDefault();
    elements.photoField.classList.remove("drop-ready");
    uploadFiles(event.dataTransfer.files);
  });
}

window.addEventListener("offline", () => setConnection("offline"));
window.addEventListener("online", () => setConnection("connecting"));
window.addEventListener("beforeunload", () => {
  unsubscribe();
  convex?.close();
});

let resizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderTimeline, 100);
});

renderTimeline();
