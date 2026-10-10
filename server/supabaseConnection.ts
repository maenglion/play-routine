// URI와 비밀번호를 분리해 입력해도 특수문자를 안전하게 인코딩한다.
export function getSupabaseConnectionString() {
  const connectionString = process.env.SUPABASE_DATABASE_URL;
  if (!connectionString) throw new Error("SUPABASE_DATABASE_URL is not configured");
  const password = process.env.SUPABASE_DATABASE_PASSWORD;
  if (!password) return connectionString;
  const url = new URL(connectionString);
  url.password = encodeURIComponent(password);
  return url.toString();
}
