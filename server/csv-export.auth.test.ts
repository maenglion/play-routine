import express from "express";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { csvCell, registerExportRoutes, toCsv } from "./routes/exports";

let closeServer: (() => Promise<void>) | null = null;

afterEach(async () => {
  await closeServer?.();
  closeServer = null;
});

describe("parent CSV export authorization", () => {
  it("neutralizes spreadsheet formula prefixes and escapes quotes", () => {
    expect(csvCell("=HYPERLINK(\"https://bad.example\")")).toBe(
      `"'=HYPERLINK(""https://bad.example"")"`,
    );
    expect(toCsv([{ name: "+SUM(1,2)", note: "safe" }])).toContain(
      `"'+SUM(1,2)"`,
    );
  });

  it("rejects a request without a Supabase bearer token", async () => {
    const app = express();
    registerExportRoutes(app);

    const server = app.listen(0, "127.0.0.1");
    await new Promise<void>(resolve => server.once("listening", resolve));
    closeServer = () => new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });

    const { port } = server.address() as AddressInfo;
    const response = await fetch(
      `http://127.0.0.1:${port}/api/exports/family.csv?dataset=children`,
    );

    expect(response.status).toBe(401);
    await expect(response.json()).resolves.toEqual({ error: "AUTH_REQUIRED" });
  });
});
