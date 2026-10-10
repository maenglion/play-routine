import { useEffect, useRef, useState } from "react";
import { Camera } from "lucide-react";
import { toast } from "sonner";
import { supabase } from "@/lib/supabase";
import { blobToDataUrl } from "@/lib/avatar-crop";
import AvatarCropDialog from "./AvatarCropDialog";
import type { ParentChildProfile } from "./ParentDashboard";

export default function ParentAvatarEditor({ child, onUpdated }: { child: ParentChildProfile; onUpdated?: (child: ParentChildProfile) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [currentUrl, setCurrentUrl] = useState(child.avatar_url);
  useEffect(() => { setCurrentUrl(child.avatar_url); }, [child.avatar_url]);
  useEffect(() => () => { if (imageUrl) URL.revokeObjectURL(imageUrl); }, [imageUrl]);
  const select = (file?: File) => {
    if (!file) return;
    if (!["image/jpeg", "image/png", "image/webp"].includes(file.type) || file.size > 15 * 1024 * 1024) { toast.error("15MB 이하 JPG, PNG, WEBP 사진을 선택해 주세요."); return; }
    setImageUrl(URL.createObjectURL(file));
    if (input.current) input.current.value = "";
  };
  const save = async (blob: Blob) => {
    setSaving(true);
    try {
      const {data} = await supabase.auth.getSession();
      if (!data.session) throw new Error("부모 계정으로 다시 로그인해 주세요.");
      const response = await fetch("/api/profile/avatar", {method:"POST",headers:{Authorization:`Bearer ${data.session.access_token}`,"Content-Type":"application/json"},body:JSON.stringify({childProfileId:child.id,dataUrl:await blobToDataUrl(blob)})});
      const result = await response.json();
      if (!response.ok) throw new Error("사진을 저장하지 못했습니다. 가족 연결과 로그인 상태를 확인해 주세요.");
      setCurrentUrl(result.profile.avatar_url); onUpdated?.(result.profile); setImageUrl(null); toast.success("자녀 프로필 사진을 저장했습니다.");
    } finally { setSaving(false); }
  };
  return <>
    <input ref={input} type="file" accept="image/jpeg,image/png,image/webp" className="hidden" onChange={e => select(e.target.files?.[0])} />
    <button type="button" onClick={() => input.current?.click()} disabled={saving || child.status !== "ACTIVE"} className="group relative flex h-10 w-10 shrink-0 items-center justify-center overflow-hidden rounded-full bg-[#d4cfe7] text-sm font-bold text-[#4d2ddc] shadow-none" aria-label={`${child.display_name} 프로필 사진 변경`}>
      {currentUrl ? <img src={currentUrl} alt={`${child.display_name} 프로필`} className="h-full w-full object-cover" /> : child.display_name.slice(0,1)}
      {child.status === "ACTIVE" && <span className="absolute inset-0 flex items-center justify-center bg-black/40 text-white opacity-0 group-hover:opacity-100 group-focus-visible:opacity-100"><Camera className="h-4 w-4" /></span>}
    </button>
    <AvatarCropDialog imageUrl={imageUrl} busy={saving} onCancel={() => setImageUrl(null)} onSave={save} />
  </>;
}
