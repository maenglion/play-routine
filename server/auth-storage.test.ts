import { describe, expect, it } from "vitest";
import {
  REMEMBER_ME_KEY,
  createRememberMeStorage,
  getRememberMePreference,
  setRememberMePreference,
  type StorageLike,
} from "../client/src/lib/auth-storage";

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  get length() {
    return this.values.size;
  }

  getItem(key: string) {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string) {
    this.values.set(key, value);
  }

  removeItem(key: string) {
    this.values.delete(key);
  }

  key(index: number) {
    return [...this.values.keys()][index] ?? null;
  }
}

describe("Supabase remember-me storage", () => {
  it("keeps the existing persistent-login behavior by default", () => {
    const localStore = new MemoryStorage();
    const sessionStore = new MemoryStorage();
    const storage = createRememberMeStorage(localStore, sessionStore);

    expect(getRememberMePreference(localStore)).toBe(true);
    storage.setItem("sb-project-auth-token", "persistent-session");

    expect(localStore.getItem("sb-project-auth-token")).toBe("persistent-session");
    expect(sessionStore.getItem("sb-project-auth-token")).toBeNull();
  });

  it("moves the auth token to session storage when automatic login is disabled", () => {
    const localStore = new MemoryStorage();
    const sessionStore = new MemoryStorage();
    localStore.setItem("sb-project-auth-token", "existing-session");

    setRememberMePreference(false, localStore, sessionStore);
    const storage = createRememberMeStorage(localStore, sessionStore);

    expect(localStore.getItem(REMEMBER_ME_KEY)).toBe("false");
    expect(localStore.getItem("sb-project-auth-token")).toBeNull();
    expect(storage.getItem("sb-project-auth-token")).toBe("existing-session");
  });

  it("removes sign-out state from both storage scopes", () => {
    const localStore = new MemoryStorage();
    const sessionStore = new MemoryStorage();
    localStore.setItem("sb-project-auth-token", "local-session");
    sessionStore.setItem("sb-project-auth-token", "tab-session");

    createRememberMeStorage(localStore, sessionStore).removeItem("sb-project-auth-token");

    expect(localStore.getItem("sb-project-auth-token")).toBeNull();
    expect(sessionStore.getItem("sb-project-auth-token")).toBeNull();
  });
});
