# Excalidraw Server-Side Persistence Plan

## Overview

This document outlines the plan to migrate Excalidraw from browser-only storage (localStorage + IndexedDB) to a self-hosted server-side persistence model. The goal is to provide users with effectively infinite whiteboard storage by offloading data to a lightweight backend API, while keeping the implementation minimal and avoiding unnecessary complexity (no auth, no offline support, no multiplayer for now).

## Goals

1. Remove the browser storage size limit (~5-10 MB for localStorage, browser-dependent for IndexedDB)
2. Provide persistent, server-side storage for whiteboard scenes and associated image blobs
3. Keep the implementation simple and self-contained
4. Use anonymous/auto-generated browser IDs for user identification
5. Ensure minimal changes to the existing Excalidraw architecture

## Non-Goals (For Now)

1. **Authentication**: No user accounts, login, or signup. Identification is via auto-generated browser IDs.
2. **Multiplayer/Real-time Collaboration**: No concurrent editing or WebSocket sync. Single-user persistence only.
3. **Offline Support**: No service workers or offline queues. If the server is unreachable, the user sees a clear error.
4. **CRDTs / Conflict Resolution**: No complex operational transforms. Last-write-wins for scene updates.
5. **Library/TTD server persistence**: Library items (`LibraryIndexedDBAdapter`) and TTD chat history (`TTDIndexedDBAdapter`) remain in IndexedDB. These are not bounded by the same storage pressure as scene+image data, and moving them adds complexity without solving the primary "infinite canvas" problem.

## Current Architecture

| Data | Current Storage | Size Concern | Move to Server? |
|------|-----------------|--------------|-----------------|
| **Elements** (shapes, text, lines) | `localStorage` (~5-10 MB limit) | **High** | Yes |
| **AppState** (zoom, scroll, settings) | `localStorage` | Low | Yes (piggybacks on scene) |
| **Images/Files** | `IndexedDB` (~50 MB–2 GB, browser-dependent) | **Highest** | Yes |
| **Libraries** | `IndexedDB` | Medium | No (out of scope) |
| **TTD Chats** | `IndexedDB` | Low | No (out of scope) |
| **Collaboration Rooms** | Firebase Firestore + Firebase Storage | Server-side | N/A (already server-side) |
| **Theme preference** | `localStorage` (key: `excalidraw-theme`) | Tiny | No (stays local) |
| **Collab username** | `localStorage` (key: `excalidraw-collab`) | Tiny | No (stays local) |

### Key Architectural Insight

The core library (`packages/excalidraw/`) handles serialization and deserialization but **does not touch browser storage**. The app layer (`excalidraw-app/`) owns all storage logic via:

| File | Role |
|------|------|
| `LocalData.ts` | Orchestrates saves to localStorage (elements/appState) and IndexedDB (files) via debounced saves |
| `FileManager.ts` | **Plugable** file tracking/upload/download with `getFiles`/`saveFiles` callbacks injected at construction |
| `localStorage.ts` | Raw localStorage read/write helpers for elements, appState, collab username |
| `tabSync.ts` | Cross-tab version tracking via localStorage timestamps (`VERSION_DATA_STATE`, `VERSION_FILES`) |
| `firebase.ts` | Firebase-specific file upload/download for collaboration/share links |

### Critical Design Detail: `FileManager` is Already Pluggable

`FileManager` (`excalidraw-app/data/FileManager.ts:45-65`) accepts `getFiles` and `saveFiles` callbacks in its constructor. `LocalData.ts:169-227` demonstrates this by passing IndexedDB-backed implementations. **This means we do NOT need to modify `FileManager.ts` at all.** We create a server-backed implementation of the same interface and pass it to a `FileManager` instance — the same pattern `LocalData` already uses.

### Serialization: `serializeAsJSON` Modes

The core library exposes `serializeAsJSON()` (`packages/excalidraw/data/json.ts:52-75`) with two modes:

