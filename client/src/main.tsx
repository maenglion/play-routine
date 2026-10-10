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
  const observedRoots = new WeakSet<Node>();

  const scanRoot = (root: Document | ShadowRoot) => {
    root.querySelectorAll("footer-watermark").forEach(element => {
      const badge = element as HTMLElement;
      badge.hidden = true;
      badge.style.setProperty("display", "none", "important");
      badge.setAttribute("aria-hidden", "true");
    });

    root.querySelectorAll("*").forEach(element => {
      if (element.shadowRoot) scanRoot(element.shadowRoot);
    });

    if (!observedRoots.has(root)) {
      observedRoots.add(root);
      const observer = new MutationObserver(() => scanRoot(root));
      observer.observe(root, { childList: true, subtree: true });
    }
  };

  scanRoot(document);
}

hideHostedPlatformBadge();

createRoot(document.getElementById("root")!).render(
  <trpc.Provider client={trpcClient} queryClient={queryClient}>
    <QueryClientProvider client={queryClient}>
      <App />
    </QueryClientProvider>
  </trpc.Provider>
);
