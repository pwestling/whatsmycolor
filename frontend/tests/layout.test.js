import { describe, expect, test } from "bun:test";

import {
  CARD_HORIZONTAL_GAP,
  CARD_WIDTH,
  chronologicalPlacements,
  displayedXPosition,
} from "../layout.js";

const photo = (id, capturedAt, xPosition, createdAt = capturedAt) => ({
  id,
  capturedAt,
  createdAt,
  xPosition,
});

describe("community timeline layout", () => {
  test("preserves chronological order while starting a new row on overlap", () => {
    const photos = [
      photo("middle", "2024-02-01T00:00:00", 50),
      photo("new", "2024-03-01T00:00:00", 50),
      photo("old", "2024-01-01T00:00:00", 80),
    ];

    const { placements, rowCount } = chronologicalPlacements(photos, 1000, true);

    expect(placements.map((placement) => placement.photo.id)).toEqual([
      "new",
      "middle",
      "old",
    ]);
    expect(rowCount).toBe(2);
    expect(placements[1].y).toBeGreaterThan(placements[0].y);
    expect(placements[2].y).toBe(placements[1].y);
  });

  test("uses a stable id tie-breaker and reverses it with timeline direction", () => {
    const photos = [
      photo("b", "2024-01-01T00:00:00", 10),
      photo("a", "2024-01-01T00:00:00", 80),
    ];

    expect(
      chronologicalPlacements(photos, 1000, true).placements.map(({ photo }) => photo.id),
    ).toEqual(["b", "a"]);
    expect(
      chronologicalPlacements(photos, 1000, false).placements.map(({ photo }) => photo.id),
    ).toEqual(["a", "b"]);
  });

  test("keeps edge cards fully within the horizontal field", () => {
    const fieldWidth = 1000;
    const minimum = displayedXPosition(0, fieldWidth);
    const maximum = displayedXPosition(100, fieldWidth);

    expect(minimum / 100 * fieldWidth).toBe(CARD_WIDTH / 2);
    expect(maximum / 100 * fieldWidth).toBe(fieldWidth - CARD_WIDTH / 2);
    expect(maximum - minimum).toBeGreaterThan(CARD_HORIZONTAL_GAP);
  });
});
