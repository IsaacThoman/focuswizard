import { useCallback, useEffect, useRef, useState } from "react";
import { useWebcam } from "../hooks/useWebcam";
import {
  type GetAttentivenessRequest,
  getAttentivenessResponseSchema,
} from "@shared/productivitySchemas";
import "./Settings.css";

interface FocusData {
  state:
    | "focused"
    | "distracted"
    | "drowsy"
    | "stressed"
    | "away"
    | "talking"
    | "unknown";
  focus_score: number;
  face_detected: boolean;
  is_talking: boolean;
  is_blinking: boolean;
  blink_rate_per_min: number;
  gaze_x: number;
  gaze_y: number;
  has_gaze: boolean;
  pulse_bpm: number;
  breathing_bpm: number;
}

export interface SettingsData {
  pomodoroWorkMinutes: number | "";
  pomodoroBreakMinutes: number | "";
  pomodoroIterations: number | "";
  devMode: boolean;
  positivePrompt: string;
  negativePrompt: string;
  rewardPerCycle: number | "";  // SOL earned per completed pomodoro cycle
}

const DEFAULT_POMODORO_WORK_MINUTES = 25;
const DEFAULT_POMODORO_BREAK_MINUTES = 5;
const DEFAULT_POMODORO_ITERATIONS = 4;
const DEFAULT_REWARD_PER_CYCLE = 0.001;

const DEFAULT_SETTINGS: SettingsData = {
  pomodoroWorkMinutes: DEFAULT_POMODORO_WORK_MINUTES,
  pomodoroBreakMinutes: DEFAULT_POMODORO_BREAK_MINUTES,
  pomodoroIterations: DEFAULT_POMODORO_ITERATIONS,
  devMode: false,
  positivePrompt: "",
  negativePrompt: "",
  rewardPerCycle: DEFAULT_REWARD_PER_CYCLE,
};

