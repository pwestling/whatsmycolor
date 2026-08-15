const state = {
  photos: [],
  activeId: null,
  newestFirst: true,
  zoom: 1,
  baseFieldWidth: null,
  photoUpdateVersions: new Map(),
  toastTimer: null,
};

const elements = {
  input: document.querySelector("#photo-input"),
  rangeReadout: document.querySelector("#range-readout"),
  atlasScroll: document.querySelector("#atlas-scroll"),
  atlas: document.querySelector("#atlas"),
  timelineDirection: document.querySelector("#timeline-direction"),
  timeDirectionTop: document.querySelector("#time-direction-top"),
  timeDirectionBottom: document.querySelector("#time-direction-bottom"),
  timelineBody: document.querySelector("#timeline-body"),
  photoField: document.querySelector("#photo-field"),
  emptyState: document.querySelector("#empty-state"),
  hueGuide: document.querySelector("#hue-guide"),
  hueGuideLabel: document.querySelector("#hue-guide-label"),
  uploadTray: document.querySelector("#upload-tray"),
  uploadSummary: document.querySelector("#upload-summary"),
  uploadProgressBar: document.querySelector("#upload-progress-bar"),
  uploadList: document.querySelector("#upload-list"),
  dialog: document.querySelector("#photo-dialog"),
  dialogForm: document.querySelector("#photo-form"),
  dialogImage: document.querySelector("#dialog-image"),
  dialogTitle: document.querySelector("#dialog-title"),
  dialogDate: document.querySelector("#dialog-date"),
  dialogPosition: document.querySelector("#dialog-position"),
  dialogTimeSource: document.querySelector("#dialog-time-source"),
  dialogColorSource: document.querySelector("#dialog-color-source"),
  dialogColorDot: document.querySelector("#dialog-color-dot"),
  deleteButton: document.querySelector("#delete-button"),
  saveButton: document.querySelector("#save-button"),
  exportButton: document.querySelector("#export-board"),
  shareButton: document.querySelector("#share-board"),
  shareDialog: document.querySelector("#share-dialog"),
  shareLink: document.querySelector("#share-link"),
  openShare: document.querySelector("#open-share"),
  copyShare: document.querySelector("#copy-share"),
  toast: document.querySelector("#toast"),
};

const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
const CARD_WIDTH = 118;
const CARD_HEIGHT = 118;
const CARD_HORIZONTAL_GAP = 4;
const ROW_GAP = 4;
const TIMELINE_TOP_PADDING = 20;
const TIMELINE_BOTTOM_PADDING = 32;
const MINIMUM_TIMELINE_HEIGHT = 420;
const AXIS_WIDTH = 112;
const COLOR_AXIS_HEIGHT = 80;
const MIN_ZOOM = 0.001;
const MAX_ZOOM = 8;
const ZOOM_STEP = 1.2;
const EXPORT_SCALE = 2;
const MAX_EXPORT_EDGE = 16_384;
const MAX_EXPORT_PIXELS = 40_000_000;
const EXPORT_COLORS = [
  "#ff4236", "#ff2d76", "#c737df", "#6947df", "#315cda", "#16a9de",
  "#14a79b", "#18a65c", "#8cc744", "#f2dc2d", "#fa9a2a", "#eee9df", "#121412",
];

function colorName(position) {
  if (position > 95) return "black";
  if (position > 87) return "white";
  const stops = [
    [4, "red"], [11, "pink"], [20, "violet"], [29, "purple"],
    [39, "blue"], [48, "cyan"], [56, "teal"], [65, "green"],
    [73, "lime"], [81, "yellow"], [88, "orange"],
  ];
  return stops.find(([end]) => position < end)?.[1] || "orange";
}

function colorAtPosition(position) {
  if (position > 95) return "#171717";
  if (position > 87) return "#f1efe9";
  const hue = position <= 1
    ? 0
    : (360 - Math.min(position, 86) / 86 * 330) % 360;
  return `hsl(${hue} 72% 49%)`;
}

function parsePhotoDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
}

function formatCardDate(value) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsePhotoDate(value));
}

function formatRangeDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(date);
}

