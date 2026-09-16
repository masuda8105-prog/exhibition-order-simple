export const MAX_PHOTOS = 6;
export const MAX_PHOTO_BYTES = 20 * 1024 * 1024;

export function validatePhoto(file) {
  if (!file || file.size <= 0) return "空のファイルは添付できません。";
  if (file.size > MAX_PHOTO_BYTES) return "写真は1枚20MBまでです。";
  if (!/^image\/(jpeg|png|webp|heic|heif)$/i.test(file.type || "")
    && !(file.type === "" && /\.(jpe?g|png|webp|heic|heif)$/i.test(file.name || ""))) {
    return "JPEG・PNG・WebP・HEIC形式の写真を選んでください。";
  }
  return "";
}

export function createAttachmentStore(revoke = url => URL.revokeObjectURL(url)) {
  const byOrder = new Map();
  let generation = 0;
  return {
    get generation() { return generation; },
    list(id) { return byOrder.get(id) || []; },
    add(id, photo, expectedGeneration = generation) {
      if (!id || generation !== expectedGeneration || this.list(id).length >= MAX_PHOTOS) { revoke(photo.url); return false; }
      byOrder.set(id, [...this.list(id), photo]);
      return true;
    },
    remove(id, photoId) {
      byOrder.set(id, this.list(id).filter(photo => {
        if (photo.id !== photoId) return true;
        revoke(photo.url);
        return false;
      }));
    },
    clear() {
      for (const photos of byOrder.values()) for (const photo of photos) revoke(photo.url);
      byOrder.clear();
      generation++;
    },
  };
}

// Decode and re-encode locally: no original photo or GPS/EXIF metadata is uploaded.
export async function preparePhoto(file) {
  const error = validatePhoto(file);
  if (error) throw new Error(error);
  const source = URL.createObjectURL(file);
  const image = new Image();
  try {
    image.src = source;
    await image.decode();
    if (!image.naturalWidth || !image.naturalHeight) throw new Error("画像サイズを確認できませんでした。");
    const scale = Math.min(1, 2400 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("写真を処理できませんでした。");
    context.fillStyle = "#fff";
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, "image/jpeg", 0.92));
    canvas.width = canvas.height = 1;
    if (!blob) throw new Error("写真を処理できませんでした。");
    return { id: crypto.randomUUID(), name: file.name || "撮影した写真", url: URL.createObjectURL(blob) };
  } catch (error) {
    throw new Error(error.message.includes("処理") ? error.message : "この写真を読み込めません。JPEG・PNGで保存し直すか、カメラで撮り直してください。");
  } finally { image.src = ""; URL.revokeObjectURL(source); }
}
