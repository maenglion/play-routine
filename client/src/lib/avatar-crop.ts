export type CropPixels = { x: number; y: number; width: number; height: number };
export const AVATAR_SIDE = 256;
export const AVATAR_MAX_BYTES = 64 * 1024;

export function normalizeCrop(crop: CropPixels, imageWidth: number, imageHeight: number) {
  if (![crop.x, crop.y, crop.width, crop.height, imageWidth, imageHeight].every(Number.isFinite) || imageWidth <= 0 || imageHeight <= 0 || crop.width <= 0 || crop.height <= 0) {
    throw new Error("자르기 영역을 다시 선택해 주세요.");
  }
  const side = Math.max(1, Math.min(Math.round(crop.width), Math.round(crop.height), imageWidth, imageHeight));
  return { x: Math.max(0, Math.min(Math.round(crop.x), imageWidth - side)), y: Math.max(0, Math.min(Math.round(crop.y), imageHeight - side)), width: side, height: side };
}

export async function cropAvatar(imageUrl: string, pixels: CropPixels) {
  const image = await new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("사진을 읽지 못했습니다. 다른 사진을 선택해 주세요."));
    img.src = imageUrl;
  });
  const crop = normalizeCrop(pixels, image.naturalWidth, image.naturalHeight);
  const canvas = document.createElement("canvas");
  canvas.width = AVATAR_SIDE; canvas.height = AVATAR_SIDE;
  const context = canvas.getContext("2d");
  if (!context) throw new Error("이 브라우저에서는 사진 자르기를 지원하지 않습니다.");
  context.imageSmoothingQuality = "high";
  context.drawImage(image, crop.x, crop.y, crop.width, crop.height, 0, 0, AVATAR_SIDE, AVATAR_SIDE);
  for (const quality of [0.82, 0.7, 0.55, 0.4]) {
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("사진 압축에 실패했습니다.")), "image/webp", quality));
    if (blob.size <= AVATAR_MAX_BYTES) return blob;
  }
  throw new Error("사진 용량을 줄이지 못했습니다. 더 단순한 사진을 선택해 주세요.");
}

export function blobToDataUrl(blob: Blob) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("사진을 읽지 못했습니다."));
    reader.readAsDataURL(blob);
  });
}