function showToast(message) {
  window.clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.hidden = false;
  state.toastTimer = window.setTimeout(() => {
    elements.toast.hidden = true;
  }, 3200);
}

function beginPhotoUpdate(photoId) {
  const version = (state.photoUpdateVersions.get(photoId) || 0) + 1;
  state.photoUpdateVersions.set(photoId, version);
  return version;
}

function isCurrentPhotoUpdate(photoId, version) {
  return state.photoUpdateVersions.get(photoId) === version;
}

async function api(path, options = {}) {
  const response = await fetch(path, options);
  if (!response.ok) {
    let message = "Something went wrong. Please try again.";
    try {
      const payload = await response.json();
      if (payload.error) message = payload.error;
    } catch {
      if (response.status === 413) {
        message = "That upload is too large. Try a smaller export of the photo.";
      }
    }
    throw new Error(message);
  }
  if (response.status === 204) return null;
  return response.json();
}

function updateLibrarySummary() {
  const count = state.photos.length;
  elements.emptyState.hidden = count !== 0;
  if (!count) {
    elements.rangeReadout.textContent = "No photos";
    return;
  }
  const dates = state.photos.map((photo) => parsePhotoDate(photo.capturedAt));
  const newest = new Date(Math.max(...dates.map((date) => date.valueOf())));
  const oldest = new Date(Math.min(...dates.map((date) => date.valueOf())));
  const range = newest.getFullYear() === oldest.getFullYear()
    ? String(newest.getFullYear())
    : `${formatRangeDate(oldest)} — ${formatRangeDate(newest)}`;
  elements.rangeReadout.textContent = `${count} ${count === 1 ? "model" : "models"} · ${range}`;
}

function clearTimeline() {
  elements.photoField.querySelectorAll(".photo-card").forEach((node) => node.remove());
}

function displayedXPosition(position, fieldWidth, cardWidth = CARD_WIDTH) {
  const halfCardPercent = cardWidth / 2 / fieldWidth * 100;
  return clamp(position, halfCardPercent, 100 - halfCardPercent);
}

function chronologicalPlacements(photos, fieldWidth) {
  const ordered = [...photos].sort((first, second) => {
    const direction = state.newestFirst ? -1 : 1;
    const timeDifference = direction * (parsePhotoDate(first.capturedAt) - parsePhotoDate(second.capturedAt));
    if (timeDifference !== 0) return timeDifference;
    return direction * (parsePhotoDate(first.createdAt) - parsePhotoDate(second.createdAt));
  });
  const placements = [];
  let row = 0;
  let occupied = [];

  ordered.forEach((photo) => {
    const xPercent = displayedXPosition(photo.xPosition, fieldWidth);
    const center = xPercent / 100 * fieldWidth;
    const left = center - CARD_WIDTH / 2 - CARD_HORIZONTAL_GAP / 2;
    const right = center + CARD_WIDTH / 2 + CARD_HORIZONTAL_GAP / 2;
    const overlaps = occupied.some((interval) => (
      left < interval.right && right > interval.left
    ));
    if (overlaps) {
      row += 1;
      occupied = [];
    }
    occupied.push({ left, right });
    placements.push({
      photo,
      xPercent,
      y: TIMELINE_TOP_PADDING + row * (CARD_HEIGHT + ROW_GAP),
    });
  });
  return { placements, rowCount: ordered.length ? row + 1 : 0 };
}

function createPhotoCard(photo, xPercent, y) {
  const card = document.createElement("button");
  card.type = "button";
  card.className = "photo-card";
  card.dataset.photoId = photo.id;
  card.setAttribute("aria-label", `${photo.title}, ${formatCardDate(photo.capturedAt)}. Drag sideways to change color.`);
  card.style.setProperty("--x", `${xPercent}%`);
  card.style.setProperty("--y", `${y * state.zoom}px`);
  card.style.setProperty("--card-size", `${CARD_WIDTH * state.zoom}px`);
  card.innerHTML = `<img src="${photo.imageUrl}" alt="" draggable="false">`;
  bindCardInteractions(card, photo);
  return card;
}