| Mode | Files | AppState fields preserved |
|------|-------|--------------------------|
| `"local"` | Included in JSON (`filterOutDeletedFiles`) | `viewBackgroundColor`, `scrollX`, `scrollY`, `zoom`, `activeTool`, `theme`, `name`, and many more (the "browser" export type in `APP_STATE_STORAGE_CONF`) |
| `"database"` | Stripped (`undefined`) | Only `gridSize`, `gridStep`, `gridModeEnabled`, `viewBackgroundColor`, `lockedMultiSelections` (the "server" export type) |

We will use `"database"` mode. It strips file blobs (which we upload separately via the dedicated file endpoints), and strips UI-local state (scroll position, theme, etc.) that doesn't need server persistence. The few fields it preserves — `viewBackgroundColor`, `gridSize`, `gridModeEnabled` — are the document-level settings that should carry between sessions.

### Scene Type Compatibility

`serializeAsJSON` returns a `string` (JSON.stringify output). The API will send/receive structured `ExportedDataState` objects. The client will:
- **On save**: Call `serializeAsJSON(elements, appState, files, "database")` → `JSON.parse()` the result to get a plain object → add scene-level metadata (`id`, `name`, `created`, `updated`) → send as JSON body.
- **On load**: Receive the JSON object → feed `elements` and `appState` to `restoreElements()` / `restoreAppState()` → fetch file blobs separately → reconstruct the `BinaryFiles` map.

## Proposed Architecture

### Option Chosen: **Server-Backed with Minimal Local Cache**

We will replace `localStorage` and `IndexedDB` as the primary persistence layer with a lightweight HTTP backend. The browser will still use a tiny local cache in `localStorage` for:
- The `browserId` (anonymous user identity)
- The last active scene ID
- Non-scene preferences (theme, collab username — these already live in separate localStorage keys and remain untouched)

The actual whiteboard data lives on the server.

**Why this option?**
- It is the simplest to implement given our constraints (no offline, no auth, no multiplayer)
- It directly solves the infinite storage problem
- It requires minimal changes to the existing codebase
- It can be evolved later to support auth and collaboration

### System Components

```
┌──────────────────────────────────────────────────────┐
│                   Browser (Client)                     │
│  ┌────────────────────────────────────────────────┐   │
│  │           excalidraw-app/                     │   │
│  │  ┌──────────────┐  ┌──────────────────────┐   │   │
│  │  │   UI Layer   │  │  ServerPersistence   │   │   │
│  │  │ (React comps)│  │  (replaces LocalData) │   │   │
│  │  └──────┬───────┘  └──────────┬───────────┘   │   │
│  │         │                     │               │   │
│  │         │              ┌──────▼──────────┐    │   │
│  │         │              │  FileManager     │    │   │
│  │         │              │ (unchanged!)     │    │   │
│  │         │              │ plugin callbacks: │    │   │
│  │         │              │ getFiles ────────│────│──> ServerPersistence.fileStorage.getFiles
│  │         │              │ saveFiles ───────│────│──> ServerPersistence.fileStorage.saveFiles
│  │         │              └──────────────────┘    │   │
│  │  ┌──────▼─────────────────────────────────┐    │   │
│  │  │     packages/excalidraw/               │    │   │
│  │  │  (serializeAsJSON, restore, etc.)      │    │   │
│  │  └────────────────────────────────────────┘    │   │
│  └────────────────────────────────────────────────┘   │
│                        │                             │
│                   HTTP / Fetch                       │
│                        │                             │
└────────────────────────┼─────────────────────────────┘
                          │
┌────────────────────────▼─────────────────────────────┐
│              Self-Hosted Backend                      │
│  ┌────────────────────────────────────────────────┐  │
│  │   REST API (Node.js / Go / Python / etc.)      │  │
│  │  - GET    /api/scenes?browserId=...&limit=...&offset=... │
│  │  - POST   /api/scenes                          │  │
│  │  - GET    /api/scenes/:id?browserId=...        │  │
│  │  - PUT    /api/scenes/:id                      │  │
│  │  - DELETE /api/scenes/:id                      │  │
│  │  - POST   /api/scenes/:id/files                │  │
│  │  - GET    /api/scenes/:id/files/:fileId        │  │
│  │  - DELETE /api/scenes/:id/files/:fileId        │  │
│  └────────────────────────────────────────────────┘  │
│                        │                             │
│  ┌─────────────────────▼────────────────────────┐    │
│  │           Data Storage Layer                │    │
│  │  ┌─────────────┐  ┌─────────────────────┐  │    │
│  │  │  PostgreSQL │  │  Filesystem / S3    │  │    │
│  │  │  (scenes)   │  │  (image blobs)      │  │    │
│  │  └─────────────┘  └─────────────────────┘  │    │
│  └────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────┘
```

