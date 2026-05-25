import { useAtomValue } from "jotai";
import React, { useCallback, useEffect, useState } from "react";

import {
  PlusIcon,
  TrashIcon,
} from "@excalidraw/excalidraw/components/icons";

import {
  isServerPersistenceEnabled,
  ServerPersistence,
} from "../data/ServerPersistence";

import "./SceneList.scss";

export type SceneItem = {
  id: string;
  name: string;
  updated: number;
  created: number;
};

export const SceneList: React.FC<{
  currentSceneId: string | null;
  onSceneSelect: (sceneId: string) => void;
  onNewBoard: () => void;
}> = React.memo(({ currentSceneId, onSceneSelect, onNewBoard }) => {
  const [scenes, setScenes] = useState<SceneItem[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const fetchScenes = useCallback(async () => {
    if (!isServerPersistenceEnabled) {
      return;
    }
    setIsLoading(true);
    setError(null);
    try {
      const result = await ServerPersistence.listScenes({ limit: 50 });
      setScenes(result.scenes);
    } catch (err: any) {
      setError(err.message || "Failed to load boards");
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchScenes();
  }, [fetchScenes]);

  const handleDelete = useCallback(
    async (e: React.MouseEvent, sceneId: string) => {
      e.stopPropagation();
      if (!confirm("Are you sure you want to delete this board?")) {
        return;
      }
      setDeletingId(sceneId);
      try {
        await ServerPersistence.deleteScene(sceneId);
        setScenes((prev) => prev.filter((s) => s.id !== sceneId));
        if (currentSceneId === sceneId) {
          onNewBoard();
        }
      } catch (err: any) {
        alert(err.message || "Failed to delete board");
      } finally {
        setDeletingId(null);
      }
    },
    [currentSceneId, onNewBoard],
  );

  const formatDate = (timestamp: number) => {
    const date = new Date(timestamp);
    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  if (!isServerPersistenceEnabled) {
    return (
      <div className="scene-list">
        <div className="scene-list__empty">
          Server persistence is not enabled.
        </div>
      </div>
    );
  }

  return (
    <div className="scene-list">
      <div className="scene-list__header">
        <button
          className="scene-list__new-button"
          onClick={onNewBoard}
          title="Create new board"
        >
          {PlusIcon}
          <span>New Board</span>
        </button>
      </div>

      {isLoading && scenes.length === 0 && (
        <div className="scene-list__loading">Loading boards...</div>
      )}

      {error && (
        <div className="scene-list__error">
          <span>{error}</span>
          <button onClick={fetchScenes}>Retry</button>
        </div>
      )}

      {!isLoading && !error && scenes.length === 0 && (
        <div className="scene-list__empty">No boards yet.</div>
      )}

      <ul className="scene-list__items">
        {scenes.map((scene) => (
          <li
            key={scene.id}
            className={`scene-list__item ${scene.id === currentSceneId ? "scene-list__item--active" : ""} ${deletingId === scene.id ? "scene-list__item--deleting" : ""}`}
            onClick={() => onSceneSelect(scene.id)}
          >
            <div className="scene-list__item-info">
              <span className="scene-list__item-name">
                {scene.name || "Untitled"}
              </span>
              <span className="scene-list__item-date">
                {formatDate(scene.updated)}
              </span>
            </div>
            <button
              className="scene-list__item-delete"
              onClick={(e) => handleDelete(e, scene.id)}
              title="Delete board"
              disabled={deletingId === scene.id}
            >
              {TrashIcon}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
});

SceneList.displayName = "SceneList";
