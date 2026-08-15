import { describe, expect, test } from "bun:test";

import {
  canVisitorMovePhoto,
  normalizeVisitorName,
  validVisitorName,
  visitorNameStorageKey,
} from "../identity.js";

describe("community visitor names", () => {
  test("normalizes spacing and compatibility characters", () => {
    expect(normalizeVisitorName("  Porter\n  Westling ")).toBe("Porter Westling");
    expect(normalizeVisitorName("Ｐｏｒｔｅｒ")).toBe("Porter");
  });

  test("requires one to forty normalized characters", () => {
    expect(validVisitorName(" ")).toBe(false);
    expect(validVisitorName("a".repeat(40))).toBe(true);
    expect(validVisitorName("a".repeat(41))).toBe(false);
  });

  test("matches an attributed photo exactly", () => {
    expect(canVisitorMovePhoto({ uploaderName: "Porter" }, "Porter")).toBe(true);
    expect(canVisitorMovePhoto({ uploaderName: "Porter" }, "porter")).toBe(false);
    expect(canVisitorMovePhoto({ uploaderName: "" }, "Porter")).toBe(false);
    expect(canVisitorMovePhoto({}, "Porter")).toBe(false);
  });

  test("stores a separate name for each board", () => {
    expect(visitorNameStorageKey("models")).toBe("wmc-community-name:models");
  });
});