## Data Model

### Scene

Stored on the server as a JSON object using Excalidraw's `ExportedDataState` format with `"database"` mode serialization plus server-managed metadata.

```json
{
  "id": "scene-uuid-v4",
  "name": "My Whiteboard",
  "browserId": "user-browser-uuid",
  "type": "excalidraw",
  "version": 2,
  "source": "excalidraw-self-hosted",
  "elements": [
    { "id": "elem-1", "type": "rectangle", "x": 100, "y": 200, ... },
    ...
  ],
  "appState": {
    "viewBackgroundColor": "#ffffff",
    "gridSize": null,
    "gridStep": 20,
    "gridModeEnabled": false,
    "lockedMultiSelections": {}
  },
  "files": {
    "file-id-1": { "mimeType": "image/png", "id": "file-id-1", "created": 1234567890 }
  },
  "created": 1234567890,
  "updated": 1234567890
}
```

**Key design decisions:**

1. **`files` contains metadata only** — `mimeType`, `id`, `created`. The `dataURL` blob is stored separately via the dedicated file endpoints. On load, the client fetches each file blob individually and reconstructs the `BinaryFiles` map expected by `excalidrawAPI.addFiles()`.

2. **`appState` is stripped to server-safe fields only** — `serializeAsJSON` with `"database"` mode preserves: `gridSize`, `gridStep`, `gridModeEnabled`, `viewBackgroundColor`, `lockedMultiSelections`. All other appState fields (scroll, zoom, active tool, theme, etc.) are transient UI state that don't need server persistence. The `AppState` type's `"server"` storage configuration in `packages/excalidraw/appState.ts:138-257` defines this.

3. **`name` field** — A human-readable name for the scene, derived from `appState.name` at save time. Used in the scene list. Defaults to `"Untitled"`.

### User (Anonymous)

```json
{
  "browserId": "auto-generated-uuid-v4",
  "lastActiveScene": "scene-id-1",
  "created": 1234567890
}
```

The `browserId` is generated once via `crypto.randomUUID()` and persisted in `localStorage` under the key `excalidraw-browser-id`. **It must be `localStorage`, not `sessionStorage`** — sessionStorage is cleared when the tab closes, which would permanently orphan the user's scenes. The "clearing browser data = losing access" tradeoff is acceptable for MVP and documented in the risks.

### Binary File Data Reconstruction

When loading a scene, the client must reconstruct the `BinaryFiles` map from two sources:

```
Server Scene JSON (.files)          Server File Endpoint
┌─────────────────────┐            ┌──────────────────────┐
│ "file-id-1": {      │            │ GET /api/scenes/s1/   │
│   mimeType: "..."   │  fetch ───>│   files/file-id-1     │
│   id: "file-id-1"   │            │ => binary blob with   │
│   created: 12345    │            │    Content-Type header │
│ }                   │            └──────────────────────┘
└─────────────────────┘                     │
        │                                   ▼
        │              combine ──> BinaryFiles = {
        │                           "file-id-1": {
        │                             mimeType: "image/png",
        │                             id: "file-id-1",
        │                             dataURL: "data:image/png;base64,...",
        │                             created: 1234567890
        │                           }
        │                         }
        ▼
  excalidrawAPI.addFiles(binaryFiles)
```

## API Specification

### Base URL

Configured via environment variable:

```bash
VITE_APP_BACKEND_URL=http://localhost:3001
```

### Endpoints

#### 1. List User Scenes

```
GET /api/scenes?browserId={uuid}&limit=50&offset=0
```

