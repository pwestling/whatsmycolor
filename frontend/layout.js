export const CARD_WIDTH = 118;
export const CARD_HEIGHT = 118;
export const CARD_HORIZONTAL_GAP = 4;
export const ROW_GAP = 4;
export const TIMELINE_TOP_PADDING = 20;
export const TIMELINE_BOTTOM_PADDING = 32;
export const AXIS_WIDTH = 112;
export const COLOR_AXIS_HEIGHT = 80;

export const clamp = (value, minimum, maximum) => (
  Math.min(maximum, Math.max(minimum, value))
);

export function parsePhotoDate(value) {
  const parsed = new Date(value);
  return Number.isNaN(parsed.valueOf()) ? new Date(0) : parsed;
}

export function displayedXPosition(position, fieldWidth, cardWidth = CARD_WIDTH) {
  const halfCardPercent = cardWidth / 2 / fieldWidth * 100;
  return clamp(position, halfCardPercent, 100 - halfCardPercent);
}

export function chronologicalPlacements(
  photos,
  fieldWidth,
  newestFirst,
) {
  const ordered = [...photos].sort((first, second) => {
    const direction = newestFirst ? -1 : 1;
    const timeDifference = direction * (
      parsePhotoDate(first.capturedAt) - parsePhotoDate(second.capturedAt)
    );
    if (timeDifference !== 0) return timeDifference;
    const creationDifference = direction * (
      parsePhotoDate(first.createdAt) - parsePhotoDate(second.createdAt)
    );
    if (creationDifference !== 0) return creationDifference;
    return direction * first.id.localeCompare(second.id);
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
    placements.push({ photo, xPercent, y: TIMELINE_TOP_PADDING + row * (CARD_HEIGHT + ROW_GAP) });
  });

  return { placements, rowCount: ordered.length ? row + 1 : 0 };
}

export function contentHeight(rowCount) {
  return (
    TIMELINE_TOP_PADDING
    + rowCount * CARD_HEIGHT
    + Math.max(0, rowCount - 1) * ROW_GAP
    + TIMELINE_BOTTOM_PADDING
  );
}
