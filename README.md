# Excalidraw with Server-Side Persistence

A fork of [Excalidraw](https://excalidraw.com) that saves your whiteboards to a self-hosted backend instead of browser storage.

## Requirements

- Node.js >= 18
- Yarn

## Setup

```bash
yarn install
yarn build:packages
```

## Running

### 1. Start the backend

```bash
PORT=3002 node backend/server.js
```

The backend API will be available at `http://localhost:3002`.

### 2. Start the frontend

Create a `.env.local` file in the project root:

```bash
VITE_APP_BACKEND_URL=http://localhost:3002
```

Then run:

```bash
yarn start
```

The app will open at `http://localhost:3001`.

## How it works

- When `VITE_APP_BACKEND_URL` is set, drawings are saved to the server instead of `localStorage` / `IndexedDB`.
- The backend stores scenes in SQLite (`backend/data/excalidraw.db`) and files on disk (`backend/data/files/`).
- Each browser gets a unique ID; scenes are scoped to that browser.
