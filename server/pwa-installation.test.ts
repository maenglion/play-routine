import { readFile } from "node:fs/promises";
import path from "node:path";
import { runInNewContext } from "node:vm";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { initialLoginModeFromSearch, initialLoginSelectionFromSearch } from "../client/src/lib/login-role-preference";

const projectRoot = path.resolve(import.meta.dirname, "..");
const fromProjectRoot = (...parts: string[]) => path.join(projectRoot, ...parts);

async function readProjectFile(...parts: string[]) {
  return readFile(fromProjectRoot(...parts), "utf8");
}

type FetchListener = (event: {
  request: { mode: string; url: string };
  respondWith: (response: Promise<Response>) => void;
}) => void;

async function loadServiceWorkerForTest() {
  const listeners = new Map<string, FetchListener>();
  const context: {
    self: {
      addEventListener: (type: string, listener: FetchListener) => void;
      skipWaiting: () => Promise<void>;
      clients: { claim: () => Promise<void> };
    };
    URL: typeof URL;
    Response: typeof Response;
    fetch: (request: unknown) => Promise<Response>;
  } = {
    self: {
      addEventListener: (type, listener) => listeners.set(type, listener),
      skipWaiting: async () => undefined,
      clients: { claim: async () => undefined },
    },
    URL,
    Response,
    fetch: async () => new Response("network"),
  };

  runInNewContext(await readProjectFile("client", "public", "sw.js"), context);
  return {
    fetchListener: listeners.get("fetch"),
    setFetch: (nextFetch: (request: unknown) => Promise<Response>) => { context.fetch = nextFetch; },
  };
}

describe("PWA installation", () => {
  it("provides a standalone child-start manifest with the required PNG icon sizes", async () => {
    const manifest = JSON.parse(await readProjectFile("client", "public", "manifest.webmanifest")) as {
      name: string;
      short_name: string;
      start_url: string;
      scope: string;
      display: string;
      icons: Array<{ src: string; sizes: string; type: string }>;
    };

    expect(manifest).toMatchObject({
      name: "Play Routine",
      short_name: "Play Routine",
      start_url: "/?role=child",
      scope: "/",
      display: "standalone",
    });
    expect(manifest.icons).toEqual(
      expect.arrayContaining([
        { src: "/icons/play-routine-192.png", sizes: "192x192", type: "image/png" },
        { src: "/icons/play-routine-512.png", sizes: "512x512", type: "image/png" },
      ]),
    );

    for (const size of [192, 512, 170, 180]) {
      const file = size < 192
        ? `apple-touch-icon-${size}x${size}.png`
        : `play-routine-${size}.png`;
      const metadata = await sharp(fromProjectRoot("client", "public", "icons", file)).metadata();
      expect(metadata).toMatchObject({ format: "png", width: size, height: size });
    }
  });

  it("links the manifest and both Apple touch icon sizes in the application HTML", async () => {
    const html = await readProjectFile("client", "index.html");
    expect(html).toContain('rel="manifest" href="/manifest.webmanifest"');
    expect(html).toContain('rel="apple-touch-icon" sizes="170x170" href="/icons/apple-touch-icon-170x170.png"');
    expect(html).toContain('rel="apple-touch-icon" sizes="180x180" href="/icons/apple-touch-icon-180x180.png"');
  });

  it("lets role=child preselect only the login UI, never grant a role", async () => {
    expect(initialLoginModeFromSearch("?role=child")).toBe("child");
    expect(initialLoginModeFromSearch("?role=parent")).toBe("parent");
    expect(initialLoginModeFromSearch("?role=guardian")).toBe("parent");
    expect(initialLoginModeFromSearch("?role=admin")).toBe("parent");
    expect(initialLoginSelectionFromSearch("?role=child")).toEqual({ mode: "child", authMode: "login" });
    expect(initialLoginSelectionFromSearch("?role=parent")).toEqual({ mode: "parent", authMode: "login" });

    const home = await readProjectFile("client", "src", "pages", "Home.tsx");
    expect(home).toContain("activeSession.user.user_metadata?.account_type");
    expect(home).toContain('.from("family_memberships")');
    expect(home).toContain('import.meta.env.DEV\n    ? new URLSearchParams(window.location.search).get("preview")');
  });

  it("registers only a production secure-context worker and never stores or intercepts user/API data", async () => {
    const main = await readProjectFile("client", "src", "main.tsx");
    expect(main).toContain("import.meta.env.PROD");
    expect(main).toContain("window.isSecureContext");
    expect(main).toContain('navigator.serviceWorker.register("/sw.js", { scope: "/" })');
    expect(main).toContain('window.addEventListener("load"');

    const worker = await readProjectFile("client", "public", "sw.js");
    expect(worker).toContain('event.request.mode !== "navigate"');
    expect(worker).toContain('requestUrl.pathname.startsWith("/api/")');
    expect(worker).toContain('fetch(event.request)');
    expect(worker).toContain("인터넷 연결을 확인해 주세요");
    expect(worker).not.toMatch(/\b(?:CacheStorage|indexedDB|localStorage|sessionStorage|backgroundsync|notification|push|supabase)\b/i);
    expect(worker).not.toContain("caches.");
  });

  it("leaves API requests alone, passes online navigation through, and returns only a generic 503 page offline", async () => {
    const { fetchListener, setFetch } = await loadServiceWorkerForTest();
    expect(fetchListener).toBeTypeOf("function");
    const handleFetch = fetchListener as FetchListener;

    let apiResponded = false;
    handleFetch({
      request: { mode: "navigate", url: "https://play-routine.example/api/trpc" },
      respondWith: () => { apiResponded = true; },
    });
    expect(apiResponded).toBe(false);

    const onlineResponse = new Response("online network response");
    setFetch(async () => onlineResponse);
    let onlinePromise: Promise<Response> | undefined;
    handleFetch({
      request: { mode: "navigate", url: "https://play-routine.example/?role=child" },
      respondWith: response => { onlinePromise = response; },
    });
    expect(await onlinePromise).toBe(onlineResponse);

    setFetch(async () => Promise.reject(new Error("offline")));
    let offlinePromise: Promise<Response> | undefined;
    handleFetch({
      request: { mode: "navigate", url: "https://play-routine.example/" },
      respondWith: response => { offlinePromise = response; },
    });
    const offlineResponse = await offlinePromise;
    expect(offlineResponse.status).toBe(503);
    await expect(offlineResponse.text()).resolves.toContain("인터넷 연결을 확인해 주세요");
  });
});
