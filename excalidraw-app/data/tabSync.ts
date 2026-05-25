import { STORAGE_KEYS } from "../app_constants";

const LAST_ACTIVE_SCENE_KEY = "excalidraw-last-scene";
const LAST_ACTIVE_SCENE_TS_KEY = "excalidraw-last-scene-ts";

// in-memory state (this tab's current state) versions. Currently just
// timestamps of the last time the state was saved to browser storage.
const LOCAL_STATE_VERSIONS = {
  [STORAGE_KEYS.VERSION_DATA_STATE]: -1,
  [STORAGE_KEYS.VERSION_FILES]: -1,
};

let localLastSceneTimestamp = -1;

type BrowserStateTypes = keyof typeof LOCAL_STATE_VERSIONS;

export const isBrowserStorageStateNewer = (type: BrowserStateTypes) => {
  const storageTimestamp = JSON.parse(localStorage.getItem(type) || "-1");
  return storageTimestamp > LOCAL_STATE_VERSIONS[type];
};

export const updateBrowserStateVersion = (type: BrowserStateTypes) => {
  const timestamp = Date.now();
  try {
    localStorage.setItem(type, JSON.stringify(timestamp));
    LOCAL_STATE_VERSIONS[type] = timestamp;
  } catch (error) {
    console.error("error while updating browser state verison", error);
  }
};

export const resetBrowserStateVersions = () => {
  try {
    for (const key of Object.keys(
      LOCAL_STATE_VERSIONS,
    ) as BrowserStateTypes[]) {
      const timestamp = -1;
      localStorage.setItem(key, JSON.stringify(timestamp));
      LOCAL_STATE_VERSIONS[key] = timestamp;
    }
  } catch (error) {
    console.error("error while resetting browser state verison", error);
  }
};

// Minimal last-active-scene sync for server persistence
export const getLastActiveSceneId = (): string | null => {
  return localStorage.getItem(LAST_ACTIVE_SCENE_KEY);
};

export const setLastActiveSceneId = (sceneId: string) => {
  const timestamp = Date.now();
  localStorage.setItem(LAST_ACTIVE_SCENE_KEY, sceneId);
  localStorage.setItem(LAST_ACTIVE_SCENE_TS_KEY, String(timestamp));
  localLastSceneTimestamp = timestamp;
};

export const isLastActiveSceneNewer = (currentSceneId: string | null) => {
  const lastSceneId = getLastActiveSceneId();
  const lastSceneTs = Number(
    localStorage.getItem(LAST_ACTIVE_SCENE_TS_KEY) || "0",
  );
  return (
    lastSceneId &&
    lastSceneId !== currentSceneId &&
    lastSceneTs > localLastSceneTimestamp
  );
};