function bindCardInteractions(card, photo) {
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
    card.style.setProperty("--x", `${displayedXPosition(position, fieldRect.width, CARD_WIDTH * state.zoom)}%`);
    card.dataset.pendingPosition = String(position);
    elements.hueGuide.hidden = false;
    elements.hueGuide.style.setProperty("--guide-x", `${position}%`);
    elements.hueGuideLabel.textContent = colorName(position);
  });

  const finish = async (event) => {
    if (event.pointerId !== pointerId) return;
    if (card.hasPointerCapture(pointerId)) card.releasePointerCapture(pointerId);
    pointerId = null;
    elements.hueGuide.hidden = true;
    card.classList.remove("dragging");
    if (!moved) return;
    suppressClick = true;
    const position = Number(card.dataset.pendingPosition);
    delete card.dataset.pendingPosition;
    const previous = {
      xPosition: photo.xPosition,
      primaryColor: photo.primaryColor,
      colorSource: photo.colorSource,
      hue: photo.hue,
      colorKind: photo.colorKind,
    };
    const version = beginPhotoUpdate(photo.id);
    Object.assign(photo, {
      xPosition: position,
      primaryColor: colorAtPosition(position),
      colorSource: "placed by you",
    });
    renderTimeline();
    try {
      const payload = await api(`/api/photos/${photo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xPosition: position }),
      });
      if (isCurrentPhotoUpdate(photo.id, version)) {
        replacePhoto(payload.photo);
        renderTimeline();
      }
    } catch (error) {
      if (isCurrentPhotoUpdate(photo.id, version)) {
        Object.assign(photo, previous);
        renderTimeline();
        showToast(error.message);
      }
    }
    window.setTimeout(() => { suppressClick = false; }, 0);
  };

  card.addEventListener("pointerup", finish);
  card.addEventListener("pointercancel", finish);
  card.addEventListener("click", () => {
    if (!suppressClick) openPhotoDialog(photo.id);
  });
  card.addEventListener("keydown", async (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    event.preventDefault();
    const change = event.key === "ArrowLeft" ? -0.5 : 0.5;
    const position = clamp(photo.xPosition + change, 0, 100);
    const previous = {
      xPosition: photo.xPosition,
      primaryColor: photo.primaryColor,
      colorSource: photo.colorSource,
      hue: photo.hue,
      colorKind: photo.colorKind,
    };
    const version = beginPhotoUpdate(photo.id);
    Object.assign(photo, {
      xPosition: position,
      primaryColor: colorAtPosition(position),
      colorSource: "placed by you",
    });
    renderTimeline();
    try {
      const payload = await api(`/api/photos/${photo.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ xPosition: position }),
      });
      if (isCurrentPhotoUpdate(photo.id, version)) {
        replacePhoto(payload.photo);
        renderTimeline();
      }
    } catch (error) {
      if (isCurrentPhotoUpdate(photo.id, version)) {
        Object.assign(photo, previous);
        renderTimeline();
        showToast(error.message);
      }
    }
  });
}

function renderTimeline() {
  clearTimeline();
  updateLibrarySummary();
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
  const fieldWidth = state.baseFieldWidth * state.zoom;
  elements.atlas.style.width = `${AXIS_WIDTH + fieldWidth}px`;
  const viewportHeight = Math.max(MINIMUM_TIMELINE_HEIGHT, elements.atlasScroll.clientHeight - COLOR_AXIS_HEIGHT);
  if (!state.photos.length) {
    elements.timelineBody.style.height = `${viewportHeight}px`;
    return;
  }

  const { placements, rowCount } = chronologicalPlacements(state.photos, state.baseFieldWidth);
  const baseContentHeight = (
    TIMELINE_TOP_PADDING
    + rowCount * CARD_HEIGHT
    + Math.max(0, rowCount - 1) * ROW_GAP
    + TIMELINE_BOTTOM_PADDING
  );
  const contentHeight = baseContentHeight * state.zoom;
  elements.timelineBody.style.height = `${Math.max(viewportHeight, contentHeight)}px`;
  placements.forEach(({ photo, xPercent, y }) => {
    elements.photoField.append(createPhotoCard(photo, xPercent, y));
  });
}