function clampNumber(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function coerceInt(val: unknown, fallback: number, min: number, max: number): number {
  const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return clampNumber(Math.round(n), min, max);
}

function coerceNumber(val: unknown, fallback: number, min: number, max: number): number {
  const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return clampNumber(n, min, max);
}

interface ClickSparkle {
  id: number;
  x: number;
  y: number;
  angle: number;
  distance: number;
}

interface WalletStatus {
  vaultAddress: string;
  onChainBalanceSol: number;
  vaultBalanceSol: number;  // Locked, needs work to unlock
  earnedBalanceSol: number;  // Available for withdrawal
  totalBalanceSol: number;
  earnedBalanceUsd: number;
  vaultBalanceUsd: number;
  totalBalanceUsd: number;
  rewardPerCycle: number;
  rewardPerCycleUsd: number;
  totalCyclesCompleted: number;
  connectedWallet: string | null;
  solToUsdRate: number;
  discrepancySol?: number;  // Difference between on-chain and tracked balances
}

const BACKEND_URL = "http://localhost:8000";
const ATTENTIVENESS_ENDPOINT = `${BACKEND_URL}/getAttentiveness`;

interface PomodoroStatus {
  enabled: boolean;
  isRunning: boolean;
  isPaused: boolean;
  timeRemaining: number;
  mode: "work" | "break";
  iteration: number;
  totalIterations: number;
}

export function SettingsPage() {
  const [settings, setSettings] = useState<SettingsData>(() => {
    const savedSettings = localStorage.getItem("focus-wizard-settings");
    if (!savedSettings) return DEFAULT_SETTINGS;
    try {
      const parsed: unknown = JSON.parse(savedSettings);
      const rest: Record<string, unknown> =
        parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};

      // Ignore any legacy pomodoroEnabled flag; runtime state lives in pomodoro status.
      delete rest.pomodoroEnabled;

      return { ...DEFAULT_SETTINGS, ...(rest as Partial<SettingsData>) };
    } catch (e) {
      console.error("Failed to parse saved settings:", e);
      return DEFAULT_SETTINGS;
    }
  });
  const [settingsLoaded, setSettingsLoaded] = useState(false);
  const [clickSparkles, setClickSparkles] = useState<ClickSparkle[]>([]);

  const [focusData, setFocusData] = useState<FocusData | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<string>("Not started");
  const [bridgeReady, setBridgeReady] = useState(false);
  const [authError, setAuthError] = useState(false);
  const webcamPreviewRef = useRef<HTMLVideoElement>(null);

  const [walletStatus, setWalletStatus] = useState<WalletStatus | null>(null);
  const [walletLoading, setWalletLoading] = useState(false);
  const [walletError, setWalletError] = useState<string | null>(null);

  const [attentiveness, setAttentiveness] = useState<number | null>(null);
  const [attentivenessError, setAttentivenessError] = useState<string | null>(
    null,
  );
  const attentivenessInFlightRef = useRef(false);
  const latestFocusDataRef = useRef<FocusData | null>(null);
  const latestBridgeStatusRef = useRef<string>(bridgeStatus);

  useEffect(() => {
    latestFocusDataRef.current = focusData;
  }, [focusData]);

  useEffect(() => {
    latestBridgeStatusRef.current = bridgeStatus;
  }, [bridgeStatus]);
  const [pomodoroStatus, setPomodoroStatus] = useState<PomodoroStatus>({
    enabled: false,
    isRunning: false,
    isPaused: false,
    timeRemaining: 0,
    mode: "work",
    iteration: 1,
    totalIterations: 4,
  });

  // Webcam capture - start immediately when dev mode is on (before bridge)
  const { stream, isActive: webcamActive, error: webcamError } = useWebcam({
    width: 640,
    height: 480,
    fps: 0.5, // 1 frame every 2 seconds
    quality: 0.80,
    enabled: settings.devMode, // Start webcam as soon as dev mode enabled
    dutyCycle: { onMs: 0, offMs: 0 },
  });

  // Connect stream to preview video element
  useEffect(() => {
    const videoEl = webcamPreviewRef.current;
    if (videoEl && stream && videoEl.srcObject !== stream) {
      console.log("[SettingsPage] Connecting stream to preview video");
      videoEl.srcObject = stream;
      videoEl.play().catch((err) => {
        // Can happen during rapid remounts/navigation (e.g. React.StrictMode)
        if (
          err?.name === "AbortError" ||
          String(err?.message || "").includes(
            "The play() request was interrupted by a new load request",
          )
        ) {
          return;
        }
        console.error("[SettingsPage] Failed to play video:", err);
      });
    }
  }, [stream, webcamActive]);

  // Save settings whenever they change (for devMode to persist)
  // Only save after initial load to avoid overwriting persisted settings with defaults
  useEffect(() => {
    if (!settingsLoaded) return;

    const sanitized: SettingsData = {
      ...settings,
      pomodoroWorkMinutes: coerceInt(settings.pomodoroWorkMinutes, DEFAULT_POMODORO_WORK_MINUTES, 1, 240),
      pomodoroBreakMinutes: coerceInt(settings.pomodoroBreakMinutes, DEFAULT_POMODORO_BREAK_MINUTES, 1, 60),
      pomodoroIterations: coerceInt(settings.pomodoroIterations, DEFAULT_POMODORO_ITERATIONS, 1, 100),
      rewardPerCycle: coerceNumber(settings.rewardPerCycle, DEFAULT_REWARD_PER_CYCLE, 0, 1),
    };

    localStorage.setItem("focus-wizard-settings", JSON.stringify(sanitized));
    
    // Sync reward per cycle with backend
    if (sanitized.rewardPerCycle !== "" && sanitized.rewardPerCycle >= 0) {
      fetch(`${BACKEND_URL}/wallet/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rewardPerCycle: sanitized.rewardPerCycle }),
      }).catch((e) => console.error("Failed to sync reward config:", e));
    }
  }, [settings, settingsLoaded]);

  const fetchWalletStatus = useCallback(async () => {
    setWalletLoading(true);
    setWalletError(null);
    try {
      const resp = await fetch(`${BACKEND_URL}/wallet/status`);
      if (!resp.ok) throw new Error("Backend not reachable");
      const data = await resp.json();
      setWalletStatus(data);
    } catch (_e) {
      setWalletError("Cannot reach backend. Is the Deno server running?");
      setWalletStatus(null);
    } finally {
      setWalletLoading(false);
    }
  }, []);

  const handleOpenWalletPage = () => {
    window.focusWizard?.openWalletPage();
  };

  // Fetch wallet status on mount
  useEffect(() => {
    const savedSettings = localStorage.getItem("focus-wizard-settings");
    if (savedSettings) {
      try {
        const parsed: unknown = JSON.parse(savedSettings);
        const rest: Record<string, unknown> =
          parsed && typeof parsed === "object" ? { ...(parsed as Record<string, unknown>) } : {};

        // Ignore any legacy pomodoroEnabled flag; runtime state lives in pomodoro status.
        delete rest.pomodoroEnabled;

        setSettings({ ...DEFAULT_SETTINGS, ...(rest as Partial<SettingsData>) });
      } catch (e) {
        console.error("Failed to parse saved settings:", e);
      }
    }
    setSettingsLoaded(true);
    
    // Load reward per cycle from backend
    fetch(`${BACKEND_URL}/wallet/config`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (data && typeof data.rewardPerCycle === "number") {
          setSettings((prev) => ({
            ...prev,
            rewardPerCycle: data.rewardPerCycle,
          }));
        }
      })
      .catch((e) => {
        // Silently ignore if backend isn't running yet
        console.log("Backend config not available yet:", e);
      });
    // Load pomodoro status from localStorage
    const savedPomodoro = localStorage.getItem("focus-wizard-pomodoro-status");
    if (savedPomodoro) {
      try {
        const parsed = JSON.parse(savedPomodoro);
        setPomodoroStatus(parsed);
      } catch (e) {
        console.error("Failed to parse pomodoro status:", e);
      }
    }
    // Also fetch wallet status on mount
    fetchWalletStatus();

    // Listen for pomodoro status updates from main window
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "focus-wizard-pomodoro-status" && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue);
          setPomodoroStatus(parsed);
        } catch (err) {
          console.error("Failed to parse pomodoro status update:", err);
        }
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, [fetchWalletStatus]);

  // Fetch attentiveness score from Deno backend every 1s (strict interval)
  useEffect(() => {
    let cancelled = false;

    if (!settings.devMode) {
      setAttentiveness(null);
      setAttentivenessError(null);
      return;
    }

    const runOnce = async () => {
      if (cancelled) return;
      if (attentivenessInFlightRef.current) return;

      const currentFocusData = latestFocusDataRef.current;
      if (!currentFocusData) {
        setAttentiveness(null);
        return;
      }

      attentivenessInFlightRef.current = true;
      try {
        setAttentivenessError(null);
        const payload: GetAttentivenessRequest = {
          gaze_x: currentFocusData.gaze_x,
          gaze_y: currentFocusData.gaze_y,
          bridgeStatus: latestBridgeStatusRef.current,
          capturedAt: new Date().toISOString(),
        };

        const resp = await fetch(ATTENTIVENESS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) {
          throw new Error(`Backend error: ${resp.status}`);
        }

        const json = await resp.json();
        const parsed = getAttentivenessResponseSchema.safeParse(json);
        if (!parsed.success) {
          throw new Error("Invalid backend response");
        }

        if (!cancelled) setAttentiveness(parsed.data.attentiveness);
      } catch (e) {
        if (!cancelled) {
          setAttentiveness(null);
          setAttentivenessError(
            e instanceof Error ? e.message : "Failed to fetch attentiveness",
          );
        }
      } finally {
        attentivenessInFlightRef.current = false;
      }
    };

    void runOnce();
    const intervalId = window.setInterval(() => {
      void runOnce();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [settings.devMode]);

  // Subscribe to bridge events
  useEffect(() => {
    const api = window.wizardAPI;
    if (!api) return;

    // Check initial bridge status on mount
    api.getBridgeStatus().then(
      (status: { running: boolean; status?: string }) => {
        if (status.running) {
          setBridgeReady(true);
          setBridgeStatus(status.status || "Bridge ready");
        } else {
          setBridgeReady(false);
          setBridgeStatus(status.status || "Bridge stopped");
        }
      },
    ).catch(() => {
      setBridgeReady(false);
      setBridgeStatus("Bridge not initialized");
    });

    const unsubs = [
      api.onFocus((data: unknown) => {
        console.log("[SettingsPage] Focus data received:", data);
        setFocusData(data as FocusData);
      }),
      api.onMetrics((data: unknown) => {
        console.log("[SettingsPage] Metrics data received:", data);
        // Merge metrics into focus data if available
        if (data && typeof data === "object") {
          setFocusData((prev) => ({ ...prev, ...(data as Record<string, unknown>) } as FocusData));
        }
      }),
      api.onStatus((s: string) => setBridgeStatus(s)),
      api.onReady(() => {
        setBridgeReady(true);
        setBridgeStatus("Bridge ready");
        setAuthError(false); // Clear auth error on successful start
      }),
      api.onError((msg: string) => {
        console.error("[SettingsPage] Bridge error:", msg);
        setBridgeStatus(`Error: ${msg}`);

        // Check if it's an authentication/usage error
        if (
          msg.includes("Authentication failed") ||
          msg.includes("usage_available") ||
          msg.includes("Usage verification failed")
        ) {
          setAuthError(true);
          setBridgeReady(false);
          setBridgeStatus(
            "⚠️ API credits exhausted. Please add more usage credits to your SmartSpectra account.",
          );
        } else {
          setBridgeReady(false);
        }
      }),
      api.onClosed(() => {
        setBridgeReady(false);
        if (!authError) {
          setBridgeStatus("Bridge stopped");
        }
      }),
    ];

    return () => {
      unsubs.forEach((unsub) => unsub());
    };
  }, [authError]);

  // Start/stop bridge based on dev mode and webcam status
  useEffect(() => {
    const api = window.wizardAPI;
    if (!api) {
      console.error("[SettingsPage] wizardAPI not available");
      return;
    }

    console.log(
      `[SettingsPage] Dev mode: ${settings.devMode}, Webcam active: ${webcamActive}`,
    );

    if (settings.devMode && webcamActive && !authError) {
      // Only start bridge after webcam is actively capturing and no auth error
      console.log("[SettingsPage] Starting bridge...");
      // Check if Docker is available first
      api.checkDocker().then(({ available }: { available: boolean }) => {
        if (available) {
          console.log(
            "[SettingsPage] Docker available, waiting 500ms then starting bridge",
          );
          // Small delay to ensure frames are being written
          setTimeout(() => {
            api.startBridge().catch((err: Error) => {
              console.error("Failed to start bridge:", err);
              setBridgeStatus(`Failed to start: ${err.message}`);
            });
          }, 500);
        } else {
          console.error("[SettingsPage] Docker not available");
          setBridgeStatus("Docker not available");
        }
      });
    } else {
      // Stop bridge when dev mode is disabled
      if (bridgeReady) {
        console.log("[SettingsPage] Stopping bridge");
        api.stopBridge();
      }
    }
  }, [settings.devMode, webcamActive, bridgeReady, authError]);

  const handleCloseMenu = () => {
    // Persist immediately in case the user closes right after a change.
    const sanitized: SettingsData = {
      ...settings,
      pomodoroWorkMinutes: coerceInt(settings.pomodoroWorkMinutes, DEFAULT_POMODORO_WORK_MINUTES, 1, 240),
      pomodoroBreakMinutes: coerceInt(settings.pomodoroBreakMinutes, DEFAULT_POMODORO_BREAK_MINUTES, 1, 60),
      pomodoroIterations: coerceInt(settings.pomodoroIterations, DEFAULT_POMODORO_ITERATIONS, 1, 100),
      rewardPerCycle: coerceNumber(settings.rewardPerCycle, DEFAULT_REWARD_PER_CYCLE, 0, 1),
    };
    localStorage.setItem("focus-wizard-settings", JSON.stringify(sanitized));
    // Hide window instead of closing to keep monitoring active
    if (window.wizardAPI?.hideWindow) {
      window.wizardAPI.hideWindow();
    } else {
      window.close();
    }
  };



  const handleQuitApp = () => {
    window.focusWizard?.quitApp();
  };

  const handleRewardPerCycleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      setSettings({ ...settings, rewardPerCycle: "" });
    } else {
      const num = parseFloat(value);
      if (!isNaN(num) && num >= 0 && num <= 1) {
        setSettings({ ...settings, rewardPerCycle: num });
      }
    }
  };

  const handleRewardPerCycleBlur = async () => {
    const reward = coerceNumber(settings.rewardPerCycle, DEFAULT_REWARD_PER_CYCLE, 0, 1);

    if (settings.rewardPerCycle === "") {
      setSettings({ ...settings, rewardPerCycle: reward });
    }
    // Sync with backend
    try {
      await fetch(`${BACKEND_URL}/wallet/config`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rewardPerCycle: reward }),
      });
    } catch (e) {
      console.error("Failed to update reward config:", e);
    }
  };


  const handleWorkMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      setSettings({ ...settings, pomodoroWorkMinutes: "" });
    } else {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num > 0 && num <= 240) {
        setSettings({ ...settings, pomodoroWorkMinutes: num });
      }
    }
  };

  const handleBreakMinutesChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      setSettings({ ...settings, pomodoroBreakMinutes: "" });
    } else {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num > 0 && num <= 60) {
        setSettings({ ...settings, pomodoroBreakMinutes: num });
      }
    }
  };

  const handleWorkMinutesBlur = () => {
    if (Number(settings.pomodoroWorkMinutes) <= 0) {
      setSettings({
        ...settings,
        pomodoroWorkMinutes: DEFAULT_POMODORO_WORK_MINUTES,
      });
    }
  };

  const handleBreakMinutesBlur = () => {
    if (Number(settings.pomodoroBreakMinutes) <= 0) {
      setSettings({
        ...settings,
        pomodoroBreakMinutes: DEFAULT_POMODORO_BREAK_MINUTES,
      });
    }
  };

  const handleIterationsChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    if (value === "") {
      setSettings({ ...settings, pomodoroIterations: "" });
    } else {
      const num = parseInt(value, 10);
      if (!isNaN(num) && num > 0 && num <= 100) {
        setSettings({ ...settings, pomodoroIterations: num });
      }
    }
  };

  const handleIterationsBlur = () => {
    if (Number(settings.pomodoroIterations) <= 0) {
      setSettings({
        ...settings,
        pomodoroIterations: DEFAULT_POMODORO_ITERATIONS,
      });
    }
  };

  const handlePomodoroStart = () => {
    const workMinutes = coerceInt(settings.pomodoroWorkMinutes, DEFAULT_POMODORO_WORK_MINUTES, 1, 240);
    const newStatus: PomodoroStatus = {
      enabled: true,
      isRunning: true,
      isPaused: false,
      timeRemaining: workMinutes * 60,
      mode: "work" as const,
      iteration: 1,
      totalIterations: coerceInt(settings.pomodoroIterations, DEFAULT_POMODORO_ITERATIONS, 1, 100),
    };
    setPomodoroStatus(newStatus);
    localStorage.setItem("focus-wizard-pomodoro-status", JSON.stringify(newStatus));
  };

  const handlePomodoroPause = () => {
    const newStatus: PomodoroStatus = {
      ...pomodoroStatus,
      isPaused: true,
    };
    setPomodoroStatus(newStatus);
    localStorage.setItem("focus-wizard-pomodoro-status", JSON.stringify(newStatus));
  };

  const handlePomodoroResume = () => {
    const newStatus: PomodoroStatus = {
      ...pomodoroStatus,
      isPaused: false,
    };
    setPomodoroStatus(newStatus);
    localStorage.setItem("focus-wizard-pomodoro-status", JSON.stringify(newStatus));
  };

  const handlePomodoroRestart = () => {
    const workMinutes = coerceInt(settings.pomodoroWorkMinutes, DEFAULT_POMODORO_WORK_MINUTES, 1, 240);
    const newStatus: PomodoroStatus = {
      enabled: true,
      isRunning: true,
      isPaused: false,
      timeRemaining: workMinutes * 60,
      mode: "work" as const,
      iteration: 1,
      totalIterations: coerceInt(settings.pomodoroIterations, DEFAULT_POMODORO_ITERATIONS, 1, 100),
    };
    setPomodoroStatus(newStatus);
    localStorage.setItem("focus-wizard-pomodoro-status", JSON.stringify(newStatus));
  };

  const handlePomodoroStop = () => {
    const newStatus: PomodoroStatus = {
      enabled: false,
      isRunning: false,
      isPaused: false,
      timeRemaining: 0,
      mode: "work" as const,
      iteration: 1,
      totalIterations: coerceInt(settings.pomodoroIterations, DEFAULT_POMODORO_ITERATIONS, 1, 100),
    };
    setPomodoroStatus(newStatus);
    localStorage.setItem("focus-wizard-pomodoro-status", JSON.stringify(newStatus));
  };

  // Determine the pomodoro control state
  const isPomodoroRunning = pomodoroStatus.enabled && pomodoroStatus.isRunning && !pomodoroStatus.isPaused;
  const isPomodoroPaused = pomodoroStatus.enabled && pomodoroStatus.isRunning && pomodoroStatus.isPaused;
  const isPomodoroComplete = pomodoroStatus.enabled && !pomodoroStatus.isRunning && pomodoroStatus.timeRemaining === 0;
  const isPomodoroActive = pomodoroStatus.enabled && pomodoroStatus.isRunning; // running or paused

  const formatTime = (seconds: number): string => {
    const mins = Math.floor(Math.abs(seconds) / 60);
    const secs = Math.abs(seconds) % 60;
    const sign = seconds < 0 ? "-" : "";
    return `${sign}${mins}:${secs.toString().padStart(2, "0")}`;
  }

  const handleClick = (e: React.MouseEvent) => {
    const baseId = Date.now();
    const newSparkles: ClickSparkle[] = [];

    // Create 6 sparkles that spew outward in different directions
    for (let i = 0; i < 6; i++) {
      const angle = (i * 60) + (Math.random() - 0.5) * 30; // Evenly spread with some randomness
      const distance = 30 + Math.random() * 40; // Random distance between 30-70px

      newSparkles.push({
        id: baseId + i,
        x: e.clientX,
        y: e.clientY,
        angle,
        distance,
      });
    }

    setClickSparkles((prev) => [...prev, ...newSparkles]);

    // Remove sparkles after animation completes
    setTimeout(() => {
      setClickSparkles((prev) =>
        prev.filter((s) => s.id < baseId || s.id >= baseId + 6)
      );
    }, 1000);
  };

  return (
    <div className="settings-page" onClick={handleClick}>
      <div className="sparkle-background">
        {Array.from({ length: 15 }).map((_, i) => (
          <div
            key={i}
            className="sparkle-fall"
            style={{
              left: `${Math.random() * 100}%`,
              animationDelay: `${Math.random() * 5}s`,
              animationDuration: `${3 + Math.random() * 2}s`,
            }}
          >
            *
          </div>
        ))}
      </div>
      {clickSparkles.map((sparkle) => {
        const angleRad = (sparkle.angle * Math.PI) / 180;
        const offsetX = Math.cos(angleRad) * sparkle.distance;
        const offsetY = Math.sin(angleRad) * sparkle.distance;

        return (
          <div
            key={sparkle.id}
            className="sparkle-click"
            style={{
              left: `${sparkle.x}px`,
              top: `${sparkle.y}px`,
              "--offset-x": `${offsetX}px`,
              "--offset-y": `${offsetY}px`,
            } as React.CSSProperties}
          />
        );
      })}
      <div className="settings-panel standalone">
        <div className="settings-header">
          <h2>WIZARD SETTINGS</h2>
          {pomodoroStatus.enabled && (
            <div className="pomodoro-status-header">
              <div className={`pomodoro-indicator ${
                isPomodoroComplete ? "complete" :
                isPomodoroPaused ? "paused" :
                pomodoroStatus.isRunning ? "running" : "paused"
              }`} />
              <span className="pomodoro-mode">
                {isPomodoroComplete ? "Done" :
                 isPomodoroPaused ? "Paused" :
                 pomodoroStatus.mode === "work" ? "Focus" : "Rest"}
              </span>
              {!isPomodoroComplete && (
                <span className="pomodoro-timer">{formatTime(pomodoroStatus.timeRemaining)}</span>
              )}
              <span className="pomodoro-iteration">{pomodoroStatus.iteration}/{pomodoroStatus.totalIterations}</span>
            </div>
          )}
        </div>

        <div className="settings-content">
          <section className="settings-section">
            <div className="settings-section-header">
              <h3>Pomodoro Timer</h3>
              <div className="pomodoro-controls">
                {isPomodoroRunning ? (
                  <>
                    <button className="pomodoro-btn pomodoro-btn-pause" onClick={handlePomodoroPause}>
                      Pause
                    </button>
                    <button className="pomodoro-btn pomodoro-btn-stop" onClick={handlePomodoroStop}>
                      Stop
                    </button>
                  </>
                ) : isPomodoroPaused ? (
                  <>
                    <button className="pomodoro-btn pomodoro-btn-start" onClick={handlePomodoroResume}>
                      Resume
                    </button>
                    <button className="pomodoro-btn pomodoro-btn-restart" onClick={handlePomodoroRestart}>
                      Restart
                    </button>
                    <button className="pomodoro-btn pomodoro-btn-stop" onClick={handlePomodoroStop}>
                      Stop
                    </button>
                  </>
                ) : isPomodoroComplete ? (
                  <button className="pomodoro-btn pomodoro-btn-start" onClick={handlePomodoroStart}>
                    Restart
                  </button>
                ) : (
                  <button className="pomodoro-btn pomodoro-btn-start" onClick={handlePomodoroStart}>
                    Start
                  </button>
                )}
              </div>
            </div>
            <div className={`settings-field ${isPomodoroActive ? "disabled" : ""}`}>
              <label htmlFor="work-minutes">Focus Time (minutes)</label>
              <input
                id="work-minutes"
                type="number"
                min="1"
                max="240"
                value={settings.pomodoroWorkMinutes}
                onChange={handleWorkMinutesChange}
                onBlur={handleWorkMinutesBlur}
                disabled={isPomodoroActive}
              />
            </div>
            <div className={`settings-field ${isPomodoroActive ? "disabled" : ""}`}>
              <label htmlFor="break-minutes">Rest Time (minutes)</label>
              <input
                id="break-minutes"
                type="number"
                min="1"
                max="60"
                value={settings.pomodoroBreakMinutes}
                onChange={handleBreakMinutesChange}
                onBlur={handleBreakMinutesBlur}
                disabled={isPomodoroActive}
              />
            </div>
            <div className={`settings-field ${isPomodoroActive ? "disabled" : ""}`}>
              <label htmlFor="iterations">Number of Iterations</label>
              <input
                id="iterations"
                type="number"
                min="1"
                max="100"
                value={settings.pomodoroIterations}
                onChange={handleIterationsChange}
                onBlur={handleIterationsBlur}
                disabled={isPomodoroActive}
              />
            </div>
          </section>

          <section className="settings-section">
            <h3>Focus Prompts</h3>
            <div className="settings-field">
              <label htmlFor="positive-prompt">
                What should you be doing? (On-task)
              </label>
              <textarea
                id="positive-prompt"
                placeholder="e.g. studying for calculus, writing code, reading documentation"
                value={settings.positivePrompt}
                onChange={(e) =>
                  setSettings({ ...settings, positivePrompt: e.target.value })
                }
                rows={3}
                style={{ resize: "vertical" }}
              />
            </div>
            <div className="settings-field">
              <label htmlFor="negative-prompt">
                What should you avoid? (Off-task)
              </label>
              <textarea
                id="negative-prompt"
                placeholder="e.g. Instagram, Twitter, YouTube, Reddit"
                value={settings.negativePrompt}
                onChange={(e) =>
                  setSettings({ ...settings, negativePrompt: e.target.value })
                }
                rows={3}
                style={{ resize: "vertical" }}
              />
            </div>
          </section>


          <section className="settings-section">
            <div className="settings-section-header">
              <h3>Developer Settings</h3>
              <label className="toggle-switch">
                <input
                  id="dev-mode"
                  type="checkbox"
                  checked={settings.devMode}
                  onChange={(e) => {
                    setSettings({ ...settings, devMode: e.target.checked });
                    // Clear auth error when toggling to allow retry after adding credits
                    setAuthError(false);
                  }}
                />
                <span className="toggle-slider" />
              </label>
            </div>
            <div className="settings-field">
              <label htmlFor="dev-mode" style={{ cursor: "pointer" }}>
                Enable Dev Mode (Show Biometric Metrics)
              </label>
            </div>
          </section>

          {settings.devMode && (
            <section className="settings-section biometrics-section">
              <h3>🔬 Biometric Monitoring</h3>

              <div className="biometrics-status">
                <strong>Status:</strong> {bridgeStatus}
              </div>

              {webcamActive && (
                <div className="biometrics-grid">
                  <div className="camera-preview">
                    <video
                      ref={webcamPreviewRef}
                      autoPlay
                      playsInline
                      muted
                      style={{
                        width: "160px",
                        height: "120px",
                        borderRadius: "8px",
                        border: "2px solid #8b6bb7",
                        objectFit: "cover",
                        backgroundColor: "#000",
                      }}
                    />
                    <div className="camera-label">Camera</div>
                  </div>

                  {focusData && (
                    <div className="metrics-grid">
                      {/* <div className="metric-item">
                        <div className="metric-label">Pulse</div>
                        <div className="metric-value">
                          {focusData.pulse_bpm > 0
                            ? `${focusData.pulse_bpm.toFixed(1)} BPM`
                            : `N/A (${focusData.pulse_bpm})`}
                        </div>
                      </div>

                      <div className="metric-item">
                        <div className="metric-label">Breathing</div>
                        <div className="metric-value">
                          {focusData.breathing_bpm > 0
                            ? `${focusData.breathing_bpm.toFixed(1)} BPM`
                            : `N/A (${focusData.breathing_bpm})`}
                        </div>
                      </div> */}

                      <div className="metric-item">
                        <div className="metric-label">Face Found</div>
                        <div className="metric-value">
                          {bridgeStatus === "No faces found."
                            ? "✗ No"
                            : "✓ Yes"}
                          {/* scuffed up, but hey at least a human wrote this */}
                        </div>
                      </div>

                      <div className="metric-item">
                        <div className="metric-label">Is Away</div>
                        <div className="metric-value">
                          {bridgeStatus === "No issues detected."
                            ? "✗ No"
                            : "✓ Yes"}{" "}
                          {/* scuffed up? yeah. works? also yeah */}
                        </div>
                      </div>

                      <div className="metric-item">
                        <div className="metric-label">Is Talking</div>
                        <div className="metric-value">
                          {focusData.is_talking ? "✓ Yes" : `✗ No`}
                        </div>
                      </div>

                      {/* <div className="metric-item">
                        <div className="metric-label">Blink Rate</div>
                        <div className="metric-value">
                          {focusData.blink_rate_per_min > 0
                            ? `${focusData.blink_rate_per_min.toFixed(1)}/min`
                            : `N/A (${focusData.blink_rate_per_min})`}
                        </div>
                      </div> */}

                      <div className="metric-item">
                        <div className="metric-label">Gaze</div>
                        <div className="metric-value">
                          {
                              Number.isFinite(focusData.gaze_x) &&
                              Number.isFinite(focusData.gaze_y)
                              ? (focusData.gaze_x > .8 || focusData.gaze_x < -.8 || focusData.gaze_y > .8 || focusData.gaze_y < -.8) ? 
                                `Dosing off` : `Locked in`
                            // ? `(${focusData.gaze_x.toFixed(2)}, ${
                            //   focusData.gaze_y.toFixed(2)
                            // })`
                            : ""}
                        </div>
                      </div>

                      <div className="metric-item">
                        <div className="metric-label">Attentiveness</div>
                        <div className="metric-value">
                          {attentivenessError
                            ? `ERR`
                            : attentiveness === null
                            ? "--"
                            : attentiveness.toFixed(2)}
                        </div>
                      </div>
                    </div>
                  )}

                  {focusData && (
                    <details
                      style={{
                        marginTop: "1rem",
                        fontSize: "0.8rem",
                        color: "#aaa",
                      }}
                    >
                      <summary style={{ cursor: "pointer" }}>
                        Debug: Raw Data
                      </summary>
                      <pre
                        style={{
                          background: "#1a1a1a",
                          padding: "8px",
                          borderRadius: "4px",
                          overflow: "auto",
                          maxHeight: "200px",
                          fontSize: "0.7rem",
                        }}
                      >
                        {JSON.stringify(focusData, null, 2)}
                      </pre>
                    </details>
                  )}

                  {!focusData && (
                    <div className="metrics-loading">
                      <p>Waiting for biometric data...</p>
                    </div>
                  )}

                  {webcamError && (
                    <div className="metrics-error">
                      <p>⚠️ Webcam Error: {webcamError}</p>
                    </div>
                  )}
                </div>
              )}

              {!bridgeReady && settings.devMode && (
                <div className="biometrics-loading">
                  <p>Starting biometric monitoring...</p>
                  <p style={{ fontSize: "0.9em", opacity: 0.8 }}>
                    This may take a moment on first run while Docker image
                    builds.
                  </p>
                </div>
              )}
            </section>
          )}
          <section className="wallet-section">
            <h3>💰 Focus Vault</h3>
            {walletLoading && (
              <div className="wallet-status-msg info">
                Loading wallet status...
              </div>
            )}
            {walletError && (
              <div className="wallet-status-msg error">{walletError}</div>
            )}
            {walletStatus && (
              <>
                {/* Discrepancy warning */}
                {walletStatus.discrepancySol && Math.abs(walletStatus.discrepancySol) > 0.000001 && (
                  <div className="wallet-status-msg warning" style={{ marginBottom: '12px', padding: '8px 12px', background: '#3d3520', border: '1px solid #665a30', borderRadius: '6px', fontSize: '0.85em', color: '#e8d68a' }}>
                    {walletStatus.discrepancySol > 0
                      ? `Note: ${walletStatus.discrepancySol.toFixed(6)} SOL on-chain is not yet tracked. If you deposited externally, use the wallet page to register the deposit.`
                      : `Note: Tracked balance exceeds on-chain by ${Math.abs(walletStatus.discrepancySol).toFixed(6)} SOL (likely transaction fees).`
                    }
                  </div>
                )}
                {/* Earned Balance - Prominent Display */}
                <div className="wallet-balance-card earned">
                  <div className="wallet-balance-label">✨ AVAILABLE TO WITHDRAW</div>
                  <div className="wallet-balance-amount">
                    {(walletStatus.earnedBalanceSol || 0).toFixed(4)} <span className="sol-unit">SOL</span>
                  </div>
                  <div className="wallet-balance-usd">
                    ≈ ${(walletStatus.earnedBalanceUsd || 0).toFixed(2)} USD
                  </div>
                </div>

                {/* Vault Balance - Locked */}
                <div className="wallet-balance-card vault">
                  <div className="wallet-balance-label">🔒 IN VAULT (Complete pomodoro cycles to unlock)</div>
                  <div className="wallet-balance-amount vault-amount">
                    {(walletStatus.vaultBalanceSol || 0).toFixed(4)} <span className="sol-unit">SOL</span>
                  </div>
                  <div className="wallet-balance-usd vault-usd">
                    ≈ ${(walletStatus.vaultBalanceUsd || 0).toFixed(2)} USD
                  </div>
                  <div className="wallet-unlock-info">
                    {(walletStatus.vaultBalanceSol || 0) > 0 && (
                      <span>
                        Complete a cycle to unlock {(walletStatus.rewardPerCycle || 0.001).toFixed(4)} SOL 
                        (${(walletStatus.rewardPerCycleUsd || 0).toFixed(2)} USD)
                      </span>
                    )}
                    {walletStatus.vaultBalanceSol === 0 && (
                      <span>Deposit SOL to start earning through focus sessions</span>
                    )}
                  </div>
                </div>

                {/* Total Stats */}
                <div className="wallet-stats-row">
                  <div className="wallet-stat">
                    <span className="wallet-stat-label">Total Balance</span>
                    <span className="wallet-stat-value">{(walletStatus.totalBalanceSol || 0).toFixed(4)} SOL</span>
                    <span className="wallet-stat-usd">${(walletStatus.totalBalanceUsd || 0).toFixed(2)}</span>
                  </div>
                  <div className="wallet-stat">
                    <span className="wallet-stat-label">Cycles Completed</span>
                    <span className="wallet-stat-value cycles">{walletStatus.totalCyclesCompleted || 0}</span>
                  </div>
                </div>

                <div className="wallet-info-row compact">
                  <label>Vault Address</label>
                  <div className="wallet-address-display">
                    {walletStatus.vaultAddress || "Loading..."}
                  </div>
                </div>
                
                {walletStatus.connectedWallet && (
                  <div className="wallet-info-row compact">
                    <label>Connected Wallet</label>
                    <div className="wallet-address-display">
                      {walletStatus.connectedWallet}
                    </div>
                  </div>
                )}
              </>
            )}
            
            {/* Reward Configuration */}
            <div className="wallet-config-section">
              <label className="wallet-config-label">
                Reward per Pomodoro Cycle
              </label>
              <div className="wallet-config-input-group">
                <input
                  type="number"
                  min="0"
                  max="1"
                  step="0.001"
                  value={settings.rewardPerCycle}
                  onChange={handleRewardPerCycleChange}
                  onBlur={handleRewardPerCycleBlur}
                  className="wallet-config-input"
                />
                <span className="wallet-config-unit">SOL</span>
                <span className="wallet-config-usd">
                  ≈ ${(Number(settings.rewardPerCycle || 0) * (walletStatus?.solToUsdRate || 87.40)).toFixed(2)} USD
                </span>
              </div>
              <p className="wallet-config-hint">
                How much SOL you earn each time you complete a full pomodoro focus cycle
              </p>
            </div>
            
            <div className="wallet-actions">
              <button
                className="settings-button primary"
                onClick={handleOpenWalletPage}
                style={{ marginBottom: "8px" }}
              >
                Open Wallet in Browser
              </button>
              <button
                className="settings-button secondary"
                onClick={fetchWalletStatus}
                disabled={walletLoading}
              >
                Refresh Status
              </button>
            </div>
          </section>
        </div>

        <div className="settings-footer">
          <button
            className="settings-button neutral"
            onClick={handleCloseMenu}
          >
            Close Menu
          </button>
        </div>
        <div className="settings-footer-quit">
          <button
            className="settings-button danger quit-btn"
            onClick={handleQuitApp}
          >
            Quit App
          </button>
        </div>
      </div>
    </div>
  );
}
