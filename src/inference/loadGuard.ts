/**
 * The app's load guard (CR-2): the marker lives in a small file next to the
 * models, the crash bookkeeping in settings. consumeLoadCrash is what the chat
 * calls once after start to tell the user a model closed the app.
 */
import * as FileSystem from "expo-file-system/legacy";
import { recordLoadCrash, recordLoadSuccess, recordRepackCrash, takeKeepMapped, takePendingLoadCrash } from "../models/settings";
import { createLoadGuard, LoadCrash, MarkerStore } from "./loadMarker";

const MARKER = `${FileSystem.documentDirectory}model-load.marker.json`;

const fileStore: MarkerStore = {
  async read() {
    const info = await FileSystem.getInfoAsync(MARKER);
    return info.exists ? FileSystem.readAsStringAsync(MARKER) : null;
  },
  write: (json) => FileSystem.writeAsStringAsync(MARKER, json),
  clear: () => FileSystem.deleteAsync(MARKER, { idempotent: true }),
};

export const loadGuard = createLoadGuard(fileStore, {
  recordCrash: recordLoadCrash,
  recordSuccess: recordLoadSuccess,
  takePending: takePendingLoadCrash,
  recordRepackCrash,
  takeKeepMapped,
});

/** The last load that killed the app, once (null afterwards, or when there was none). */
export function consumeLoadCrash(): Promise<LoadCrash | null> {
  return loadGuard.consume();
}

export type { LoadCrash } from "./loadMarker";
