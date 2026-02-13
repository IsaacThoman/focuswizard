/**
 * useWebcam.ts — React hook for webcam capture & frame streaming
 *
 * Manages getUserMedia, draws video frames to an offscreen canvas,
 * converts to JPEG, and sends them to the Electron main process
 * which writes them to the shared Docker volume.
 */

import { useCallback, useEffect, useRef, useState } from "react";

interface UseWebcamOptions {
  /** Desired capture width (default: 640) */
  width?: number;
  /** Desired capture height (default: 480) */
  height?: number;
  /** Frames per second to capture (default: 15) */
  fps?: number;
  /** JPEG quality 0-1 (default: 0.80) */
  quality?: number;
  /** Whether capture is enabled */
  enabled?: boolean;

  /**
   * Duty-cycle the *sending* of frames to the bridge to reduce usage.
   * Set to `{ onMs: 0, offMs: 0 }` to disable duty-cycling (always on).
   */
  dutyCycle?: {
    onMs: number;
    offMs: number;
  };
}

interface UseWebcamReturn {
  /** Ref to attach to a <video> element for live preview */
  videoRef: React.RefObject<HTMLVideoElement | null>;
  /** The active media stream (for preview display) */
  stream: MediaStream | null;
  /** Whether the webcam is actively streaming */
  isActive: boolean;
  /** Error message if webcam access failed */
  error: string | null;
  /** Manually start capture */
  startCapture: () => Promise<void>;
  /** Manually stop capture */
  stopCapture: () => void;
}

export function useWebcam(options: UseWebcamOptions = {}): UseWebcamReturn {
  const {
    width = 640,
    height = 480,
    fps = 15,
    quality = 0.80,
    enabled = false,
    dutyCycle = { onMs: 0, offMs: 0 },
  } = options;

  const videoRef = useRef<HTMLVideoElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const capturingRef = useRef(false); // Guard against overlapping captures

  const dutyTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dutyOnRef = useRef(true);

  const [isActive, setIsActive] = useState(false);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [error, setError] = useState<string | null>(null);

  const isIgnorablePlayError = (err: unknown): boolean => {
    if (!err || typeof err !== "object") return false;
    const anyErr = err as { name?: unknown; message?: unknown };
    const name = typeof anyErr.name === "string" ? anyErr.name : "";
    const message = typeof anyErr.message === "string" ? anyErr.message : "";
    return (
      name === "AbortError" ||
      message.includes("The play() request was interrupted by a new load request")
    );
  };

  const stopDutyCycle = useCallback(() => {
    if (dutyTimerRef.current) {
      clearTimeout(dutyTimerRef.current);
      dutyTimerRef.current = null;
    }
    dutyOnRef.current = false;
  }, []);

  const startDutyCycle = useCallback(() => {
    if (dutyTimerRef.current) {
      clearTimeout(dutyTimerRef.current);
      dutyTimerRef.current = null;
    }

    // Duty-cycling disabled => always ON
    if (dutyCycle.onMs <= 0 || dutyCycle.offMs <= 0) {
      dutyOnRef.current = true;
      return;
    }

    dutyOnRef.current = true;

    const scheduleOff = () => {
      dutyTimerRef.current = setTimeout(() => {
        dutyOnRef.current = false;
        scheduleOn();
      }, dutyCycle.onMs);
    };

    const scheduleOn = () => {
      dutyTimerRef.current = setTimeout(() => {
        dutyOnRef.current = true;
        scheduleOff();
      }, dutyCycle.offMs);
    };

    scheduleOff();
  }, [dutyCycle.offMs, dutyCycle.onMs]);

  const stopCapture = useCallback(() => {
    stopDutyCycle();

    // Stop the capture interval
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }

    // Stop all media tracks
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }

    // Disconnect video element
    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    canvasRef.current = null;
    capturingRef.current = false;
    setStream(null); // Clear stream state
    setIsActive(false);
  }, [stopDutyCycle]);

  const captureFrame = useCallback(() => {
    // When OFF, skip capture/encode/send entirely.
    if (!dutyOnRef.current) return;

    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas || video.readyState < 2) {
      return;
    }
    if (capturingRef.current) {
      return; // Previous capture still in flight
    }

    capturingRef.current = true;

    const ctx = canvas.getContext("2d");
    if (!ctx) {
      capturingRef.current = false;
      return;
    }

    try {
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    } catch (err) {
      console.error("[useWebcam] Error drawing to canvas:", err);
      capturingRef.current = false;
      return;
    }

    canvas.toBlob(
      (blob) => {
        capturingRef.current = false;
        if (!blob) {
          return;
        }
        const timestampUs = Date.now() * 1000;
        blob.arrayBuffer().then((buffer) => {
          try {
            if (window.wizardAPI?.sendFrame) {
              window.wizardAPI.sendFrame(timestampUs, buffer);
            } else {
              console.error("[useWebcam] wizardAPI.sendFrame not available");
            }
          } catch (err) {
            console.error("[useWebcam] Error sending frame:", err);
          }
        });
      },
      "image/jpeg",
      quality,
    );
  }, [quality]);

  const startCapture = useCallback(async () => {
    try {
      setError(null);

      // If already capturing, just restart duty-cycle.
      if (streamRef.current && intervalRef.current) {
        startDutyCycle();
        setIsActive(true);
        return;
      }

      const stream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: width },
          height: { ideal: height },
          frameRate: { ideal: fps },
        },
        audio: false,
      });
      streamRef.current = stream;
      setStream(stream); // Trigger re-render for preview

      // Create video element if it doesn't exist
      if (!videoRef.current) {
        const video = document.createElement("video");
        video.autoplay = true;
        video.playsInline = true;
        video.muted = true;
        videoRef.current = video;
      }

      videoRef.current.srcObject = stream;
      try {
        await videoRef.current.play();
      } catch (err) {
        // React.StrictMode + rapid srcObject changes can cause a harmless AbortError.
        if (!isIgnorablePlayError(err)) {
          throw err;
        }
      }

      // Create offscreen canvas for frame extraction
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvasRef.current = canvas;

      // Start the capture interval
      const intervalMs = Math.round(1000 / fps);
      intervalRef.current = setInterval(() => {
        captureFrame();
      }, intervalMs);

      // Start duty-cycle after stream/interval are ready.
      startDutyCycle();

      setIsActive(true);
    } catch (err) {
      const message = err instanceof Error
        ? err.message
        : "Failed to access webcam";
      setError(message);
      console.error("[useWebcam] Error:", message);
    }
  }, [width, height, fps, captureFrame, startDutyCycle]);

  // Auto-start/stop based on `enabled` prop
  useEffect(() => {
    if (enabled) {
      startCapture();
    } else {
      stopCapture();
    }

    return () => {
      stopCapture();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // If duty-cycle timings change while running, reschedule.
  useEffect(() => {
    if (!enabled) return;
    if (!streamRef.current || !intervalRef.current) return;
    startDutyCycle();
  }, [enabled, dutyCycle.offMs, dutyCycle.onMs, startDutyCycle]);

  return {
    videoRef,
    stream,
    isActive,
    error,
    startCapture,
    stopCapture,
  };
}