**Query Parameters:**
| Param | Type | Required | Default | Description |
|-------|------|----------|---------|-------------|
| `browserId` | UUID string | Yes | — | Anonymous user identifier |
| `limit` | integer | No | 50 | Max scenes per page |
| `offset` | integer | No | 0 | Pagination offset |
| `sort` | string | No | `updated` | Sort by `updated` or `created` |
| `order` | string | No | `desc` | `asc` or `desc` |

**Response:**
```json
{
  "scenes": [
    { "id": "scene-1", "name": "Project A", "updated": 1234567890, "created": 1234567890 },
    { "id": "scene-2", "name": "Untitled",   "updated": 1234567891, "created": 1234567890 }
  ],
  "total": 42,
  "limit": 50,
  "offset": 0
}
```

> Pagination is included from the start. Without it, a power user with 100+ scenes would have slow page loads and unnecessary bandwidth usage.

#### 2. Create Scene

```
POST /api/scenes
```

**Request Body:**
```json
{
  "browserId": "uuid-from-browser",
  "name": "My Whiteboard",
  "elements": [],
  "appState": {},
  "files": {}
}
```

**Response** (201 Created):
```json
{
  "id": "scene-uuid",
  "name": "My Whiteboard",
  "created": 1234567890,
  "updated": 1234567890
}
```

**Notes:**
- The server generates `id`, `created`, `updated`, and validates `browserId`.
- `type`, `version`, and `source` are set by the server (not sent by the client) to ensure consistency.
- An empty scene (no elements) is valid — this is the new board flow.

#### 3. Get Scene

```
GET /api/scenes/:id?browserId={uuid}
```

**Response** (200):
```json
{
  "id": "scene-uuid",
  "name": "My Whiteboard",
  "type": "excalidraw",
  "version": 2,
  "source": "excalidraw-self-hosted",
  "elements": [...],
  "appState": { "viewBackgroundColor": "#ffffff", ... },
  "files": {
    "file-id-1": { "mimeType": "image/png", "id": "file-id-1", "created": 1234567890 }
  },
  "created": 1234567890,
  "updated": 1234567890
}
```

**Notes:**
- `files` contains metadata only (no `dataURL`). The client fetches blobs separately.
- `browserId` is required to associate the request with the user (the server uses this for access control — a scene belongs to the `browserId` that created it).

#### 4. Update Scene

```
PUT /api/scenes/:id
```

**Request Body:**
```json
{
  "browserId": "uuid-from-browser",
  "name": "My Whiteboard (updated)",
  "elements": [...],
  "appState": { "viewBackgroundColor": "#ff0000", ... },
  "files": {
    "file-id-1": { "mimeType": "image/png", "id": "file-id-1", "created": 1234567890 },
    "file-id-2": { "mimeType": "image/jpeg", "id": "file-id-2", "created": 1234567900 }
  }
}
```

**Response** (200):
```json
{
  "id": "scene-uuid",
  "name": "My Whiteboard (updated)",
  "updated": 1234567899
}
```

**Notes:**
- The `files` map in the request body is metadata-only (file IDs, mimeTypes, timestamps). File blobs are uploaded via the dedicated file endpoints.
- If a file ID appears in the `files` map but no corresponding upload has been received, the server treats it as a pending reference and returns a placeholder on GET (or a 404 on GET `/files/:fileId`). The client should upload files before or concurrently with the scene update.
- If a file ID is **removed** from the `files` map (e.g., the user deleted an image element), the server may garbage-collect the orphaned file blob.

#### 5. Delete Scene

```
DELETE /api/scenes/:id
```

**Request Body:**
```json
{
  "browserId": "uuid-from-browser"
}
```

**Response** (200):
```json
{
  "deleted": true
}
```

**Notes:**
- The server must delete all associated file blobs from the filesystem/S3.
- `browserId` prevents users from deleting other users' scenes.

#### 6. Upload File

```
POST /api/scenes/:id/files
```

**Request:** `multipart/form-data`

| Field | Type | Description |
|-------|------|-------------|
| `file` | binary | The image blob |
| `fileId` | string | The Excalidraw `FileId` (UUID) |
| `mimeType` | string | `image/png`, `image/jpeg`, etc. |
| `created` | integer | Unix timestamp (ms) |

