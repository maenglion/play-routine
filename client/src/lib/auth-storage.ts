export const REMEMBER_ME_KEY = "play-routine:remember-me";

export type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "key" | "length">;

function isSupabaseAuthKey(key: string | null): key is string {
  return Boolean(key?.startsWith("sb-") && key.endsWith("-auth-token"));
}

function authKeys(storage: StorageLike) {
  const keys: string[] = [];
  for (let index = 0; index < storage.length; index += 1) {
    const key = storage.key(index);
    if (isSupabaseAuthKey(key)) keys.push(key);
  }
  return keys;
}

export function getRememberMePreference(localStore: StorageLike) {
  return localStore.getItem(REMEMBER_ME_KEY) !== "false";
}

export function setRememberMePreference(
  enabled: boolean,
  localStore: StorageLike,
  sessionStore: StorageLike,
) {
  localStore.setItem(REMEMBER_ME_KEY, enabled ? "true" : "false");

  const target = enabled ? localStore : sessionStore;
  const source = enabled ? sessionStore : localStore;
  const keys = new Set([...authKeys(localStore), ...authKeys(sessionStore)]);

  for (const key of Array.from(keys)) {
    const value = source.getItem(key) ?? target.getItem(key);
    if (value !== null) target.setItem(key, value);
    source.removeItem(key);
  }
}

export function createRememberMeStorage(localStore: StorageLike, sessionStore: StorageLike) {
  const activeStorage = () =>
    getRememberMePreference(localStore) ? localStore : sessionStore;
  const inactiveStorage = () =>
    getRememberMePreference(localStore) ? sessionStore : localStore;

  return {
    getItem(key: string) {
      return activeStorage().getItem(key);
    },
    setItem(key: string, value: string) {
      activeStorage().setItem(key, value);
      inactiveStorage().removeItem(key);
    },
    removeItem(key: string) {
      localStore.removeItem(key);
      sessionStore.removeItem(key);
    },
  };
}
