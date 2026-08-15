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

export async function jpegCaptureDate(file) {
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

export function localIsoDate(date) {
  const local = new Date(date.valueOf() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 19);
}

export async function prepareUploadFile(file) {
  if (file.size <= 3_650_000) return file;
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
  } catch {
    throw new Error("This large HEIC photo cannot be resized here. Export it as JPEG first.");
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
    throw new Error("This photo is still too large. Try a smaller export.");
  }
  const filename = file.name.replace(/\.[^.]+$/, "") + ".jpg";
  return new File([blob], filename, {
    type: "image/jpeg",
    lastModified: file.lastModified,
  });
}
