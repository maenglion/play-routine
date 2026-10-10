import { createClient } from "@supabase/supabase-js";
import type { Express, Request } from "express";
import { Pool } from "pg";
import { storagePut } from "../storage";
import { getSupabaseConnectionString } from "../supabaseConnection";
import sharp from "sharp";

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

let pool: Pool | null = null;

function getPool() {
  if (!pool) {
    const connectionString = getSupabaseConnectionString();
    pool = new Pool({
      connectionString,
      max: 4,
      idleTimeoutMillis: 10_000,
      connectionTimeoutMillis: 10_000,
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error("Supabase server configuration is missing");
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function bearerToken(req: Request) {
  const authorization = req.headers.authorization;
  if (!authorization?.startsWith("Bearer ")) return null;
  return authorization.slice("Bearer ".length).trim();
}

export function decodeAvatarDataUrl(dataUrl: string) {
  const match = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!match) throw new Error("INVALID_AVATAR_FORMAT");
  const mime = match[1];
  const buffer = Buffer.from(match[2], "base64");
  if (buffer.length === 0 || buffer.length > MAX_AVATAR_BYTES) {
    throw new Error("INVALID_AVATAR_SIZE");
  }

  const isJpeg = mime === "image/jpeg" && buffer[0] === 0xff && buffer[1] === 0xd8;
  const isPng = mime === "image/png" && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  const isWebp = mime === "image/webp" && buffer.subarray(0, 4).toString("ascii") === "RIFF" && buffer.subarray(8, 12).toString("ascii") === "WEBP";
  if (!isJpeg && !isPng && !isWebp) throw new Error("INVALID_AVATAR_SIGNATURE");

  return { buffer, mime, extension: MIME_EXTENSIONS[mime] };
}

export async function compressAvatar(buffer: Buffer) {
  try {
    // 실제 이미지 디코딩 검증. EXIF를 제거하고 서버에서도 저장 크기를 보장한다.
    const image = sharp(buffer, { limitInputPixels: 24_000_000, animated: false });
    const metadata = await image.metadata();
    if (!metadata.width || !metadata.height) throw new Error("INVALID_AVATAR_IMAGE");
    const output = await image.rotate().resize(256, 256, { fit: "cover" }).webp({ quality: 80, effort: 4 }).toBuffer();
    if (output.length > 64 * 1024) throw new Error("INVALID_AVATAR_SIZE");
    return { buffer: output, mime: "image/webp", extension: "webp" };
  } catch (error) {
    if (error instanceof Error && error.message === "INVALID_AVATAR_SIZE") throw error;
    throw new Error("INVALID_AVATAR_IMAGE");
  }
}

export async function avatarProfileForAuthUser(db: Pick<Pool, "query">, authUserId: string, requestedProfileId?: string) {
  const result = await db.query<{
    child_profile_id: string;
    family_id: string;
    display_name: string;
  }>(
    `select cp.id as child_profile_id, cp.family_id, cp.display_name
       from public.principals p
       join public.family_memberships fm
         on fm.principal_id = p.id
        and fm.status = 'ACTIVE'
       join public.child_profiles cp
         on cp.family_id = fm.family_id
        and cp.status = 'ACTIVE'
       join public.families f on f.id = fm.family_id and f.status = 'ACTIVE'
      where p.auth_user_id = $1
        and p.status = 'ACTIVE'
        and (
          (fm.role = 'CHILD' and cp.principal_id = p.id)
          or (fm.role in ('OWNER_PARENT', 'PARENT') and $2::uuid is not null)
        )
        and ($2::uuid is null or cp.id = $2::uuid)
      order by cp.linked_at desc
      limit 1`,
    [authUserId, requestedProfileId ?? null],
  );
  return result.rows[0] ?? null;
}

export function registerAvatarRoutes(app: Express) {
  app.post("/api/profile/avatar", async (req, res) => {
    try {
      const token = bearerToken(req);
      if (!token) return res.status(401).json({ error: "AUTH_REQUIRED" });

      const { data, error } = await getSupabase().auth.getUser(token);
      if (error || !data.user) return res.status(401).json({ error: "INVALID_SESSION" });

      const requestedId = req.body?.childProfileId;
      if (requestedId !== undefined && (typeof requestedId !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requestedId))) return res.status(400).json({ error: "INVALID_PROFILE_ID" });
      const childProfile = await avatarProfileForAuthUser(getPool(), data.user.id, requestedId);
      if (!childProfile) return res.status(403).json({ error: "CHILD_ACCESS_REQUIRED" });

      const decoded = decodeAvatarDataUrl(String(req.body?.dataUrl ?? ""));
      const { buffer, mime, extension } = await compressAvatar(decoded.buffer);
      const { key, url } = await storagePut(
        `play-routine/avatars/${childProfile.family_id}/${childProfile.child_profile_id}.${extension}`,
        buffer,
        mime,
      );

      const updated = await getPool().query<{
        id: string;
        family_id: string;
        display_name: string;
        status: string;
        avatar_url: string;
        avatar_updated_at: string;
      }>(
        `update public.child_profiles
            set avatar_storage_key = $2,
                avatar_url = $3,
                avatar_updated_at = now(),
                updated_at = now()
          where id = $1
          returning id, family_id, display_name, status, avatar_url, avatar_updated_at`,
        [childProfile.child_profile_id, key, url],
      );

      return res.json({ profile: updated.rows[0] });
    } catch (error) {
      const message = error instanceof Error ? error.message : "AVATAR_UPLOAD_FAILED";
      if (["INVALID_AVATAR_FORMAT", "INVALID_AVATAR_SIZE", "INVALID_AVATAR_SIGNATURE", "INVALID_AVATAR_IMAGE"].includes(message)) {
        return res.status(400).json({ error: message });
      }
      console.error("[Avatar Upload] failed");
      return res.status(500).json({ error: "AVATAR_UPLOAD_FAILED" });
    }
  });
}