**Response** (201):
```json
{
  "fileId": "file-uuid",
  "mimeType": "image/png",
  "created": 1234567890,
  "size": 245760
}
```

#### 7. Get File

```
GET /api/scenes/:id/files/:fileId
```

**Response:** Binary image data with appropriate `Content-Type` header (e.g., `image/png`), plus:
- `Cache-Control: public, max-age=31536000, immutable` (1 year — file content is immutable since Excalidraw never modifies images in-place)

#### 8. Delete File

```
DELETE /api/scenes/:id/files/:fileId
```

**Request Body:**
```json
{
  "browserId": "uuid-from-browser"
}
```

Used for garbage collection when an image is removed from the scene.

## URL Routing

The app currently uses two URL patterns:

| Pattern | Purpose | Persists After Migration? |
|---------|---------|---------------------------|
| `#room={roomId},{roomKey}` | Collaboration links | Yes (unchanged) |
| `?scene={sceneId}` | **New** — server-persisted scene navigation | **New** |

**Routing priority**: `#room=` takes precedence over `?scene=`. If both are present, the app enters collaboration mode. If only `?scene=` is present, the app loads the specified scene from the server. If neither is present, the app loads the last active scene (from localStorage) or creates a new one.

The `?scene=` parameter uses query string (not hash) because:
1. It allows server-side rendering of meta tags (og:title, og:image) for sharing — a future enhancement
2. It doesn't conflict with the existing `#room=` hash pattern

## Implementation Plan

### Phase 1: Backend Setup (Outside this repo)

Create a minimal standalone REST API service.

**Suggested Stack:**
- **Runtime**: Node.js + Express (or Fastify)
- **Database**: PostgreSQL (scenes table with JSONB column + metadata columns) OR SQLite (zero-config local dev)
- **File Storage**: Local filesystem (`./data/files/`) for dev, S3-compatible (MinIO) for production
- **CORS**: Must allow requests from the Excalidraw frontend origin

**Database schema (PostgreSQL):**
```sql
CREATE TABLE scenes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  browser_id  UUID NOT NULL,
  name        TEXT NOT NULL DEFAULT 'Untitled',
  data        JSONB NOT NULL,          -- elements + appState (serializeAsJSON "database" mode output, minus server-managed fields)
  file_ids    UUID[] NOT NULL DEFAULT '{}',  -- list of file IDs referenced by this scene
  created     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_scenes_browser_id ON scenes (browser_id);
CREATE INDEX idx_scenes_updated ON scenes (browser_id, updated DESC);
```

### Phase 2: Frontend Integration (Inside `excalidraw-app/`)

#### Step 1: Create `ServerPersistence.ts`

Create `excalidraw-app/data/ServerPersistence.ts`. This module **replaces** `LocalData.ts` as the primary persistence mechanism and exposes two interfaces:

**A. Scenes API** — save/load scene JSON:
```ts
class ServerPersistence {
  static getBrowserId(): string;
  static saveScene(sceneId: string, opts: { elements, appState, files, name }): Promise<SceneSaveResult>;
  static loadScene(sceneId: string): Promise<SceneLoadResult>;
  static createScene(elements, appState, files): Promise<SceneCreateResult>;
  static listScenes(opts: { limit?, offset? }): Promise<SceneListResult>;
  static deleteScene(sceneId: string): Promise<void>;
  static flushSave(): void;   // same signature as LocalData.flushSave()
}
```

**B. File storage plugin** — implements the `FileManager` callback interface:
```ts
ServerPersistence.fileStorage = {
  getFiles: (fileIds: FileId[]) => Promise<{ loadedFiles: BinaryFileData[]; erroredFiles: Map<FileId, true> }>;
  saveFiles: ({ addedFiles }: { addedFiles: Map<FileId, BinaryFileData> }) => Promise<{ savedFiles: Map<FileId, BinaryFileData>; erroredFiles: Map<FileId, BinaryFileData> }>;
};
```