function setZoom(nextZoom, clientX, clientY) {
  const minimumZoom = state.baseFieldWidth === null
    ? MIN_ZOOM
    : Math.max(MIN_ZOOM, timelineFitZoom());
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

function timelineFitZoom() {
  const widthZoom = (elements.atlasScroll.clientWidth - AXIS_WIDTH) / state.baseFieldWidth;
  if (!state.photos.length) return widthZoom;
  const { rowCount } = chronologicalPlacements(state.photos, state.baseFieldWidth);
  const contentHeight = (
    TIMELINE_TOP_PADDING
    + rowCount * CARD_HEIGHT
    + Math.max(0, rowCount - 1) * ROW_GAP
    + TIMELINE_BOTTOM_PADDING
  );
  const heightZoom = (elements.atlasScroll.clientHeight - COLOR_AXIS_HEIGHT) / contentHeight;
  return Math.min(widthZoom, heightZoom);
}

function fitTimeline() {
  if (state.baseFieldWidth === null) renderTimeline();
  setZoom(timelineFitZoom());
  elements.atlasScroll.scrollTo({ left: 0, top: 0 });
}

function exportImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("A photo could not be included in the export."));
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
  context.drawImage(
    image,
    sourceX,
    sourceY,
    sourceSize,
    sourceSize,
    left,
    top,
    size,
    size,
  );
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
  if (!state.photos.length) {
    showToast("Add a photo before exporting.");
    return;
  }
  elements.exportButton.disabled = true;
  elements.exportButton.textContent = "Exporting…";
  try {
    if (state.baseFieldWidth === null) renderTimeline();
    const { placements, rowCount } = chronologicalPlacements(state.photos, state.baseFieldWidth);
    const contentHeight = (
      TIMELINE_TOP_PADDING
      + rowCount * CARD_HEIGHT
      + Math.max(0, rowCount - 1) * ROW_GAP
      + TIMELINE_BOTTOM_PADDING
    );
    const boardWidth = AXIS_WIDTH + state.baseFieldWidth;
    const boardHeight = COLOR_AXIS_HEIGHT + contentHeight;
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
    link.download = `models-${new Date().toISOString().slice(0, 10)}.png`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(downloadUrl), 1_000);
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.exportButton.disabled = false;
    elements.exportButton.textContent = "Export";
  }
}

async function createShare() {
  if (!state.photos.length) {
    showToast("Add a photo before sharing.");
    return;
  }
  elements.shareButton.disabled = true;
  elements.shareButton.textContent = "Sharing…";
  try {
    const payload = await api("/api/shares", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ newestFirst: state.newestFirst }),
    });
    const shareUrl = new URL(payload.url, window.location.href).href;
    elements.shareLink.value = shareUrl;
    elements.openShare.href = shareUrl;
    elements.shareDialog.showModal();
  } catch (error) {
    showToast(error.message);
  } finally {
    elements.shareButton.disabled = false;
    elements.shareButton.textContent = "Share";
  }
}

function replacePhoto(photo) {
  const existing = state.photos.find((candidate) => candidate.id === photo.id);
  if (existing) Object.assign(existing, photo);
  else state.photos.push(photo);
}

function openPhotoDialog(photoId) {
  const photo = state.photos.find((candidate) => candidate.id === photoId);
  if (!photo) return;
  state.activeId = photo.id;
  elements.dialogImage.src = photo.imageUrl;
  elements.dialogImage.alt = photo.title;
  elements.dialogTitle.value = photo.title;
  elements.dialogDate.value = photo.capturedAt.slice(0, 16);
  elements.dialogPosition.value = String(photo.xPosition);
  elements.dialogTimeSource.textContent = photo.timeSource;
  elements.dialogColorSource.textContent = `${colorName(photo.xPosition)} · ${photo.colorSource}`;
  elements.dialogColorDot.style.background = photo.primaryColor;
  elements.dialog.showModal();
}

elements.dialogPosition.addEventListener("input", () => {
  const position = Number(elements.dialogPosition.value);
  elements.dialogColorDot.style.background = colorAtPosition(position);
  elements.dialogColorSource.textContent = `${colorName(position)} · unsaved`;
});

