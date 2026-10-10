import { createClient } from "@supabase/supabase-js";
import { createRememberMeStorage } from "./auth-storage";
import { inspectAuthCallback } from "./auth-callback";

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
const supabasePublishableKey = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;

if (!supabaseUrl || !supabasePublishableKey) {
  throw new Error("Supabase client configuration is missing");
}

// SDK가 URL fragment를 지우기 전에 오류·콜백 여부만 보존한다. 토큰은 저장하지 않는다.
export const initialAuthCallback = inspectAuthCallback(
  typeof window === "undefined" ? "http://localhost/" : window.location.href,
);

export const supabase = createClient(supabaseUrl, supabasePublishableKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
    flowType: "implicit",
    storage:
      typeof window === "undefined"
        ? undefined
        : createRememberMeStorage(window.localStorage, window.sessionStorage),
  },
});
