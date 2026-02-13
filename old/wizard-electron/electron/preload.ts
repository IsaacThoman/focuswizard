import { contextBridge, ipcRenderer } from "electron";

// --------- Expose some API to the Renderer process ---------
contextBridge.exposeInMainWorld("ipcRenderer", {
  on(...args: Parameters<typeof ipcRenderer.on>) {
    const [channel, listener] = args;
    return ipcRenderer.on(
      channel,
      (event, ...args) => listener(event, ...args),
    );
  },
  off(...args: Parameters<typeof ipcRenderer.off>) {
    const [channel, ...omit] = args;
    return ipcRenderer.off(channel, ...omit);
  },
  send(...args: Parameters<typeof ipcRenderer.send>) {
    const [channel, ...omit] = args;
    return ipcRenderer.send(channel, ...omit);
  },
  invoke(...args: Parameters<typeof ipcRenderer.invoke>) {
    const [channel, ...omit] = args;
    return ipcRenderer.invoke(channel, ...omit);
  },
  // You can expose other APTs you need here.
  // ...
});

function createListener(channel: string) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (callback: (...args: any[]) => void): () => void => {
    const handler = (_event: Electron.IpcRendererEvent, ...args: unknown[]) =>
      callback(...args);
    ipcRenderer.on(channel, handler);
    return () => {
      ipcRenderer.removeListener(channel, handler);
    };
  };
}

contextBridge.exposeInMainWorld("wizardAPI", {
  capturePageScreenshot: () =>
    ipcRenderer.invoke("focus-wizard:capture-page-screenshot") as Promise<
      string
    >,
  openSettings: () =>
    ipcRenderer.invoke("focus-wizard:open-settings") as Promise<void>,
  startSession: () =>
    ipcRenderer.invoke("focus-wizard:start-session") as Promise<void>,
  quitApp: () => ipcRenderer.invoke("focus-wizard:quit-app") as Promise<void>,
  hideWindow: () =>
    ipcRenderer.invoke("focus-wizard:hide-window") as Promise<void>,

  // ElevenLabs TTS (main process holds the API key)
  speak: (text: string) =>
    ipcRenderer.invoke("tts:elevenlabs-speak", { text }) as Promise<
      | { ok: true; mimeType?: string; audio: Uint8Array }
      | { ok: false; error: string }
    >,

  // Bridge API
  startBridge: (apiKey?: string) => ipcRenderer.invoke("bridge:start", apiKey),
  stopBridge: () => ipcRenderer.invoke("bridge:stop"),
  getBridgeStatus: () => ipcRenderer.invoke("bridge:status"),
  checkDocker: () => ipcRenderer.invoke("docker:check"),

  // Send webcam frame to main process
  sendFrame: (timestampUs: number, data: ArrayBuffer) => {
    ipcRenderer.send("frame:data", timestampUs, data);
  },

  // Bridge event listeners
  onFocus: createListener("bridge:focus"),
  onMetrics: createListener("bridge:metrics"),
  onEdge: createListener("bridge:edge"),
  onStatus: createListener("bridge:status"),
  onError: createListener("bridge:error"),
  onReady: createListener("bridge:ready"),
  onClosed: createListener("bridge:closed"),
});

// Backwards compatibility - keep focusWizard for existing code
contextBridge.exposeInMainWorld("focusWizard", {
  capturePageScreenshot: () =>
    ipcRenderer.invoke("focus-wizard:capture-page-screenshot") as Promise<
      string
    >,
  openSettings: () =>
    ipcRenderer.invoke("focus-wizard:open-settings") as Promise<void>,
  startSession: () =>
    ipcRenderer.invoke("focus-wizard:start-session") as Promise<void>,
  quitApp: () => ipcRenderer.invoke("focus-wizard:quit-app") as Promise<void>,
  openWalletPage: () =>
    ipcRenderer.invoke("focus-wizard:open-wallet-page") as Promise<void>,
  triggerSpell: () =>
    ipcRenderer.invoke("focus-wizard:trigger-spell") as Promise<void>,
  dismissSpell: () =>
    ipcRenderer.invoke("focus-wizard:dismiss-spell") as Promise<void>,
  closeSpellOverlay: () =>
    ipcRenderer.invoke("focus-wizard:close-spell-overlay") as Promise<void>,
  onDismissSpell: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("focus-wizard:dismiss-spell", listener);
    return () => {
      ipcRenderer.removeListener("focus-wizard:dismiss-spell", listener);
    };
  },
  onTriggerScreenshot: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on("focus-wizard:trigger-screenshot", listener);
    return () => {
      ipcRenderer.removeListener("focus-wizard:trigger-screenshot", listener);
    };
  },
});
