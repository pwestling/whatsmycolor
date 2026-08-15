const state = {
  photos: [],
  newestFirst: true,
  zoom: 1,
  baseFieldWidth: null,
};

const elements = {
  rangeReadout: document.querySelector("#range-readout"),
  atlasScroll: document.querySelector("#atlas-scroll"),
  atlas: document.querySelector("#atlas"),
  timelineDirection: document.querySelector("#timeline-direction"),
  timeDirectionTop: document.querySelector("#time-direction-top"),
  timeDirectionBottom: document.querySelector("#time-direction-bottom"),
  timelineBody: document.querySelector("#timeline-body"),
  photoField: document.querySelector("#photo-field"),
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

function parsePhotoDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date() : parsed;
}

function formatRangeDate(date) {
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    year: "numeric",
  }).format(date);
}

function updateSummary() {
  const count = state.photos.length;
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

function displayedXPosition(position, fieldWidth) {
  const halfCardPercent = CARD_WIDTH / 2 / fieldWidth * 100;
  return clamp(position, halfCardPercent, 100 - halfCardPercent);
}

function chronologicalPlacements(photos, fieldWidth) {
  const direction = state.newestFirst ? -1 : 1;
  const ordered = [...photos].sort((first, second) => {
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
    if (occupied.some((interval) => left < interval.right && right > interval.left)) {
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
  const card = document.createElement("div");
  card.className = "photo-card shared-photo";
  card.style.setProperty("--x", `${xPercent}%`);
  card.style.setProperty("--y", `${y * state.zoom}px`);
  card.style.setProperty("--card-size", `${CARD_WIDTH * state.zoom}px`);
  const image = document.createElement("img");
  image.src = photo.imageUrl;
  image.alt = photo.title;
  image.draggable = false;
  card.append(image);
  return card;
}

function renderTimeline() {
  elements.photoField.replaceChildren();
  updateSummary();
  elements.timeDirectionTop.textContent = state.newestFirst ? "Newer" : "Older";
  elements.timeDirectionBottom.textContent = state.newestFirst ? "Older" : "Newer";
  elements.timelineDirection.textContent = state.newestFirst ? "↓" : "↑";
  const directionLabel = state.newestFirst ? "Show oldest first" : "Show newest first";
  elements.timelineDirection.setAttribute("aria-label", directionLabel);
  elements.timelineDirection.title = directionLabel;
  if (state.baseFieldWidth === null) {
    state.baseFieldWidth = Math.max(elements.atlasScroll.clientWidth - AXIS_WIDTH, 1008);
  }
  const fieldWidth = state.baseFieldWidth * state.zoom;
  elements.atlas.style.width = `${AXIS_WIDTH + fieldWidth}px`;
  const viewportHeight = Math.max(MINIMUM_TIMELINE_HEIGHT, elements.atlasScroll.clientHeight - COLOR_AXIS_HEIGHT);
  const { placements, rowCount } = chronologicalPlacements(state.photos, state.baseFieldWidth);
  const contentHeight = (
    TIMELINE_TOP_PADDING
    + rowCount * CARD_HEIGHT
    + Math.max(0, rowCount - 1) * ROW_GAP
    + TIMELINE_BOTTOM_PADDING
  ) * state.zoom;
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

elements.timelineDirection.addEventListener("click", () => {
  state.newestFirst = !state.newestFirst;
  renderTimeline();
});
document.querySelector("#zoom-out").addEventListener("click", () => setZoom(state.zoom / ZOOM_STEP));
document.querySelector("#zoom-in").addEventListener("click", () => setZoom(state.zoom * ZOOM_STEP));
document.querySelector("#zoom-fit").addEventListener("click", fitTimeline);

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
  if (event.button !== 0) return;
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

async function loadShare() {
  const shareId = window.location.pathname.split("/").filter(Boolean).at(-1);
  try {
    const response = await fetch(`/api/shares/${encodeURIComponent(shareId)}`);
    if (!response.ok) throw new Error("Shared board not found.");
    const payload = await response.json();
    state.photos = payload.photos;
    state.newestFirst = payload.share.newestFirst;
    renderTimeline();
  } catch (error) {
    elements.rangeReadout.textContent = error.message;
  }
}

loadShare();

let resizeTimer = null;
window.addEventListener("resize", () => {
  window.clearTimeout(resizeTimer);
  resizeTimer = window.setTimeout(renderTimeline, 100);
});
