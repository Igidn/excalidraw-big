import { debounce } from "@excalidraw/common";
import { serializeAsJSON } from "@excalidraw/excalidraw/data/json";
import { isInitializedImageElement } from "@excalidraw/element";

import type { ExcalidrawElement, FileId } from "@excalidraw/element/types";
import type {
  AppState,
  BinaryFileData,
  BinaryFiles,
} from "@excalidraw/excalidraw/types";

import { appJotaiStore, atom } from "../app-jotai";
import { SAVE_TO_LOCAL_STORAGE_TIMEOUT } from "../app_constants";

import { LocalData } from "./LocalData";
import { setLastActiveSceneId } from "./tabSync";

const BACKEND_URL = import.meta.env.VITE_APP_BACKEND_URL;

export const isServerPersistenceEnabled = !!BACKEND_URL;

type SceneFileMeta = {
  mimeType: string;
  id: string;
  created: number;
};

export type ServerScene = {
  id: string;
  name: string;
  type: string;
  version: number;
  source: string;
  elements: readonly ExcalidrawElement[];
  appState: Partial<AppState>;
  files: Record<string, SceneFileMeta>;
  created: number;
  updated: number;
};

export const serverSaveErrorAtom = atom<string | null>(null);

const blobToDataURL = (blob: Blob): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result);
      } else {
        reject(new Error("Failed to read blob as data URL"));
      }
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
};

const buildFileMeta = (
  elements: readonly ExcalidrawElement[],
  files: BinaryFiles,
): Record<string, SceneFileMeta> => {
  const filesMeta: Record<string, SceneFileMeta> = {};
  for (const element of elements) {
    if (
      !element.isDeleted &&
      isInitializedImageElement(element) &&
      files[element.fileId]
    ) {
      const file = files[element.fileId];
      filesMeta[element.fileId] = {
        mimeType: file.mimeType,
        id: file.id,
        created: file.created,
      };
    }
  }
  return filesMeta;
};

export class ServerPersistence {
  private static _currentSceneId: string | null = null;
  private static _lastSaveArgs: {
    elements: readonly ExcalidrawElement[];
    appState: Partial<AppState>;
    files: BinaryFiles;
    onSaved: () => void;
  } | null = null;
  private static _pendingFileSaves = new Set<Promise<void>>();

  static getBrowserId(): string {
    const BROWSER_ID_KEY = "excalidraw-browser-id";
    let browserId = localStorage.getItem(BROWSER_ID_KEY);
    if (!browserId) {
      browserId = crypto.randomUUID();
      localStorage.setItem(BROWSER_ID_KEY, browserId);
    }
    return browserId;
  }

  static getCurrentSceneId(): string | null {
    return this._currentSceneId;
  }

  static setCurrentSceneId(sceneId: string | null) {
    this._currentSceneId = sceneId;
    if (sceneId) {
      setLastActiveSceneId(sceneId);
    }
  }

  static getLastActiveSceneId(): string | null {
    return localStorage.getItem("excalidraw-last-scene");
  }