**Key design decisions:**
- Use `fetch()` with `keepalive: true` for scene save requests to ensure data isn't lost on tab close.
- Debounce scene saves using the same `debounce` utility and `SAVE_TO_LOCAL_STORAGE_TIMEOUT` (300ms) from `app_constants.ts`.
- `saveScene` strips file blobs from the JSON body before sending (achieved by using `serializeAsJSON` with `"database"` mode, which sets `files: undefined`). File metadata is sent separately in the `files` field.
- `getFiles` fetches blobs from `GET /api/scenes/:id/files/:fileId`, reads as `Blob`, converts to `dataURL` via `FileReader.readAsDataURL()`, and returns `BinaryFileData` objects.
- `saveFiles` uploads blobs as `multipart/form-data` via `POST /api/scenes/:id/files`.
- Track the active `sceneId` internally so file operations know which scene context to use.

#### Step 2: Integrate into `App.tsx`

These are the specific integration points in `App.tsx` (~1287 lines):

| Line(s) | Current Behavior | Change |
|---------|-----------------|--------|
| **528-531** | `initializeScene()` → loads from localStorage or collab, resolves initial data | Add branch: if server persistence is enabled (backend URL is set) and no collab link is present, load scene from server API instead |
| **498-516** | Initial file load from IndexedDB via `LocalData.fileStorage.getFiles()` | Swap to `ServerPersistence.fileStorage.getFiles()` when server mode is active |
| **560-585** | Tab sync: polls `VERSION_DATA_STATE` in localStorage, reloads from localStorage if newer | **Remove or disable this polling** — the server is the source of truth. Cross-tab awareness of "scene changed" can be done via a minimal `lastActiveSceneId` in localStorage (set on scene switch, read on tab focus) |
| **620, 625, 655** | `LocalData.flushSave()` in beforeunload/resize handlers | Replace with `ServerPersistence.flushSave()` |
| **659** | `LocalData.fileStorage.shouldPreventUnload()` | Replace with `ServerPersistence.fileStorage.shouldPreventUnload()` (keep the same interface, this is a FileManager method) |
| **689-716** | `onChange` → `LocalData.save()` → localStorage + IndexedDB | Replace with `ServerPersistence.save()` → server API |

**Initialization flow** (updated `initializeScene`):
```
on mount
  ├─ #room=xxx in URL? → collaboration mode (unchanged)
  ├─ ?scene=xxx in URL? → fetch scene from server → restore → render
  ├─ lastActiveSceneId in localStorage? → fetch from server → restore → render
  └─ none of the above → POST /api/scenes (empty scene) → store new scene ID → render
```

**Scene change flow:**
```
user clicks "New Board"
  └─ flush pending save (ServerPersistence.flushSave())
  └─ POST /api/scenes (empty scene)
  └─ update URL to ?scene=newId
  └─ update localStorage lastActiveSceneId
  └─ clear canvas, switch to new scene
```

**Save flow** (replaces `LocalData.save`):
```
onChange fires (debounced at 300ms)
  ├─ serializeAsJSON(elements, appState, files, "database")
  ├─ PUT /api/scenes/:id (scene JSON body)
  │   └─ on success → mark image elements as "saved" (same logic as App.tsx:691-716)
  │   └─ on failure → show "Unsaved changes" indicator, retry button
  └─ concurrently: saveFiles() via FileManager → POST /api/scenes/:id/files
      └─ FileManager handles file tracking (saving/saved/errored states) — unchanged
```

#### Step 3: File Handling Integration

**Do NOT modify `FileManager.ts`.** Instead, create a `FileManager` instance backed by `ServerPersistence.fileStorage`:

```ts
const serverFileManager = new FileManager({
  getFiles: ServerPersistence.fileStorage.getFiles,
  saveFiles: ServerPersistence.fileStorage.saveFiles,
  onFileStatusChange: FileStatusStore.updateStatuses.bind(FileStatusStore),
});
```

This is the same pattern `LocalData` uses at `LocalData.ts:169-227`, but with server-backed callbacks. The `FileManager` class itself handles all the tracking logic (`isFileSavedOrBeingSaved`, `shouldPreventUnload`, `shouldUpdateImageElementStatus`, `reset`) — none of that needs to change.

#### Step 4: Disable localStorage Scene Saves

