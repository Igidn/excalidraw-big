import { useAtomValue } from "jotai";
import React from "react";

import {
  alertTriangleIcon,
  checkIcon,
  RetryIcon,
} from "@excalidraw/excalidraw/components/icons";

import {
  serverSaveErrorAtom,
  serverSavingAtom,
  ServerPersistence,
} from "../data/ServerPersistence";

import "./ServerSaveIndicator.scss";

export const ServerSaveIndicator: React.FC = React.memo(() => {
  const saving = useAtomValue(serverSavingAtom);
  const error = useAtomValue(serverSaveErrorAtom);

  if (error) {
    return (
      <div className="server-save-indicator server-save-indicator--error">
        {alertTriangleIcon}
        <span className="server-save-indicator__text">Unsaved changes</span>
        <button
          className="server-save-indicator__retry"
          onClick={() => ServerPersistence.flushSave()}
          title="Retry save"
        >
          {RetryIcon}
        </button>
      </div>
    );
  }

  if (saving) {
    return (
      <div className="server-save-indicator server-save-indicator--saving">
        <span className="server-save-indicator__spinner" />
        <span className="server-save-indicator__text">Saving...</span>
      </div>
    );
  }

  return (
    <div className="server-save-indicator server-save-indicator--saved">
      {checkIcon}
      <span className="server-save-indicator__text">Saved</span>
    </div>
  );
});

ServerSaveIndicator.displayName = "ServerSaveIndicator";