elements.dialogForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const photoId = state.activeId;
  if (!photoId) return;
  const version = beginPhotoUpdate(photoId);
  elements.saveButton.disabled = true;
  elements.saveButton.textContent = "Saving…";
  try {
    const payload = await api(`/api/photos/${photoId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: elements.dialogTitle.value,
        capturedAt: elements.dialogDate.value,
        xPosition: Number(elements.dialogPosition.value),
      }),
    });
    if (isCurrentPhotoUpdate(photoId, version)) {
      replacePhoto(payload.photo);
      elements.dialog.close();
      renderTimeline();
      showToast("Model updated");
    }
  } catch (error) {
    if (isCurrentPhotoUpdate(photoId, version)) showToast(error.message);
  } finally {
    elements.saveButton.disabled = false;
    elements.saveButton.textContent = "Save changes";
  }
});

elements.deleteButton.addEventListener("click", async () => {
  const photo = state.photos.find((candidate) => candidate.id === state.activeId);
  if (!photo || !window.confirm(`Delete “${photo.title}” from this timeline?`)) return;
  beginPhotoUpdate(photo.id);
  try {
    await api(`/api/photos/${photo.id}`, { method: "DELETE" });
    state.photos = state.photos.filter((candidate) => candidate.id !== photo.id);
    elements.dialog.close();
    renderTimeline();
    showToast("Photo deleted");
  } catch (error) {
    showToast(error.message);
  }
});

elements.dialog.addEventListener("close", () => {
  state.activeId = null;
  elements.dialogImage.removeAttribute("src");
});

function readExifAscii(view, tiffStart, entryOffset, littleEndian) {
  if (entryOffset + 12 > view.byteLength) return null;
  const type = view.getUint16(entryOffset + 2, littleEndian);
  const count = view.getUint32(entryOffset + 4, littleEndian);
  if (type !== 2 || count < 10 || count > 64) return null;
  const valueOffset = count <= 4
    ? entryOffset + 8
    : tiffStart + view.getUint32(entryOffset + 8, littleEndian);
  if (valueOffset < 0 || valueOffset + count > view.byteLength) return null;
  let value = "";
  for (let index = 0; index < count; index += 1) {
    const character = view.getUint8(valueOffset + index);
    if (character === 0) break;
    value += String.fromCharCode(character);
  }
  return value;
}

function readExifIfd(view, tiffStart, ifdOffset, littleEndian) {
  const absolute = tiffStart + ifdOffset;
  if (absolute < 0 || absolute + 2 > view.byteLength) return {};
  const count = view.getUint16(absolute, littleEndian);
  const values = {};
  for (let index = 0; index < count; index += 1) {
    const entry = absolute + 2 + index * 12;
    if (entry + 12 > view.byteLength) break;
    const tag = view.getUint16(entry, littleEndian);
    if ([0x0132, 0x9003, 0x9004].includes(tag)) {
      values[tag] = readExifAscii(view, tiffStart, entry, littleEndian);
    }
    if (tag === 0x8769) {
      values.exifOffset = view.getUint32(entry + 8, littleEndian);
    }
  }
  return values;
}

async function jpegCaptureDate(file) {
  if (!/jpe?g/i.test(file.type) && !/\.jpe?g$/i.test(file.name)) return null;
  const buffer = await file.slice(0, 512 * 1024).arrayBuffer();
  const view = new DataView(buffer);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let offset = 2;
  while (offset + 4 < view.byteLength) {
    const marker = view.getUint16(offset);
    if ((marker & 0xff00) !== 0xff00) break;
    const length = view.getUint16(offset + 2);
    if (marker === 0xffe1 && offset + 10 < view.byteLength) {
      const exif = String.fromCharCode(...new Uint8Array(buffer, offset + 4, 4));
      if (exif !== "Exif") {
        offset += 2 + length;
        continue;
      }
      const tiffStart = offset + 10;
      const byteOrder = view.getUint16(tiffStart);
      const littleEndian = byteOrder === 0x4949;
      if (!littleEndian && byteOrder !== 0x4d4d) return null;
      const firstIfd = view.getUint32(tiffStart + 4, littleEndian);
      const root = readExifIfd(view, tiffStart, firstIfd, littleEndian);
      const details = root.exifOffset
        ? readExifIfd(view, tiffStart, root.exifOffset, littleEndian)
        : {};
      const raw = details[0x9003] || details[0x9004] || root[0x0132];
      if (!raw) return null;
      const match = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}):(\d{2}):(\d{2})/);
      if (!match) return null;
      return `${match[1]}-${match[2]}-${match[3]}T${match[4]}:${match[5]}:${match[6]}`;
    }
    if (length < 2) break;
    offset += 2 + length;
  }
  return null;
}

function canvasBlob(canvas, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("This browser could not prepare that image."));
    }, "image/jpeg", quality);
  });
}

function localIsoDate(date) {
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

async function prepareUploadFile(file) {
  if (file.size <= 3_650_000) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This large HEIC photo cannot be resized in this browser. Export it as JPEG first.");
  }
  const scale = Math.min(1, 2300 / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  const context = canvas.getContext("2d", { alpha: false });
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  let quality = 0.88;
  let blob = await canvasBlob(canvas, quality);
  while (blob.size > 3_650_000 && quality > 0.58) {
    quality -= 0.08;
    blob = await canvasBlob(canvas, quality);
  }
  if (blob.size > 3_900_000) {
    throw new Error("This photo is still too large after resizing. Try a smaller export.");
  }
  const filename = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], filename, { type: "image/jpeg", lastModified: file.lastModified });
}

async function uploadFiles(fileList) {
  const files = [...fileList].filter((file) => file.type.startsWith("image/") || /\.(heic|heif)$/i.test(file.name));
  if (!files.length) {
    showToast("Choose an image file to add.");
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
      status.textContent = "Analyzing";
      const form = new FormData();
      form.append("photo", prepared, prepared.name);
      form.append("last_modified", localIsoDate(new Date(file.lastModified)));
      if (captureDate) form.append("captured_at_hint", captureDate);
      const payload = await api("/api/photos", { method: "POST", body: form });
      replacePhoto(payload.photo);
      row.classList.add("done");
      status.textContent = "Added";
      succeeded += 1;
    } catch (error) {
      row.classList.add("failed");
      status.textContent = error.message;
    }
    completed += 1;
    elements.uploadSummary.textContent = completed === files.length
      ? `${succeeded} of ${files.length} added`
      : `Processing ${completed + 1} of ${files.length}`;
    elements.uploadProgressBar.style.width = `${completed / files.length * 100}%`;
    renderTimeline();
  }
  elements.input.value = "";
  if (succeeded) {
    document.querySelector(".atlas-section").scrollIntoView({ behavior: "smooth", block: "start" });
  }
}

document.querySelectorAll("#toolbar-upload, #empty-upload").forEach((button) => {
  button.addEventListener("click", () => elements.input.click());
});
elements.input.addEventListener("change", () => uploadFiles(elements.input.files));
document.querySelector("#upload-tray-close").addEventListener("click", () => {
  elements.uploadTray.hidden = true;
});

document.querySelector("#zoom-out").addEventListener("click", () => setZoom(state.zoom / ZOOM_STEP));
document.querySelector("#zoom-in").addEventListener("click", () => setZoom(state.zoom * ZOOM_STEP));
document.querySelector("#zoom-fit").addEventListener("click", fitTimeline);
elements.exportButton.addEventListener("click", exportBoard);
elements.shareButton.addEventListener("click", createShare);
elements.copyShare.addEventListener("click", async () => {
  let copied = false;
  try {
    await navigator.clipboard.writeText(elements.shareLink.value);
    copied = true;
  } catch {
    elements.shareLink.select();
    copied = document.execCommand("copy");
  }
  if (copied) {
    elements.copyShare.textContent = "Copied";
    window.setTimeout(() => { elements.copyShare.textContent = "Copy link"; }, 1_500);
  } else {
    elements.shareLink.select();
    showToast("Copy the selected link.");
  }
});
elements.timelineDirection.addEventListener("click", () => {
  state.newestFirst = !state.newestFirst;
  renderTimeline();
});

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

async function loadLibrary() {
  try {
    const payload = await api("/api/photos");
    state.photos = payload.photos;
    renderTimeline();
  } catch (error) {
    showToast(error.message);
  }
}

loadLibrary();

let resizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderTimeline, 100);
});