- **`LocalData.ts`**: Add a feature flag (`isServerPersistenceEnabled`) that skips the localStorage/indexedDB writes in `_save()` when server mode is active. Keep the `fileStorage` property (it can still serve files from IndexedDB as a fallback during migration). Keep `LibraryIndexedDBAdapter` and `LibraryLocalStorageMigrationAdapter` unchanged.
- **`localStorage.ts`**: Keep `importFromLocalStorage` as a migration path (first-time migration: read local data, save to server, then stop using it). Keep `getElementsStorageSize`/`getTotalStorageSize` for the debug stats panel.
- **`tabSync.ts`**: Replace with a minimal `lastActiveSceneId` sync: when the user switches scenes, write the new scene ID to `localStorage` under a key like `excalidraw-last-scene`. On tab focus, read this key and navigate to the scene if it changed. This preserves the "open new tab, see same board" behavior without the full-scene polling.

#### Step 5: Add Environment Variables

Add to `excalidraw-app/.env.development`:
```bash
VITE_APP_BACKEND_URL=http://localhost:3001
```

Add to `excalidraw-app/.env.production`:
```bash
VITE_APP_BACKEND_URL=https://your-backend.example.com
```

When `VITE_APP_BACKEND_URL` is not set (or empty), the app falls back to the existing localStorage/IndexedDB behavior. This makes server persistence opt-in and keeps the existing experience unchanged for deployments that don't set it up.

### Phase 3: UI/UX Adjustments

#### 1. Loading States
- Show a loading spinner when fetching a scene from the server on initial load.
- Show a "Saving..." / "Saved" / "Unsaved changes" indicator in the UI.

#### 2. Scene Management
- **New Board**: Button to create a new scene (flush pending saves, POST empty scene, navigate to `?scene=newId`).
- **Recent Boards List**: A dropdown or sidebar fetched from `GET /api/scenes?browserId=xxx`. Each entry shows the scene name and last-updated time. Clicking navigates to that scene (flush pending saves first).
- **URL-based Navigation**: `?scene=<id>` allows bookmarking and sharing scene links.

#### 3. Error Handling
- Server unreachable on load: "Unable to connect to the whiteboard server. Please check your connection."
- Save fails: Persistent "Unsaved changes" warning with retry button.
- **No fallback to localStorage** — avoids complexity and data divergence.

### Phase 4: Testing & Verification

1. **Type Safety**: Run `yarn test:typecheck` after all changes.
2. **Integration Testing**:
   - Open app → creates new scene on server
   - Draw elements → saves to server on debounce
   - Add image → uploads file to server
   - Refresh page → loads scene and images from server
   - Open in new tab → same scene loaded from server
   - Delete scene → removed from server
   - Switch between scenes → each loads correctly
3. **Scale Testing**: Test with a very large whiteboard (10,000+ elements, many images).
4. **Backward Compatibility**: Verify that when `VITE_APP_BACKEND_URL` is not set, the app uses localStorage/IndexedDB as before (no regression).

## File Changes Summary

| File | Action | Description |
|------|--------|-------------|
| `excalidraw-app/data/ServerPersistence.ts` | **Create** | Scene CRUD + file upload/download backed by server API. Exposes a `fileStorage` object compatible with `FileManager`'s constructor. |
| `excalidraw-app/data/LocalData.ts` | **Modify** | Add `isServerPersistenceEnabled` flag; skip localStorage/IndexedDB writes when server mode is active. Keep `LibraryIndexedDBAdapter` unchanged. |
| `excalidraw-app/data/tabSync.ts` | **Modify** | Replace full-scene version polling with a minimal `lastActiveSceneId` sync (write scene ID on switch, read on tab focus). |
| `excalidraw-app/App.tsx` | **Modify** | (1) `initializeScene`: load from server when no collab link; (2) `onChange` handler: swap `LocalData.save` for `ServerPersistence.save`; (3) `loadImages`: use `ServerPersistence.fileStorage` for file loading; (4) beforeunload: use `ServerPersistence.flushSave`. |
| `excalidraw-app/data/FileManager.ts` | **No change** | Already accepts pluggable `getFiles`/`saveFiles`. No modifications needed. |
| `excalidraw-app/data/localStorage.ts` | **No change** | Keep for collab username, theme, and as a migration source. No modifications needed. |
| `excalidraw-app/data/firebase.ts` | **No change** | Already only used for collab/share links. No modifications needed. |
| `excalidraw-app/data/TTDStorage.ts` | **No change** | TTD chats remain in IndexedDB. No modifications needed. |
| `excalidraw-app/data/fileStatusStore.ts` | **No change** | Unchanged. |
| `excalidraw-app/data/index.ts` | **Modify** | Adjust share link / export logic to use server-backed file upload for shareable links. |
| `excalidraw-app/.env.development` | **Modify** | Add `VITE_APP_BACKEND_URL`. |
| `excalidraw-app/.env.production` | **Modify** | Add `VITE_APP_BACKEND_URL`. |
| `excalidraw-app/package.json` | **No change** | No new frontend dependencies needed (`fetch` is native). |

