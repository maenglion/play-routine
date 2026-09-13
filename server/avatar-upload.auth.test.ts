import express from "express";
import { createServer } from "http";
import { afterEach, describe, expect, it } from "vitest";
import { decodeAvatarDataUrl, registerAvatarRoutes } from "./routes/avatars";

let server: ReturnType<typeof createServer> | null = null;

afterEach(async () => {
  if (server) await new Promise<void>(resolve => server!.close(() => resolve()));
  server = null;
});

describe("avatar upload", () => {
  it("rejects a request without a Supabase bearer token", async () => {
    const app = express();
    app.use(express.json());
    registerAvatarRoutes(app);
    server = createServer(app);
    await new Promise<void>(resolve => server!.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("server failed to bind");

    const response = await fetch(`http://127.0.0.1:${address.port}/api/profile/avatar`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ dataUrl: "" }),
    });

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTH_REQUIRED" });
  });

  it("rejects content whose bytes do not match the declared image type", () => {
    const invalid = `data:image/png;base64,${Buffer.from("not a png").toString("base64")}`;
    expect(() => decodeAvatarDataUrl(invalid)).toThrow("INVALID_AVATAR_SIGNATURE");
  });
});
