export const MAX_VISITOR_NAME_LENGTH = 40;

export function normalizeVisitorName(value) {
  return String(value ?? "").normalize("NFKC").trim().replace(/\s+/g, " ");
}

export function validVisitorName(value) {
  const name = normalizeVisitorName(value);
  return name.length > 0 && name.length <= MAX_VISITOR_NAME_LENGTH;
}

export function visitorNameStorageKey(boardSlug) {
  return `wmc-community-name:${boardSlug}`;
}

export function canVisitorMovePhoto(photo, visitorName) {
  const name = normalizeVisitorName(visitorName);
  const uploaderName = photo?.uploaderName ?? "";
  return Boolean(name && uploaderName && name === uploaderName);
}