  private static _performSave = async (
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
    onSaved: () => void,
    keepalive: boolean,
  ) => {
    const sceneId = this._currentSceneId;
    if (!sceneId) {
      return;
    }

    const browserId = this.getBrowserId();
    const name = appState.name || "Untitled";

    const serialized = serializeAsJSON(elements, appState, files, "database");
    const data = JSON.parse(serialized);
    const filesMeta = buildFileMeta(elements, files);

    try {
      const response = await fetch(
        `${BACKEND_URL}/api/scenes/${encodeURIComponent(sceneId)}`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            browserId,
            name,
            elements: data.elements,
            appState: data.appState,
            files: filesMeta,
          }),
          keepalive,
        },
      );

      if (!response.ok) {
        throw new Error(`Failed to save scene: ${response.status}`);
      }

      appJotaiStore.set(serverSaveErrorAtom, null);
    } catch (error: any) {
      console.error("Server save error:", error);
      appJotaiStore.set(
        serverSaveErrorAtom,
        error.message || "Failed to save scene",
      );
    }

    onSaved();
  };

  private static _save = debounce(
    async (
      elements: readonly ExcalidrawElement[],
      appState: Partial<AppState>,
      files: BinaryFiles,
      onSaved: () => void,
    ) => {
      this._lastSaveArgs = { elements, appState, files, onSaved };
      await this._performSave(elements, appState, files, onSaved, false);
    },
    SAVE_TO_LOCAL_STORAGE_TIMEOUT,
  );

  static save = (
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
    onSaved: () => void,
  ) => {
    if (!LocalData.isSavePaused()) {
      this._save(elements, appState, files, onSaved);
    }
  };

  static flushSave = () => {
    this._save.cancel();
    if (this._lastSaveArgs) {
      const { elements, appState, files, onSaved } = this._lastSaveArgs;
      this._performSave(elements, appState, files, onSaved, true);
    }
  };

  static flushFileSaves = async () => {
    await Promise.all(this._pendingFileSaves);
  };

  static async createScene(
    elements: readonly ExcalidrawElement[],
    appState: Partial<AppState>,
    files: BinaryFiles,
  ): Promise<{ id: string; name: string; created: number; updated: number }> {
    const browserId = this.getBrowserId();
    const name = appState.name || "Untitled";

    const serialized = serializeAsJSON(elements, appState, files, "database");
    const data = JSON.parse(serialized);
    const filesMeta = buildFileMeta(elements, files);

    const response = await fetch(`${BACKEND_URL}/api/scenes`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        browserId,
        name,
        elements: data.elements,
        appState: data.appState,
        files: filesMeta,
      }),
    });

    if (!response.ok) {
      throw new Error(`Failed to create scene: ${response.status}`);
    }

    return response.json();
  }

  static async loadScene(sceneId: string): Promise<ServerScene | null> {
    const browserId = this.getBrowserId();
    const response = await fetch(
      `${BACKEND_URL}/api/scenes/${encodeURIComponent(sceneId)}?browserId=${encodeURIComponent(browserId)}`,
    );

    if (response.status === 404) {
      return null;
    }

    if (!response.ok) {
      throw new Error(`Failed to load scene: ${response.status}`);
    }

    return response.json();
  }

  static async listScenes(
    opts: { limit?: number; offset?: number } = {},
  ): Promise<{
    scenes: Array<{
      id: string;
      name: string;
      updated: number;
      created: number;
    }>;
    total: number;
    limit: number;
    offset: number;
  }> {
    const browserId = this.getBrowserId();
    const params = new URLSearchParams({ browserId });
    if (opts.limit !== undefined) {
      params.append("limit", String(opts.limit));
    }
    if (opts.offset !== undefined) {
      params.append("offset", String(opts.offset));
    }

    const response = await fetch(
      `${BACKEND_URL}/api/scenes?${params.toString()}`,
    );
    if (!response.ok) {
      throw new Error(`Failed to list scenes: ${response.status}`);
    }
    return response.json();
  }

  static async deleteScene(sceneId: string): Promise<void> {
    const browserId = this.getBrowserId();
    const response = await fetch(
      `${BACKEND_URL}/api/scenes/${encodeURIComponent(sceneId)}`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ browserId }),
      },
    );
    if (!response.ok) {
      throw new Error(`Failed to delete scene: ${response.status}`);
    }
  }

  static fileStorage = {
    getFiles: async (
      ids: FileId[],
    ): Promise<{
      loadedFiles: BinaryFileData[];
      erroredFiles: Map<FileId, true>;
    }> => {
      const sceneId = ServerPersistence._currentSceneId;
      if (!sceneId) {
        return {
          loadedFiles: [],
          erroredFiles: new Map(ids.map((id) => [id, true])),
        };
      }

      const loadedFiles: BinaryFileData[] = [];
      const erroredFiles = new Map<FileId, true>();

      await withConcurrencyLimit(ids, 5, async (id) => {
        try {
          const response = await fetch(
            `${BACKEND_URL}/api/scenes/${encodeURIComponent(sceneId)}/files/${encodeURIComponent(id)}`,
          );
          if (!response.ok) {
            erroredFiles.set(id, true);
            return;
          }

          const blob = await response.blob();
          const mimeType =
            response.headers.get("Content-Type") ||
            "application/octet-stream";
          const dataURL = await blobToDataURL(blob);

          loadedFiles.push({
            id,
            mimeType: mimeType as BinaryFileData["mimeType"],
            dataURL: dataURL as BinaryFileData["dataURL"],
            created: Date.now(),
            lastRetrieved: Date.now(),
          });
        } catch (error) {
          console.error(`Failed to load file ${id}:`, error);
          erroredFiles.set(id, true);
        }
      });

      return { loadedFiles, erroredFiles };
    },

    saveFiles: async ({
      addedFiles,
    }: {
      addedFiles: Map<FileId, BinaryFileData>;
    }): Promise<{
      savedFiles: Map<FileId, BinaryFileData>;
      erroredFiles: Map<FileId, BinaryFileData>;
    }> => {
      const sceneId = ServerPersistence._currentSceneId;
      if (!sceneId) {
        return {
          savedFiles: new Map(),
          erroredFiles: new Map(addedFiles),
        };
      }

      const savedFiles = new Map<FileId, BinaryFileData>();
      const erroredFiles = new Map<FileId, BinaryFileData>();

      await withConcurrencyLimit([...addedFiles], 5, async ([id, fileData]) => {
        const savePromise = (async () => {
          try {
            const blob = await fetch(fileData.dataURL).then((r) => r.blob());

            const formData = new FormData();
            formData.append("file", blob);
            formData.append("fileId", id);
            formData.append("mimeType", fileData.mimeType);
            formData.append("created", String(fileData.created));

            const response = await fetch(
              `${BACKEND_URL}/api/scenes/${encodeURIComponent(sceneId)}/files`,
              {
                method: "POST",
                body: formData,
              },
            );

            if (!response.ok) {
              erroredFiles.set(id, fileData);
              return;
            }

            savedFiles.set(id, fileData);
          } catch (error) {
            console.error(`Failed to save file ${id}:`, error);
            erroredFiles.set(id, fileData);
          }
        })();

        ServerPersistence._pendingFileSaves.add(savePromise);
        await savePromise;
        ServerPersistence._pendingFileSaves.delete(savePromise);
      });

      return { savedFiles, erroredFiles };
    },
  };
}

const withConcurrencyLimit = async <T,>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
) => {
  const queue = [...items];
  const executeNext = async () => {
    const item = queue.shift();
    if (!item) {
      return;
    }
    await fn(item);
    await executeNext();
  };
  await Promise.all(Array.from({ length: limit }, () => executeNext()));
};
