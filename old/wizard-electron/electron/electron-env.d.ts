/// <reference types="vite-plugin-electron/electron-env" />

declare namespace NodeJS {
  interface ProcessEnv {
    /**
     * The built directory structure
     *
     * ```tree
     * ├─┬─┬ dist
     * │ │ └── index.html
     * │ │
     * │ ├─┬ dist-electron
     * │ │ ├── main.js
     * │ │ └── preload.js
     * │
     * ```
     */
    APP_ROOT: string;
    /** /dist/ or /public/ */
    VITE_PUBLIC: string;
  }
}

// Used in Renderer process, expose in `preload.ts`
interface Window {
  ipcRenderer: import("electron").IpcRenderer;
  focusWizard: {
    capturePageScreenshot: () => Promise<string>;
    openSettings: () => Promise<void>;
    startSession: () => Promise<void>;
    quitApp: () => Promise<void>;
    openWalletPage: () => Promise<void>;
    triggerSpell: () => Promise<void>;
    dismissSpell: () => Promise<void>;
    closeSpellOverlay: () => Promise<void>;
    onDismissSpell: (callback: () => void) => () => void;
    onTriggerScreenshot: (callback: () => void) => () => void;
  };
}
