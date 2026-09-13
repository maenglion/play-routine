import { trpc } from "@/lib/trpc";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { httpBatchLink } from "@trpc/client";
import { createRoot } from "react-dom/client";
import superjson from "superjson";
import App from "./App";
import "./index.css";

const queryClient = new QueryClient();

queryClient.getQueryCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.query.state.error;
    console.error("[API Query Error]", error);
  }
});

queryClient.getMutationCache().subscribe(event => {
  if (event.type === "updated" && event.action.type === "error") {
    const error = event.mutation.state.error;
    console.error("[API Mutation Error]", error);
  }
});

const trpcClient = trpc.createClient({
  links: [
    httpBatchLink({
      url: "/api/trpc",
      transformer: superjson,
      fetch(input, init) {
        return globalThis.fetch(input, {
          ...(init ?? {}),
          credentials: "include",
        });
      },
    }),
  ],
});

function hideHostedPlatformBadge() {
  let shadowObserver: MutationObserver | null = null;

  const hideBadge = () => {
    const host = document.querySelector("manus-content-root");
    const shadowRoot = host?.shadowRoot;
    if (!shadowRoot) return;

    const badge = shadowRoot.querySelector("footer-watermark") as HTMLElement | null;
    if (badge) {
      badge.hidden = true;
      badge.style.setProperty("display", "none", "important");
    }

    if (!shadowObserver) {
      shadowObserver = new MutationObserver(hideBadge);
      shadowObserver.observe(shadowRoot, { childList: true, subtree: true });
    }
  };

  const documentObserver = new MutationObserver(hideBadge);
  documentObserver.observe(document.documentElement, { childList: true, subtree: true });
  hideBadge();
}

hideHostedPlatformBadge();

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
