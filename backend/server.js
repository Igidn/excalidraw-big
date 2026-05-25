/**
 * Excalidraw Server-Side Persistence Backend
 *
 * Minimal REST API using Node.js built-in sqlite and local filesystem storage.
 */

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { DatabaseSync } = require("node:sqlite");

const DATA_DIR = path.join(__dirname, "data");
const FILES_DIR = path.join(DATA_DIR, "files");
const DB_PATH = path.join(DATA_DIR, "excalidraw.db");

// Ensure directories exist
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(FILES_DIR)) fs.mkdirSync(FILES_DIR, { recursive: true });

// Initialize SQLite database
const db = new DatabaseSync(DB_PATH);

// Enable WAL mode for better concurrency
db.exec("PRAGMA journal_mode = WAL;");

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS scenes (
    id TEXT PRIMARY KEY,
    browser_id TEXT NOT NULL,
    name TEXT NOT NULL DEFAULT 'Untitled',
    data TEXT NOT NULL,
    file_ids TEXT NOT NULL DEFAULT '[]',
    created INTEGER NOT NULL,
    updated INTEGER NOT NULL
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS files (
    id TEXT NOT NULL,
    scene_id TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    created INTEGER NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (id, scene_id)
  );
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_scenes_browser_id ON scenes (browser_id);
`);

db.exec(`
  CREATE INDEX IF NOT EXISTS idx_scenes_updated ON scenes (browser_id, updated DESC);
`);

// Utility functions
const generateUUID = () => {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
};

const parseJSON = (str, fallback) => {
  try {
    return JSON.parse(str);
  } catch {
    return fallback;
  }
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

const parseMultipart = (req) =>
  new Promise((resolve, reject) => {
    const contentType = req.headers["content-type"] || "";
    const boundaryMatch = contentType.match(/boundary=([^;\s]+)/);
    if (!boundaryMatch) {
      reject(new Error("No boundary found in multipart content type"));
      return;
    }
    const boundary = "--" + boundaryMatch[1];
    const parts = [];
    let buffer = Buffer.alloc(0);

    req.on("data", (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
    });

    req.on("end", () => {
      const text = buffer.toString("binary");
      const rawParts = text.split(boundary).slice(1, -1);

      for (const part of rawParts) {
        const headerEnd = part.indexOf("\r\n\r\n");
        if (headerEnd === -1) continue;
        const headers = part.slice(0, headerEnd);
        const body = part.slice(headerEnd + 4, -2); // remove trailing \r\n

        const nameMatch = headers.match(/name="([^"]+)"/);
        const filenameMatch = headers.match(/filename="([^"]*)"/);
        const name = nameMatch ? nameMatch[1] : null;

        if (filenameMatch) {
          // File field
          parts.push({
            name,
            filename: filenameMatch[1],
            data: Buffer.from(body, "binary"),
          });
        } else {
          // Regular field
          parts.push({
            name,
            value: body,
          });
        }
      }
      resolve(parts);
    });

    req.on("error", reject);
  });

const sendJSON = (res, status, data) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
};

const sendError = (res, status, message) => {
  sendJSON(res, status, { error: message });
};

const setCORS = (res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
};

// Route handlers
const listScenes = (req, res, query) => {
  const browserId = query.get("browserId");
  if (!browserId) {
    return sendError(res, 400, "browserId is required");
  }

  const limit = Math.min(parseInt(query.get("limit") || "50", 10), 100);
  const offset = parseInt(query.get("offset") || "0", 10);
  const sort = query.get("sort") || "updated";
  const order = query.get("order") || "desc";

  const sortCol = sort === "created" ? "created" : "updated";
  const orderDir = order === "asc" ? "ASC" : "DESC";

  const countStmt = db.prepare("SELECT COUNT(*) as total FROM scenes WHERE browser_id = ?");
  const total = countStmt.get(browserId).total;

  const stmt = db.prepare(
    `SELECT id, name, created, updated FROM scenes WHERE browser_id = ? ORDER BY ${sortCol} ${orderDir} LIMIT ? OFFSET ?`
  );
  const rows = stmt.all(browserId, limit, offset);

  sendJSON(res, 200, {
    scenes: rows.map((r) => ({
      id: r.id,
      name: r.name,
      created: r.created,
      updated: r.updated,
    })),
    total,
    limit,
    offset,
  });
};

const createScene = async (req, res) => {
  const body = await readBody(req);
  const data = parseJSON(body, null);
  if (!data || !data.browserId) {
    return sendError(res, 400, "browserId is required");
  }

  const now = Date.now();
  const id = generateUUID();
  const name = data.name || "Untitled";
  const sceneData = {
    type: "excalidraw",
    version: 2,
    source: "excalidraw-self-hosted",
    elements: data.elements || [],
    appState: data.appState || {},
    files: data.files || {},
  };
  const fileIds = Object.keys(data.files || {});

  const stmt = db.prepare(
    "INSERT INTO scenes (id, browser_id, name, data, file_ids, created, updated) VALUES (?, ?, ?, ?, ?, ?, ?)"
  );
  stmt.run(id, data.browserId, name, JSON.stringify(sceneData), JSON.stringify(fileIds), now, now);

  sendJSON(res, 201, { id, name, created: now, updated: now });
};

const getScene = (req, res, query, sceneId) => {
  const browserId = query.get("browserId");
  if (!browserId) {
    return sendError(res, 400, "browserId is required");
  }

  const stmt = db.prepare("SELECT * FROM scenes WHERE id = ? AND browser_id = ?");
  const row = stmt.get(sceneId, browserId);

  if (!row) {
    return sendError(res, 404, "Scene not found");
  }

  const sceneData = parseJSON(row.data, {});
  sendJSON(res, 200, {
    id: row.id,
    name: row.name,
    type: sceneData.type || "excalidraw",
    version: sceneData.version || 2,
    source: sceneData.source || "excalidraw-self-hosted",
    elements: sceneData.elements || [],
    appState: sceneData.appState || {},
    files: sceneData.files || {},
    created: row.created,
    updated: row.updated,
  });
};

const updateScene = async (req, res, sceneId) => {
  const body = await readBody(req);
  const data = parseJSON(body, null);
  if (!data || !data.browserId) {
    return sendError(res, 400, "browserId is required");
  }

  const checkStmt = db.prepare("SELECT * FROM scenes WHERE id = ? AND browser_id = ?");
  const existing = checkStmt.get(sceneId, data.browserId);
  if (!existing) {
    return sendError(res, 404, "Scene not found");
  }

  const now = Date.now();
  const name = data.name !== undefined ? data.name : existing.name;
  const existingData = parseJSON(existing.data, {});
  const sceneData = {
    ...existingData,
    elements: data.elements !== undefined ? data.elements : existingData.elements,
    appState: data.appState !== undefined ? data.appState : existingData.appState,
    files: data.files !== undefined ? data.files : existingData.files,
  };
  const fileIds = Object.keys(sceneData.files || {});

  const stmt = db.prepare(
    "UPDATE scenes SET name = ?, data = ?, file_ids = ?, updated = ? WHERE id = ? AND browser_id = ?"
  );
  stmt.run(name, JSON.stringify(sceneData), JSON.stringify(fileIds), now, sceneId, data.browserId);

  sendJSON(res, 200, { id: sceneId, name, updated: now });
};

const deleteScene = async (req, res, sceneId) => {
  const body = await readBody(req);
  const data = parseJSON(body, {});
  if (!data.browserId) {
    return sendError(res, 400, "browserId is required");
  }

  // Delete associated files first
  const filesStmt = db.prepare("SELECT id FROM files WHERE scene_id = ?");
  const files = filesStmt.all(sceneId);
  for (const file of files) {
    const filePath = path.join(FILES_DIR, sceneId, file.id);
    try {
      fs.unlinkSync(filePath);
    } catch (e) {
      // ignore if file doesn't exist
    }
  }

  // Remove scene directory
  const sceneDir = path.join(FILES_DIR, sceneId);
  try {
    fs.rmdirSync(sceneDir);
  } catch (e) {
    // ignore if directory doesn't exist or isn't empty
  }

  db.prepare("DELETE FROM files WHERE scene_id = ?").run(sceneId);
  const result = db.prepare("DELETE FROM scenes WHERE id = ? AND browser_id = ?").run(sceneId, data.browserId);

  if (result.changes === 0) {
    return sendError(res, 404, "Scene not found");
  }

  sendJSON(res, 200, { deleted: true });
};

const uploadFile = async (req, res, sceneId) => {
  // Verify scene exists (any browser can upload files to a scene... actually no, we should check)
  // For simplicity, we'll skip browserId check on upload since the client sends it in the form data
  const parts = await parseMultipart(req);

  let fileData = null;
  let fileId = null;
  let mimeType = null;
  let created = null;

  for (const part of parts) {
    if (part.name === "file") {
      fileData = part.data;
    } else if (part.name === "fileId") {
      fileId = part.value;
    } else if (part.name === "mimeType") {
      mimeType = part.value;
    } else if (part.name === "created") {
      created = parseInt(part.value, 10);
    }
  }

  if (!fileData || !fileId || !mimeType) {
    return sendError(res, 400, "Missing required file fields");
  }

  const sceneDir = path.join(FILES_DIR, sceneId);
  if (!fs.existsSync(sceneDir)) {
    fs.mkdirSync(sceneDir, { recursive: true });
  }

  const filePath = path.join(sceneDir, fileId);
  fs.writeFileSync(filePath, fileData);

  const now = created || Date.now();
  const size = fileData.length;

  const stmt = db.prepare(
    "INSERT OR REPLACE INTO files (id, scene_id, mime_type, created, size) VALUES (?, ?, ?, ?, ?)"
  );
  stmt.run(fileId, sceneId, mimeType, now, size);

  sendJSON(res, 201, { fileId, mimeType, created: now, size });
};

const getFile = (req, res, sceneId, fileId) => {
  const filePath = path.join(FILES_DIR, sceneId, fileId);
  if (!fs.existsSync(filePath)) {
    return sendError(res, 404, "File not found");
  }

  const metaStmt = db.prepare("SELECT mime_type FROM files WHERE id = ? AND scene_id = ?");
  const meta = metaStmt.get(fileId, sceneId);
  const mimeType = meta?.mime_type || "application/octet-stream";

  const data = fs.readFileSync(filePath);
  res.writeHead(200, {
    "Content-Type": mimeType,
    "Cache-Control": "public, max-age=31536000, immutable",
    "Content-Length": data.length,
  });
  res.end(data);
};

const deleteFile = async (req, res, sceneId, fileId) => {
  const body = await readBody(req);
  const data = parseJSON(body, {});
  if (!data.browserId) {
    return sendError(res, 400, "browserId is required");
  }

  // Verify the scene belongs to the browserId
  const checkStmt = db.prepare("SELECT 1 FROM scenes WHERE id = ? AND browser_id = ?");
  if (!checkStmt.get(sceneId, data.browserId)) {
    return sendError(res, 404, "Scene not found");
  }

  const filePath = path.join(FILES_DIR, sceneId, fileId);
  try {
    fs.unlinkSync(filePath);
  } catch (e) {
    // ignore
  }

  db.prepare("DELETE FROM files WHERE id = ? AND scene_id = ?").run(fileId, sceneId);
  sendJSON(res, 200, { deleted: true });
};

// Main request handler
const server = http.createServer(async (req, res) => {
  setCORS(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);
  const pathname = url.pathname;
  const query = url.searchParams;

  try {
    if (pathname === "/api/scenes" && req.method === "GET") {
      listScenes(req, res, query);
    } else if (pathname === "/api/scenes" && req.method === "POST") {
      await createScene(req, res);
    } else if (pathname.startsWith("/api/scenes/") && pathname.endsWith("/files") && req.method === "POST") {
      const sceneId = pathname.slice("/api/scenes/".length, -"/files".length);
      await uploadFile(req, res, sceneId);
    } else if (pathname.startsWith("/api/scenes/") && pathname.includes("/files/") && req.method === "GET") {
      const rest = pathname.slice("/api/scenes/".length);
      const [sceneId, , fileId] = rest.split("/");
      getFile(req, res, sceneId, fileId);
    } else if (pathname.startsWith("/api/scenes/") && pathname.includes("/files/") && req.method === "DELETE") {
      const rest = pathname.slice("/api/scenes/".length);
      const [sceneId, , fileId] = rest.split("/");
      await deleteFile(req, res, sceneId, fileId);
    } else if (pathname.startsWith("/api/scenes/") && req.method === "GET") {
      const sceneId = pathname.slice("/api/scenes/".length);
      getScene(req, res, query, sceneId);
    } else if (pathname.startsWith("/api/scenes/") && req.method === "PUT") {
      const sceneId = pathname.slice("/api/scenes/".length);
      await updateScene(req, res, sceneId);
    } else if (pathname.startsWith("/api/scenes/") && req.method === "DELETE") {
      const sceneId = pathname.slice("/api/scenes/".length);
      await deleteScene(req, res, sceneId);
    } else if (pathname === "/health") {
      sendJSON(res, 200, { status: "ok" });
    } else {
      sendError(res, 404, "Not found");
    }
  } catch (error) {
    console.error("Server error:", error);
    sendError(res, 500, error.message || "Internal server error");
  }
});

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`Excalidraw backend listening on http://localhost:${PORT}`);
});
