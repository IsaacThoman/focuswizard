import { useEffect, useRef, useState, useCallback } from "react";
import {
  type GetProductivityConfidenceRequest,
  getProductivityConfidenceResponseSchema,
  type GetAttentivenessRequest,
  getAttentivenessResponseSchema,
} from "@shared/productivitySchemas";
import { SpriteManager, SpriteSheet, NumberRenderer } from "./sprites";
import type { NumberColor } from "./sprites";
import "./App.css";

const PRODUCTIVITY_ENDPOINT = "http://localhost:8000/getProductivityConfidence";
const ATTENTIVENESS_ENDPOINT = "http://localhost:8000/getAttentiveness";
const CANVAS_WIDTH = 80;
const CANVAS_HEIGHT = 120;
const HEAD_START_MS = 15_000;
const ANGRY_VOICE_COOLDOWN_MS = 8_000;
const MODEL_VOICE_LINE_STALE_MS = 30_000;
const HAPPY_CONFIDENCE_THRESHOLD = 0.8;
const OFF_TASK_CONFIDENCE_THRESHOLD = 0.5;

export type WizardEmotion = "happy" | "neutral" | "mad";

const EMOTION_ROW: Record<WizardEmotion, number> = {
  happy: 1,
  neutral: 2,
  mad: 0,
};

// Break-mode wizard animation rows
const WIZARD_ROW_FALL_ASLEEP = 3; // Play once when entering break
const WIZARD_ROW_SLEEPING = 4;    // Loop during break

interface PomodoroSettings {
  pomodoroWorkMinutes: number
  pomodoroBreakMinutes: number
  pomodoroIterations: number
}

interface PomodoroState {
  enabled: boolean
  isRunning: boolean
  isPaused: boolean
  timeRemaining: number
  mode: 'work' | 'break'
  iteration: number
  totalIterations: number
}

/** Load an image from a URL and return a promise that resolves when loaded. */
function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function spriteUrl(filename: string): string {
  return new URL(`./sprites/${filename}`, window.location.href).toString();
}

