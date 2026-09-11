import { listen, UnlistenFn } from "@tauri-apps/api/event";
import type { ImportProgress } from "./types";

export function listenImportProgress(
  cb: (p: ImportProgress) => void,
): Promise<UnlistenFn> {
  return listen<ImportProgress>("import-progress", (ev) => cb(ev.payload));
}