> **Note**: Files in `packages/excalidraw/` (core library) require **zero changes** since the serialization/deserialization APIs (`serializeAsJSON` with `"database"` mode, `restoreElements`, `restoreAppState`) already produce and consume the format we will store on the server. The `"database"` mode strips file blobs (which we handle separately) and UI-local state (which doesn't need server persistence).

## Risks & Mitigations

| Risk | Impact | Mitigation |
|------|--------|------------|
| **Server downtime / unreachable** | High | Show clear errors. No offline support by design. |
| **Large image uploads block saves** | Medium | Upload images asynchronously via `FileManager`. Scene JSON saves first, then file uploads proceed in the background. `FileManager` already tracks upload status per file. |
| **Data loss on browser close before save** | Medium | Use `fetch()` with `keepalive: true` for save requests. Call `flushSave()` in `beforeunload`. The debounce window is only 300ms, so at most 300ms of edits could be lost. |
| **Performance: fetching large scenes** | Medium | The full scene JSON is required by Excalidraw regardless of storage backend. Images are fetched lazily (only those visible on canvas are loaded via `FileManager.getFiles`). Scene list is paginated from the start. |
| **Browser ID loss / new device** | Medium | The `browserId` is the only identifier. If the user clears localStorage, they lose access to their scenes. This is acceptable for MVP; auth solves this later. |
| **`"database"` mode strips too much appState** | Low | Only 5 fields are preserved: `viewBackgroundColor`, `gridSize`, `gridStep`, `gridModeEnabled`, `lockedMultiSelections`. If users expect scroll position or zoom to carry between sessions, we can switch to a custom serialization mode (the `_clearAppStateForStorage` function is configurable). |
| **File upload ordering (scene JSON arrives before file blobs)** | Medium | If the server receives a scene update referencing `fileId-X` but no upload for that file yet, it stores the reference as "pending". The client uploads files before/after updating the scene JSON. On subsequent GET, the scene still references the file; if the file hasn't been uploaded yet, the GET file endpoint returns 404 and the client treats it as an error. |

## Future Enhancements (Out of Scope for Now)

1. **Authentication**: Replace `browserId` with real user accounts (OAuth, JWT). Link existing anonymous scenes to authenticated users.
2. **Offline Support**: Add a service worker and IndexedDB queue for offline edits that sync when the connection returns.
3. **Multiplayer / Collaboration**: Integrate WebSockets for real-time editing. This will require CRDTs or OT on top of the existing server persistence.
4. **Version History**: Store snapshots of scenes on the server to allow time-travel / undo beyond the browser session.
5. **Encryption**: Add end-to-end encryption for scenes at rest, similar to the existing collaboration room encryption.
6. **Library/TTD server sync**: Migrate library items and TTD chat history to the server for cross-device access.

## Conclusion

This plan provides a straightforward path to self-hosted, server-side whiteboard persistence. By leveraging `FileManager`'s existing plugin architecture (no modifications needed) and the existing `serializeAsJSON`/`restoreElements`/`restoreAppState` APIs in `packages/excalidraw/`, we can achieve infinite storage with minimal architectural changes. The key new module is `ServerPersistence.ts` in `excalidraw-app/data/`, which provides both scene CRUD and a `FileManager`-compatible file storage interface. The main integration surface is in `App.tsx` at 6 specific change points.