function App() {
  const sessionStartAtRef = useRef<number>(Date.now());
  const [, setProductivityConfidence] = useState<
    number | null
  >(null);
  const [, setAttentiveness] = useState<number | null>(null);
  const [bridgeStatus, setBridgeStatus] = useState<string>("");
  const productivityConfidenceRef = useRef<number | null>(null);
  const attentivenessRef = useRef<number | null>(null);
  const lastConfidenceAtRef = useRef<number>(0);
  const halfAttentiveSinceRef = useRef<number | null>(null);
  const latestGazeRef = useRef<{ gaze_x: number; gaze_y: number } | null>(null);
  const attentivenessInFlightRef = useRef(false);
  const everSeenFaceRef = useRef(false);
  const lastFaceSeenAtRef = useRef<number>(0);
  const awayOverrideRef = useRef(false);
  const [emotion, setEmotion] = useState<WizardEmotion>("happy");
  const emotionRef = useRef<WizardEmotion>("happy");
  const lastAngrySpokenAtRef = useRef<number>(0);
  const latestModelVoiceLineRef = useRef<string>("");
  const lastModelVoiceLineAtRef = useRef<number>(0);
  const angryAudioRef = useRef<HTMLAudioElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const screenshotInFlightRef = useRef(false);
  const spriteManagerRef = useRef<SpriteManager | null>(null);
  const numberRendererRef = useRef<NumberRenderer | null>(null);
  const animFrameRef = useRef<number>(0);

  // Pomodoro timer state — always starts fresh (no persistence across app restarts)
  const [pomodoroState, setPomodoroState] = useState<PomodoroState>({
    enabled: false,
    isRunning: false,
    isPaused: false,
    timeRemaining: 25 * 60,
    mode: "work",
    iteration: 1,
    totalIterations: 4,
  });
  const pomodoroIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const lastTickRef = useRef<number>(Date.now());
  const pomodoroStateRef = useRef(pomodoroState);
  const cycleCompletionInFlightRef = useRef(false);
  /** Whether the wizard is currently playing a break transition animation */
  const breakTransitionRef = useRef(false);

  // Spell-cast state: active during "mad" emotion in work sessions
  const spellCastingRef = useRef(false);
  const [isSpellCasting, setIsSpellCasting] = useState(false);
  const spellStartTimeRef = useRef<number>(0); // Date.now() when spell started
  const SPELL_MIN_DURATION_MS = 2_000; // Prevent rapid flicker on/off
  const spellDismissTimeoutRef = useRef<number | null>(null);

  const handleWandHover = (hovering: boolean) => {
    const manager = spriteManagerRef.current;
    if (!manager) return;
    // Don't override wand row during spell cast
    if (spellCastingRef.current) return;
    const wand = manager.get("wand");
    if (wand && wand.kind === "animated") {
      wand.row = hovering ? 1 : 0;
      wand.colCount = 2; // Rows 0 and 1 both have 2 frames
    }
  };

  // Keep pomodoroStateRef in sync for the draw loop
  useEffect(() => {
    pomodoroStateRef.current = pomodoroState;
  }, [pomodoroState]);

  // Track whether the wizard should be sleeping (break, paused, inactive, or completed)
  const prevShouldSleepRef = useRef(false);

  // Determine if wizard should be sleeping: break mode, paused, not running, or not enabled
  const shouldWizardSleepRaw = pomodoroState.enabled
    ? (pomodoroState.mode === "break" || pomodoroState.isPaused || !pomodoroState.isRunning)
    : true; // Always sleep when pomodoro is not enabled

  // Never fall asleep while the spell/fireworks are active.
  const shouldWizardSleep = shouldWizardSleepRaw && !isSpellCasting;

  // Detect sleep state transitions and play sleep/wake animations
  useEffect(() => {
    const wasSleeping = prevShouldSleepRef.current;
    prevShouldSleepRef.current = shouldWizardSleep;

    if (wasSleeping === shouldWizardSleep) return;

    const manager = spriteManagerRef.current;
    if (!manager) return;
    const wizard = manager.get("wizard");
    if (!wizard || wizard.kind !== "animated") return;

    const wand = manager.get("wand");

    if (shouldWizardSleep) {
      // Hide wand while sleeping
      if (wand && wand.kind === "animated") wand.visible = false;

      // Entering sleep: play "fall asleep" row once, then loop "sleeping"
      breakTransitionRef.current = true;
      wizard.row = WIZARD_ROW_FALL_ASLEEP;
      wizard.reverse = false;
      wizard._col = 0;
      wizard._elapsed = 0;
      wizard.loop = false;
      wizard.playing = true;
      wizard.onComplete = () => {
        // Transition to sleeping loop
        wizard.row = WIZARD_ROW_SLEEPING;
        wizard._col = 0;
        wizard._elapsed = 0;
        wizard.loop = true;
        wizard.playing = true;
        wizard.reverse = false;
        wizard.onComplete = null;
        breakTransitionRef.current = false;
      };
    } else {
      // Waking up: play "fall asleep" row in reverse (wake up),
      // then return to the current emotion row
      breakTransitionRef.current = true;
      wizard.row = WIZARD_ROW_FALL_ASLEEP;
      wizard.reverse = true;
      wizard._col = wizard.sheet.framesPerRow - 1;
      wizard._elapsed = 0;
      wizard.loop = false;
      wizard.playing = true;
      wizard.onComplete = () => {
        // Show wand again when awake
        const w = manager.get("wand");
        if (w && w.kind === "animated") w.visible = true;

        // Return to normal emotion-based animation
        wizard.row = EMOTION_ROW[emotionRef.current];
        wizard._col = 0;
        wizard._elapsed = 0;
        wizard.loop = true;
        wizard.playing = true;
        wizard.reverse = false;
        wizard.onComplete = null;
        breakTransitionRef.current = false;
      };
    }
  }, [shouldWizardSleep]);

  const handleWandAreaClick = () => {
    window.focusWizard?.openSettings();
  };

  // Dismiss the spell-cast effect: tells main process to fade out overlay
  const dismissSpellCast = useCallback(() => {
    if (!spellCastingRef.current) return;
    spellCastingRef.current = false;
    setIsSpellCasting(false);

    // Tell main process to dismiss (fade out) the overlay
    window.focusWizard?.dismissSpell();

    // Restore wand to idle row (row 0, 2 frames)
    const manager = spriteManagerRef.current;
    if (manager) {
      const wand = manager.get("wand");
      if (wand && wand.kind === "animated") {
        wand.row = 0;
        wand.colCount = 2;
        wand.fps = 2;
        wand._col = 0;
        wand._elapsed = 0;
      }
    }
  }, [])

  const tryDismissSpell = useCallback(() => {
    dismissSpellCast();
  }, [dismissSpellCast]);

  const applyEmotionFromSignals = useCallback((): WizardEmotion => {
    const now = Date.now();
    const conf = productivityConfidenceRef.current;
    const attn = attentivenessRef.current;

    // Head start: give the user a short grace period at session start.
    // During this window, don't let any signals force negative emotion.
    if (now - sessionStartAtRef.current < HEAD_START_MS) {
      halfAttentiveSinceRef.current = null;
      const nextEmotion: WizardEmotion = "happy";
      setEmotion(nextEmotion);
      return nextEmotion;
    }

    // Away override: if the user is gone, always be mad.
    if (awayOverrideRef.current) {
      const nextEmotion: WizardEmotion = "mad";
      setEmotion(nextEmotion);
      return nextEmotion;
    }

    // Attentiveness override rules
    if (attn === 0) {
      const nextEmotion: WizardEmotion = "mad";
      setEmotion(nextEmotion);
      return nextEmotion;
    }

    if (attn === 0.5) {
      if (halfAttentiveSinceRef.current === null) {
        halfAttentiveSinceRef.current = now;
      }
      if (now - halfAttentiveSinceRef.current >= 4000) {
        const nextEmotion: WizardEmotion = "neutral";
        setEmotion(nextEmotion);
        return nextEmotion;
      }
    } else {
      halfAttentiveSinceRef.current = null;
    }

    // Prefer confidence if it's recent; otherwise fall back to attentiveness.
    const confidenceIsFresh = conf !== null && (now - lastConfidenceAtRef.current) < 15000;

    if (confidenceIsFresh) {
      const nextEmotion: WizardEmotion = conf >= HAPPY_CONFIDENCE_THRESHOLD
        ? "happy"
        : conf >= OFF_TASK_CONFIDENCE_THRESHOLD
        ? "neutral"
        : "mad";
      setEmotion(nextEmotion);
      return nextEmotion;
    }

    if (attn === 1) {
      const nextEmotion: WizardEmotion = "happy";
      setEmotion(nextEmotion);
      return nextEmotion;
    } else if (attn === 0.5) {
      // If we're here, it hasn't been 4s yet—don't force neutral early.
      const nextEmotion = emotionRef.current;
      setEmotion(nextEmotion);
      return nextEmotion;
    } else if (attn === 0) {
      const nextEmotion: WizardEmotion = "mad";
      setEmotion(nextEmotion);
      return nextEmotion;
    }
    return emotionRef.current;
  }, []);

  const normalizeSpeechText = useCallback((text: string): string => {
    return text.replace(/\s+/g, " ").trim().slice(0, 280);
  }, []);

  const getFreshModelVoiceLine = useCallback((): string | null => {
    if (Date.now() - lastModelVoiceLineAtRef.current > MODEL_VOICE_LINE_STALE_MS) {
      return null;
    }

    const text = normalizeSpeechText(latestModelVoiceLineRef.current);
    return text || null;
  }, [normalizeSpeechText]);

  const buildFallbackAngrySpeechText = useCallback((): string => {
    const now = Date.now();

    const distraction = (() => {
      if (awayOverrideRef.current) return "vanishing";
      const attn = attentivenessRef.current;
      const conf = productivityConfidenceRef.current;

      if (attn === 0) return "wandering eyes";
      if (attn === 0.5) return "daydreaming";
      if (conf !== null && conf < OFF_TASK_CONFIDENCE_THRESHOLD) return "that shiny side-quest";
      return "distractions";
    })();

    const sayings = [
      `On ${distraction} again, are we? Back to the task now.`,
      "You must return to your duties.",
      "Fooooocus, apprentice. One minute of effort now.",
      "No side quests. One task. One breath. Go.",
      `${distraction} is a distraction. Banish it and resume.`,
    ];

    const idx = Math.floor(now / 10_000) % sayings.length;
    const base = sayings[idx] || sayings[0];
    return normalizeSpeechText(base);
  }, [normalizeSpeechText]);

  const speakAngryNudge = useCallback(async (preferredText?: string) => {
    const text = normalizeSpeechText(
      preferredText || getFreshModelVoiceLine() || buildFallbackAngrySpeechText(),
    );
    if (!text) return;

    const api = window.wizardAPI;
    if (!api?.speak) return;

    console.log("[TTS] requesting speech:", text);
    const result = await api.speak(text);
    if (!result.ok) {
      console.warn("[TTS] speak failed:", result.error);
      return;
    }

    try {
      // Stop any previous utterance.
      angryAudioRef.current?.pause();
      angryAudioRef.current = null;

      // Preferred: main process returns a file:// URL to a cached MP3.
      // Fallback: if an older implementation returns raw bytes, play via Blob.
      let audio: HTMLAudioElement;
      let blobUrl: string | null = null;

      if (typeof (result as any).url === "string") {
        audio = new Audio((result as any).url);
      } else if ((result as any).audio != null) {
        const raw: unknown = (result as any).audio;

        const toBytes = (value: unknown): Uint8Array | null => {
          if (value instanceof Uint8Array) return value;
          if (value instanceof ArrayBuffer) return new Uint8Array(value);

          // Some serializers turn Buffer into { type: 'Buffer', data: number[] }
          if (
            typeof value === "object" &&
            value !== null &&
            (value as any).type === "Buffer" &&
            Array.isArray((value as any).data)
          ) {
            return Uint8Array.from((value as any).data);
          }

          if (Array.isArray(value) && value.every((n) => typeof n === "number")) {
            return Uint8Array.from(value);
          }

          // ArrayBuffer views (DataView, etc.)
          if (ArrayBuffer.isView(value)) {
            const v = value as ArrayBufferView;
            return new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
          }

          return null;
        };

        const bytes = toBytes(raw);
        if (!bytes) {
          console.warn("[TTS] speak returned ok but audio was unrecognized", raw);
          return;
        }

        // Copy to a new Uint8Array so it's backed by a normal ArrayBuffer.
        const audioBytes = new Uint8Array(bytes.byteLength);
        audioBytes.set(bytes);
        const blob = new Blob([audioBytes], {
          type: (result as any).mimeType || "audio/mpeg",
        });
        blobUrl = URL.createObjectURL(blob);
        audio = new Audio(blobUrl);
      } else {
        console.warn("[TTS] speak returned ok but no playable payload", result);
        return;
      }

      audio.preload = "auto";
      audio.volume = 1;
      audio.muted = false;
      audio.oncanplay = () => console.log("[TTS] canplay");
      audio.onended = () => {
        console.log("[TTS] ended");
        if (blobUrl) URL.revokeObjectURL(blobUrl);
      };
      audio.onerror = () => console.warn("[TTS] media error", audio.error);
      angryAudioRef.current = audio;
      audio.load();
      await audio.play();
      console.log("[TTS] playing");
    } catch (e) {
      console.warn("[TTS] audio playback failed:", e);
    }
  }, [buildFallbackAngrySpeechText, getFreshModelVoiceLine, normalizeSpeechText]);

  // When emotion changes, update the wizard sprite's active row and play poof
  useEffect(() => {
    const prevEmotion = emotionRef.current;
    emotionRef.current = emotion;
    const manager = spriteManagerRef.current;
    if (!manager) return;

    // Don't change wizard row during sleep or transitions
    const isSleeping = prevShouldSleepRef.current;
    const isTransitioning = breakTransitionRef.current;

    const wizard = manager.get("wizard");
    if (wizard && wizard.kind === "animated" && !isSleeping && !isTransitioning) {
      wizard.row = EMOTION_ROW[emotion];
    }

    // Play poof overlay on emotion transitions (skip initial mount)
      if (prevEmotion !== emotion) {
      const poof = manager.get("poof");
      if (poof && poof.kind === "animated") {
        // Row 0 = angry poof at 8fps, Row 1 = other transitions at 6fps
        const isAngryTransition = emotion === "mad";
        poof.row = isAngryTransition ? 0 : 1;
        poof.fps = isAngryTransition ? 8 : 6;
        poof._col = 0;
        poof._elapsed = 0;
        poof.playing = true;
        poof.visible = true;
      }

      // Speak a short focus nudge when we transition into angry.
      if (emotion === "mad") {
        const now = Date.now();
        if (now - lastAngrySpokenAtRef.current >= ANGRY_VOICE_COOLDOWN_MS) {
          lastAngrySpokenAtRef.current = now;
          void speakAngryNudge();
        }
      }

      if (prevEmotion === "mad" && emotion !== "mad") {
        tryDismissSpell();
      }
    }
      
    
    
  }, [emotion, speakAngryNudge, tryDismissSpell]);

  // Load pomodoro settings from localStorage
  const loadPomodoroSettings = useCallback((): PomodoroSettings => {
    const saved = localStorage.getItem("focus-wizard-settings");
    const defaults: PomodoroSettings = {
      pomodoroWorkMinutes: 25,
      pomodoroBreakMinutes: 5,
      pomodoroIterations: 4,
    };

    const coerceInt = (val: unknown, fallback: number, min: number, max: number) => {
      const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
      if (!Number.isFinite(n)) return fallback;
      return Math.min(max, Math.max(min, Math.round(n)));
    };

    if (saved) {
      try {
        const parsed = JSON.parse(saved) ?? {};
        return {
          ...defaults,
          pomodoroWorkMinutes: coerceInt(parsed.pomodoroWorkMinutes, defaults.pomodoroWorkMinutes, 1, 240),
          pomodoroBreakMinutes: coerceInt(parsed.pomodoroBreakMinutes, defaults.pomodoroBreakMinutes, 1, 60),
          pomodoroIterations: coerceInt(parsed.pomodoroIterations, defaults.pomodoroIterations, 1, 100),
        };
      } catch (e) {
        console.error("Failed to parse pomodoro settings:", e);
      }
    }
    return defaults;
  }, [])

  // Save pomodoro state to localStorage (for settings window to read)
  const savePomodoroState = useCallback((state: PomodoroState) => {
    localStorage.setItem("focus-wizard-pomodoro-status", JSON.stringify(state));
  }, [])

  // Complete a pomodoro cycle - notify backend to move SOL from vault to earned
  const completePomodoroCycle = useCallback(async () => {
    // Guard against duplicate fires (React strict mode, rapid timer ticks)
    if (cycleCompletionInFlightRef.current) {
      console.log("Cycle completion already in flight, skipping duplicate");
      return;
    }
    cycleCompletionInFlightRef.current = true;

    try {
      const response = await fetch("http://localhost:8000/wallet/complete-cycle", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      
      if (!response.ok) {
        const errData = await response.json().catch(() => ({}));
        console.warn(
          `Cycle completion failed (${response.status}):`,
          errData.error || "Unknown error"
        );
        return;
      }

      const data = await response.json();
      
      if (data.success) {
        console.log(
          `Pomodoro cycle completed! Earned ${data.rewardAmount} SOL` +
          (data.earnedUsd != null ? ` ($${data.earnedUsd.toFixed(2)} USD)` : "") +
          `. Total earned: ${(data.earnedBalance ?? 0).toFixed(4)} SOL`
        );
      } else {
        console.log("Cycle completed but no SOL moved:", data.error || "Unknown reason");
      }
    } catch (error) {
      console.error("Failed to complete pomodoro cycle:", error);
    } finally {
      cycleCompletionInFlightRef.current = false;
    }
  }, [])

  // Trigger the wizard spell-cast effect (fullscreen fireworks overlay)
  // The spell persists until dismissSpellCast is called.
  const triggerSpellCast = useCallback(() => {
    if (spellCastingRef.current) return;
    spellCastingRef.current = true;
    setIsSpellCasting(true);
    spellStartTimeRef.current = Date.now();

    // Set wand to casting row during spell (row 2, 4 frames)
    const manager = spriteManagerRef.current;
    if (manager) {
      const wand = manager.get("wand");
      if (wand && wand.kind === "animated") {
        wand.row = 2;
        wand.colCount = 4;
        wand.fps = 5;
        wand._col = 0;
        wand._elapsed = 0;
      }
    }

    // Launch the fullscreen spell overlay window
    window.focusWizard?.triggerSpell();
  }, [])

  const pomodoroEnabled = pomodoroState.enabled;
  const pomodoroIsRunning = pomodoroState.isRunning;
  const pomodoroIsPaused = pomodoroState.isPaused;
  const pomodoroMode = pomodoroState.mode;
  const pomodoroTimeRemaining = pomodoroState.timeRemaining;

  // Keep spell overlay in sync with "mad" emotion during active work sessions.
  // If the wizard is mad when a session starts (or becomes mad mid-session), start casting.
  // When no longer maxed+mad, dismiss quickly (with a tiny min duration to prevent flicker).
  useEffect(() => {
    const settings = loadPomodoroSettings();
    const maxPenalty = settings.pomodoroWorkMinutes * 60;

    const sessionActiveWork =
      pomodoroEnabled &&
      pomodoroIsRunning &&
      !pomodoroIsPaused &&
      pomodoroMode === "work";

    const shouldSpellBeActive =
      emotion === "mad" &&
      sessionActiveWork &&
      maxPenalty > 0 &&
      pomodoroTimeRemaining >= maxPenalty;

    if (shouldSpellBeActive) {
      if (spellDismissTimeoutRef.current !== null) {
        window.clearTimeout(spellDismissTimeoutRef.current);
        spellDismissTimeoutRef.current = null;
      }
      triggerSpellCast();
      return;
    }

    if (!spellCastingRef.current) return;

    const elapsed = Date.now() - spellStartTimeRef.current;
    const remaining = Math.max(0, SPELL_MIN_DURATION_MS - elapsed);

    if (spellDismissTimeoutRef.current !== null) {
      window.clearTimeout(spellDismissTimeoutRef.current);
      spellDismissTimeoutRef.current = null;
    }

    if (remaining === 0) {
      dismissSpellCast();
      return;
    }

    spellDismissTimeoutRef.current = window.setTimeout(() => {
      spellDismissTimeoutRef.current = null;
      dismissSpellCast();
    }, remaining + 25);
  }, [emotion, pomodoroEnabled, pomodoroIsRunning, pomodoroIsPaused, pomodoroMode, pomodoroTimeRemaining, loadPomodoroSettings, triggerSpellCast, dismissSpellCast]);

  // Cleanup any pending dismiss timer on unmount.
  useEffect(() => {
    return () => {
      if (spellDismissTimeoutRef.current !== null) {
        window.clearTimeout(spellDismissTimeoutRef.current);
        spellDismissTimeoutRef.current = null;
      }
    };
  }, []);

  // Handle timer tick - counts down when happy/neutral, up when mad (work mode only)
  // During break mode, always counts down regardless of emotion
  const handleTimerTick = useCallback(() => {
    const now = Date.now();
    const elapsed = Math.floor((now - lastTickRef.current) / 1000);
    if (elapsed <= 0) return;
    // Only advance by the whole seconds consumed, preserving the sub-second remainder
    lastTickRef.current += elapsed * 1000;

    const currentEmotion = emotionRef.current;

    setPomodoroState((prev) => {
      if (!prev.enabled || !prev.isRunning || prev.isPaused) return prev;

      let newTimeRemaining = prev.timeRemaining;

      if (prev.mode === "break") {
        // During break, always count down - user should rest freely
        newTimeRemaining = Math.max(0, prev.timeRemaining - elapsed);
      } else {
        // During work: count down when happy/neutral, count up when mad (penalty)
        if (currentEmotion === "happy" || currentEmotion === "neutral") {
          newTimeRemaining = Math.max(0, prev.timeRemaining - elapsed);
        } else {
          // When mad, add time (penalty)
          const workMinutes = loadPomodoroSettings().pomodoroWorkMinutes;
          const maxPenalty = workMinutes * 60; // Cap at work session length
          newTimeRemaining = Math.min(maxPenalty, prev.timeRemaining + elapsed);
        }
      }

      // Check if timer completed (reached zero)
      if (newTimeRemaining === 0) {
        // During work mode, don't complete if user is currently "mad" 
        // (they need to get back on task first)
        if (prev.mode === "work" && currentEmotion === "mad") {
          const newState = { ...prev, timeRemaining: newTimeRemaining };
          savePomodoroState(newState);
          return newState;
        }

        // Switch modes
        const newMode = prev.mode === "work" ? "break" : "work";
        const settings = loadPomodoroSettings();

        // If we just finished a break, increment iteration
        const newIteration = prev.mode === "break"
          ? prev.iteration + 1
          : prev.iteration;

        // When a work session completes successfully, move SOL from vault to earned
        if (prev.mode === "work") {
          void completePomodoroCycle();
        }

        // Stop if all iterations are complete (finished last break)
        if (newIteration > prev.totalIterations) {
          const doneState: PomodoroState = {
            ...prev,
            isRunning: false,
            isPaused: false,
            timeRemaining: 0,
            mode: "work",
            iteration: prev.totalIterations,
          };
          savePomodoroState(doneState);
          return doneState;
        }

        // If we just finished the last work session, go to break
        // but if we just finished the last break, we already handled it above
        const newTime = newMode === "work"
          ? settings.pomodoroWorkMinutes * 60
          : settings.pomodoroBreakMinutes * 60;

        const newState: PomodoroState = {
          ...prev,
          timeRemaining: newTime,
          mode: newMode,
          iteration: newIteration,
        };
        savePomodoroState(newState);
        return newState;
      }

      const newState = { ...prev, timeRemaining: newTimeRemaining };
      savePomodoroState(newState);
      return newState;
    });
  }, [loadPomodoroSettings, savePomodoroState, completePomodoroCycle])

  // Keep a ref to the latest handleTimerTick so the interval always calls the latest version
  const handleTimerTickRef = useRef(handleTimerTick);
  useEffect(() => {
    handleTimerTickRef.current = handleTimerTick;
  }, [handleTimerTick]);

  // Initialize pomodoro state on mount — always starts fresh, no persistence
  useEffect(() => {
    const settings = loadPomodoroSettings();
    const freshState: PomodoroState = {
      enabled: false,
      isRunning: false,
      isPaused: false,
      timeRemaining: settings.pomodoroWorkMinutes * 60,
      mode: "work",
      iteration: 1,
      totalIterations: settings.pomodoroIterations,
    };
    setPomodoroState(freshState);
    savePomodoroState(freshState);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Run the pomodoro timer interval (stable, runs once)
  useEffect(() => {
    lastTickRef.current = Date.now();

    // Start the timer interval — uses ref so callback identity never causes re-setup
    pomodoroIntervalRef.current = setInterval(() => {
      handleTimerTickRef.current();
    }, 1000);

    return () => {
      if (pomodoroIntervalRef.current) {
        clearInterval(pomodoroIntervalRef.current);
      }
    };
  }, []);

  // Listen for settings changes and pomodoro control actions from storage events
  useEffect(() => {
    const handleStorageChange = (e: StorageEvent) => {
      if (e.key === "focus-wizard-settings" && e.newValue) {
        try {
          const parsed = JSON.parse(e.newValue) ?? {};

          const coerceInt = (val: unknown, fallback: number, min: number, max: number) => {
            const n = typeof val === "number" ? val : typeof val === "string" ? Number(val) : NaN;
            if (!Number.isFinite(n)) return fallback;
            return Math.min(max, Math.max(min, Math.round(n)));
          };

          const settings = {
            workMinutes: coerceInt(parsed.pomodoroWorkMinutes, 25, 1, 240),
            breakMinutes: coerceInt(parsed.pomodoroBreakMinutes, 5, 1, 60),
            iterations: coerceInt(parsed.pomodoroIterations, 4, 1, 100),
          };

          setPomodoroState((prev) => {
            const next: PomodoroState = {
              ...prev,
              totalIterations: settings.iterations,
            };

            // Keep iteration within bounds if the user reduces total iterations.
            if (next.iteration > next.totalIterations) {
              next.iteration = next.totalIterations;
            }

            // Only adjust the displayed time when the timer isn't actively running.
            if (!prev.isRunning) {
              next.timeRemaining = (prev.mode === "break" ? settings.breakMinutes : settings.workMinutes) * 60;
            }

            savePomodoroState(next);
            return next;
          });
        } catch (err) {
          console.error("Failed to parse settings update:", err);
        }
      }

      // Handle pomodoro control actions from settings window
      if (e.key === "focus-wizard-pomodoro-status" && e.newValue) {
        try {
          const status = JSON.parse(e.newValue);
          setPomodoroState((prev) => {
            // Accept the state from settings window for control actions
            // (pause, resume, restart, start, stop)
            const newState: PomodoroState = {
              ...prev,
              ...status,
            };
            return newState;
          });
        } catch (err) {
          console.error("Failed to parse pomodoro status update:", err);
        }
      }
    };
    window.addEventListener("storage", handleStorageChange);
    return () => window.removeEventListener("storage", handleStorageChange);
  }, [savePomodoroState])

  // Main render loop: sets up the SpriteManager, loads sprites, runs animation
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.width = CANVAS_WIDTH;
    canvas.height = CANVAS_HEIGHT;

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    ctx.imageSmoothingEnabled = false;

    const manager = new SpriteManager(CANVAS_WIDTH, CANVAS_HEIGHT);
    spriteManagerRef.current = manager;

    let cancelled = false;

    const setup = async () => {
      try {
        // Load pot sprite sheet (320x128, 80x128 frames = 4 frames in a row)
        const potImg = await loadImage(spriteUrl("pot-sheet.png"));
        if (cancelled) return;

        const potSheet = new SpriteSheet(potImg, 80, 128, { frameCount: 4 });
        const potX = Math.floor((CANVAS_WIDTH - 80) / 2);
        const potY = CANVAS_HEIGHT - 128;
        manager.addAnimated("pot", potSheet, potX, potY, {
          fps: 5,
          loop: true,
          playing: true,
          z: 0,
        });

        // Load wizard sprite sheet (400x640, 80x128 frames = 5 cols x 5 rows)
        // Rows: 0=mad, 1=happy, 2=neutral, 3=fall asleep (transition), 4=sleeping (loop)
        const wizardImg = await loadImage(spriteUrl("wizard-sprites.png"));
        if (cancelled) return;

        const wizardSheet = new SpriteSheet(wizardImg, 80, 128);
        const wizX = Math.floor((CANVAS_WIDTH - 80) / 2);
        const wizY = CANVAS_HEIGHT - 128;
        // Start wizard in sleeping state since pomodoro starts inactive
        manager.addAnimated("wizard", wizardSheet, wizX, wizY, {
          fps: 5,
          loop: true,
          playing: true,
          row: WIZARD_ROW_SLEEPING,
          z: 1,
        });

        // Load wand-hand sprite sheet (320x384, 80x128 frames = 4 cols x 3 rows)
        // Row 0 = idle wand (2 frames), Row 1 = sparkle wand on hover (2 frames), Row 2 = casting wand (4 frames)
        const wandImg = await loadImage(spriteUrl("wand-hand.png"));
        if (cancelled) return;

        const wandSheet = new SpriteSheet(wandImg, 80, 128);
        const wandX = Math.floor((CANVAS_WIDTH - 80) / 2);
        const wandY = CANVAS_HEIGHT - 128;
        manager.addAnimated("wand", wandSheet, wandX, wandY, {
          fps: 2,
          loop: true,
          playing: true,
          visible: false, // Start hidden since wizard starts sleeping
          row: 0,
          colCount: 2, // Rows 0 and 1 only have 2 frames
          z: 2,
        });

        // Load poof sprite sheet (480x256, 80x128 frames = 6 cols x 2 rows)
        // Row 0 = angry transition poof (smoke), Row 1 = other transitions (sparkle)
        const poofImg = await loadImage(spriteUrl("wizard-poof.png"));
        if (cancelled) return;

        const poofSheet = new SpriteSheet(poofImg, 80, 128);
        const poofX = Math.floor((CANVAS_WIDTH - 80) / 2);
        const poofY = CANVAS_HEIGHT - 128;
        manager.addAnimated("poof", poofSheet, poofX, poofY, {
          fps: 8,
          loop: false,
          playing: false,
          visible: false,
          row: 0,
          z: 3,
          onComplete: () => {
            const p = manager.get("poof");
            if (p && p.kind === "animated") {
              p.visible = false;
            }
          },
        });

        // Load number sprites for pomodoro timer display on the pot
        const numberImg = await loadImage(spriteUrl("number-sprites.png"));
        if (cancelled) return;
        numberRendererRef.current = new NumberRenderer(numberImg);
      } catch (err) {
        console.error("Failed to load sprites:", err);
        if (!cancelled) {
          ctx.fillStyle = "#000";
          ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);
        }
      }
    };

    void setup();

    // Helper: pick number sprite colour based on pomodoro state
    const getTimerColor = (): NumberColor => {
      const ps = pomodoroStateRef.current;
      if (ps.mode === "break") return "green";
      // During work: blue when counting down, red when counting up (penalty)
      if (emotionRef.current === "mad") return "red";
      return "blue";
    };

    // Animation loop
    let lastTime = performance.now();
    const tick = (now: number) => {
      if (cancelled) return;
      const delta = now - lastTime;
      lastTime = now;

      manager.update(delta);
      manager.draw(ctx);

      // Draw pomodoro timer on the pot using sprite numbers
      const ps = pomodoroStateRef.current;
      const nr = numberRendererRef.current;
      if (ps.enabled && nr) {
        const mins = Math.floor(Math.abs(ps.timeRemaining) / 60);
        const secs = Math.abs(ps.timeRemaining) % 60;
        const timeStr =
          mins.toString().padStart(2, "0") +
          ":" +
          secs.toString().padStart(2, "0");
        const color = getTimerColor();

        // Centre the time string on the pot (canvas centre, near bottom)
        nr.drawTextCentered(ctx, timeStr, CANVAS_WIDTH / 2, CANVAS_HEIGHT - 24, color);
      }

      animFrameRef.current = requestAnimationFrame(tick);
    };
    animFrameRef.current = requestAnimationFrame(tick);

    return () => {
      cancelled = true;
      cancelAnimationFrame(animFrameRef.current);
      spriteManagerRef.current = null;
    };
  }, []);

  // Screenshot submission — triggered by main process via IPC when screen
  // content changes significantly or after an idle timeout.
  useEffect(() => {
    let isMounted = true;

    const captureAndSubmitScreenshot = async () => {
      if (screenshotInFlightRef.current) return;
      if (!window.focusWizard?.capturePageScreenshot) return;

      // Never send screenshots for LLM evaluation during pomodoro breaks (or when not actively working).
      const ps = pomodoroStateRef.current;
      const allowScreenshot = ps.enabled && ps.isRunning && !ps.isPaused && ps.mode === "work";
      if (!allowScreenshot) return;

      screenshotInFlightRef.current = true;

      try {
        const screenshotBase64 = await window.focusWizard
          .capturePageScreenshot();

        const payload: GetProductivityConfidenceRequest = {
          screenshotBase64,
          capturedAt: new Date().toISOString(),
        };

        // Read positive/negative prompts from settings and attach to payload
        try {
          const savedSettings = localStorage.getItem("focus-wizard-settings");
          if (savedSettings) {
            const parsed = JSON.parse(savedSettings);
            if (parsed.positivePrompt) {
              payload.positivePrompt = parsed.positivePrompt;
            }
            if (parsed.negativePrompt) {
              payload.negativePrompt = parsed.negativePrompt;
            }
          }
        } catch (e) {
          console.error("Failed to read prompts from settings:", e);
        }

        const response = await fetch(PRODUCTIVITY_ENDPOINT, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify(payload),
        });

        if (!response.ok) {
          const errText = await response.text().catch(() => "");
          console.warn(
            "Productivity endpoint error:",
            response.status,
            errText || response.statusText,
          );
          return;
        }

        const json = await response.json();
        const parsed = getProductivityConfidenceResponseSchema.safeParse(json);

        if (parsed.success && isMounted) {
          const confidence = parsed.data.productivityConfidence;
          const modelVoiceLine = parsed.data.productivityVoiceLine;
          setProductivityConfidence(confidence);

          const now = Date.now();
          productivityConfidenceRef.current = confidence;
          lastConfidenceAtRef.current = now;
          latestModelVoiceLineRef.current = modelVoiceLine ?? "";
          lastModelVoiceLineAtRef.current = now;

          const nextEmotion = applyEmotionFromSignals();

          // Speak model-generated screenshot callouts while off-task, even when
          // already in mad state, with a cooldown to avoid spam.
          if (
            nextEmotion === "mad" &&
            now - lastAngrySpokenAtRef.current >= ANGRY_VOICE_COOLDOWN_MS
          ) {
            lastAngrySpokenAtRef.current = now;
            void speakAngryNudge(modelVoiceLine);
          }
        }
      } catch (error) {
        console.error("Failed to submit screenshot:", error);
      } finally {
        screenshotInFlightRef.current = false;
      }
    };

    // Listen for trigger signals from the main process screen-diff monitor
    const unsubscribe = window.focusWizard?.onTriggerScreenshot(() => {
      void captureAndSubmitScreenshot();
    });

    return () => {
      isMounted = false;
      unsubscribe?.();
    };
  }, [applyEmotionFromSignals, speakAngryNudge]);

  // Subscribe to bridge focus + status so we can fetch attentiveness.
  useEffect(() => {
    const api = window.wizardAPI;
    if (!api) return;

    const isRecord = (v: unknown): v is Record<string, unknown> =>
      v !== null && typeof v === "object";

    const unsubs = [
      api.onFocus((data: unknown) => {
        const now = Date.now();

        if (isRecord(data) && data.face_detected === true) {
          everSeenFaceRef.current = true;
          lastFaceSeenAtRef.current = now;
          if (awayOverrideRef.current) {
            awayOverrideRef.current = false;
            applyEmotionFromSignals();
          }
        }

        if (
          isRecord(data) &&
          typeof data.gaze_x === "number" &&
          typeof data.gaze_y === "number"
        ) {
          latestGazeRef.current = { gaze_x: data.gaze_x, gaze_y: data.gaze_y };
        }
      }),
      api.onStatus((s: string) => {
        setBridgeStatus(s);
      }),
    ];

    return () => {
      unsubs.forEach((u) => u());
    };
  }, [applyEmotionFromSignals]);

  // Away detection: if no face for >3s => mad; when face returns => clear override.
  useEffect(() => {
    const intervalId = window.setInterval(() => {
      // Give a grace period after start before we can go "away".
      if (Date.now() - sessionStartAtRef.current < HEAD_START_MS) return;
      if (!everSeenFaceRef.current) return;

      const elapsedMs = Date.now() - lastFaceSeenAtRef.current;
      if (elapsedMs > 3000) {
        if (!awayOverrideRef.current) {
          awayOverrideRef.current = true;
          setEmotion("mad");
        }
      }
    }, 250);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  // Fetch attentiveness from Deno every second (independent of screenshot logic)
  useEffect(() => {
    let cancelled = false;

    const tick = async () => {
      if (cancelled) return;
      if (attentivenessInFlightRef.current) return;

      const gaze = latestGazeRef.current;
      if (!gaze) return;

      attentivenessInFlightRef.current = true;
      try {
        const payload: GetAttentivenessRequest = {
          gaze_x: gaze.gaze_x,
          gaze_y: gaze.gaze_y,
          bridgeStatus: bridgeStatus || "unknown",
          capturedAt: new Date().toISOString(),
        };

        const resp = await fetch(ATTENTIVENESS_ENDPOINT, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!resp.ok) return;

        const json = await resp.json();
        const parsed = getAttentivenessResponseSchema.safeParse(json);
        if (!parsed.success) return;

        if (!cancelled) {
          setAttentiveness(parsed.data.attentiveness);
          attentivenessRef.current = parsed.data.attentiveness;
          applyEmotionFromSignals();
        }
      } catch {
        // ignore - keep last value
      } finally {
        attentivenessInFlightRef.current = false;
      }
    };

    void tick();
    const intervalId = window.setInterval(() => {
      void tick();
    }, 1000);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
    };
  }, [bridgeStatus, applyEmotionFromSignals]);

  return (
    <>
      <main className="pixel-stage">
        <div className="wizard-area">
          <canvas
            ref={canvasRef}
            className="pixel-canvas"
            width={CANVAS_WIDTH}
            height={CANVAS_HEIGHT}
            style={{ cursor: "default" }}
          />
          <div
            className="wand-hotspot"
            onMouseEnter={() => handleWandHover(true)}
            onMouseLeave={() => handleWandHover(false)}
            onClick={handleWandAreaClick}
          />
        </div>
{/* Uncomment this if you want to debug the confidence monitor and the attentivenes monitor */}


        {/* <div className="confidence-monitor">
          Conf: {productivityConfidence === null
            ? "--"
            : productivityConfidence.toFixed(2)}
          {"  "}
          Attn: {attentiveness === null ? "--" : attentiveness.toFixed(2)}
        </div> */}
      </main>
    </>
  );
}

export default App;
