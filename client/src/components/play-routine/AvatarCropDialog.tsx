import Cropper from "react-easy-crop";
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Loader2 } from "lucide-react";
import { cropAvatar, type CropPixels } from "@/lib/avatar-crop";

export default function AvatarCropDialog({ imageUrl, onCancel, onSave, busy }: {
  imageUrl: string | null; onCancel: () => void; onSave: (blob: Blob) => Promise<void>; busy: boolean;
}) {
  const [crop, setCrop] = useState({ x: 0, y: 0 });
  const [zoom, setZoom] = useState(1);
  const [pixels, setPixels] = useState<CropPixels | null>(null);
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => { setCrop({x:0,y:0}); setZoom(1); setPixels(null); setError(null); }, [imageUrl]);
  const disabled = busy || processing;
  const save = async () => {
    if (!imageUrl || !pixels) return;
    setProcessing(true); setError(null);
    try { await onSave(await cropAvatar(imageUrl, pixels)); }
    catch (e) { setError(e instanceof Error ? e.message : "사진을 저장하지 못했습니다."); }
    finally { setProcessing(false); }
  };
  return <Dialog open={Boolean(imageUrl)} onOpenChange={open => { if (!open && !disabled) onCancel(); }}>
    <DialogContent className="max-w-[420px] rounded-[24px] border-0 bg-white shadow-none" onEscapeKeyDown={e => { if (disabled) e.preventDefault(); }} onInteractOutside={e => { if (disabled) e.preventDefault(); }}>
      <DialogHeader><DialogTitle>프로필 사진 자르기</DialogTitle><DialogDescription>사진을 움직이고 확대해 정사각형으로 잘라 주세요. 256 × 256 픽셀로 압축해 저장합니다.</DialogDescription></DialogHeader>
      <div className="relative aspect-square overflow-hidden rounded-2xl bg-[#eeeae1]" aria-label="사진 자르기 미리보기">
        {imageUrl && <Cropper image={imageUrl} crop={crop} zoom={zoom} aspect={1} cropShape="rect" showGrid onCropChange={setCrop} onZoomChange={setZoom} onCropComplete={(_area, area) => setPixels(area)} />}
      </div>
      <div className="space-y-2"><Label htmlFor="avatar-zoom">확대</Label><input id="avatar-zoom" type="range" min={1} max={3} step={0.01} value={zoom} onChange={e => setZoom(Number(e.target.value))} disabled={disabled} className="w-full accent-[#4d2ddc]" /></div>
      {error && <p role="alert" className="text-sm text-red-700">{error}</p>}
      <div className="flex justify-end gap-2"><Button variant="ghost" disabled={disabled} onClick={onCancel}>취소</Button><Button disabled={disabled || !pixels} onClick={save} className="rounded-xl bg-[#4d2ddc] text-white">{disabled && <Loader2 className="h-4 w-4 animate-spin" />} 자르고 저장</Button></div>
    </DialogContent>
  </Dialog>;
}
