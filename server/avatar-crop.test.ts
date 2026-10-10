import { describe, expect, it } from "vitest";
import sharp from "sharp";
import { normalizeCrop } from "../client/src/lib/avatar-crop";
import { compressAvatar } from "./routes/avatars";

describe("프로필 크롭·저장 압축", () => {
  it("정사각형 크롭을 이미지 경계 안으로 제한한다", () => {
    expect(normalizeCrop({x:-10,y:95,width:50,height:50},100,100)).toEqual({x:0,y:50,width:50,height:50});
    expect(normalizeCrop({x:0,y:0,width:500,height:400},200,100)).toEqual({x:0,y:0,width:100,height:100});
  });
  it("유효하지 않은 크롭과 크기 값을 거절한다", () => {
    expect(() => normalizeCrop({x:NaN,y:0,width:5,height:5},100,100)).toThrow();
    expect(() => normalizeCrop({x:0,y:0,width:0,height:5},100,100)).toThrow();
  });
  it("큰 이미지를 256px 정사각형 WebP, 64KiB 이하로 저장한다", async () => {
    const source = await sharp({create:{width:1800,height:1200,channels:3,background:{r:100,g:120,b:180}}}).jpeg().toBuffer();
    const result = await compressAvatar(source);
    const metadata = await sharp(result.buffer).metadata();
    expect(metadata.width).toBe(256); expect(metadata.height).toBe(256);
    expect(metadata.format).toBe("webp"); expect(metadata.exif).toBeUndefined();
    expect(result.buffer.length).toBeLessThanOrEqual(64*1024);
  });
  it("헤더만 이미지인 가짜 파일은 실제 디코딩에서 거절한다", async () => {
    await expect(compressAvatar(Buffer.from([0xff,0xd8,0xff,0x00]))).rejects.toThrow("INVALID_AVATAR_IMAGE");
  });
});
