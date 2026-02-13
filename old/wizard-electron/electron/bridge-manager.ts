/**
 * bridge-manager.ts — Spawns and manages the C++ focus_bridge process
 *
 * Two modes:
 *   DOCKER (default): Runs the bridge in an Ubuntu 22.04 Docker container.
 *     Webcam frames are written to a shared directory by the Electron main
 *     process; SmartSpectra's FileStreamVideoSource reads them inside Docker.
 *
 *   LOCAL: Runs a native binary directly (for Ubuntu desktops or when
 *     the SDK is installed natively on macOS via partner package).
 *
 * Both modes emit JSON Lines on stdout that we parse here.
 */

import { ChildProcess, execSync, spawn } from "child_process";
import { EventEmitter } from "events";
import * as path from "path";
import * as fs from "fs";
import { fileURLToPath } from "url";
import { FrameWriter } from "./frame-writer";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/** Message types emitted by the C++ bridge */
export interface BridgeMessage {
  type: "status" | "ready" | "edge" | "metrics" | "focus" | "error";
  data: Record<string, unknown>;
}

export interface FocusData {
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

export interface BridgeManagerOptions {
  apiKey: string;

  /** 'docker' (default) or 'local' (native binary on Ubuntu/macOS) */
  mode?: "docker" | "local";

  // ── Docker mode options ──────────────────────────────
  /** Docker image name (default: 'focus-wizard-bridge') */
  dockerImage?: string;
  /** Host directory for frame exchange (default: /tmp/focus-wizard-frames) */
  frameDir?: string;

  // ── Local mode options ───────────────────────────────
  /** Path to the native focus_bridge binary */
  bridgePath?: string;
  /** Camera device index (default: 0) */
  cameraIndex?: number;
  /** Capture width in px */
  captureWidth?: number;
  /** Capture height in px */
  captureHeight?: number;

  // ── Analysis thresholds (both modes) ─────────────────
  gazeThreshold?: number;
  blinkThreshold?: number;
  pulseThreshold?: number;
  breathingThreshold?: number;
}

export class BridgeManager extends EventEmitter {
  private process: ChildProcess | null = null;
  private lineBuffer = "";
  private isReady = false;
  private _frameWriter: FrameWriter | null = null;
  private readonly dockerImage: string;
  private readonly mode: "docker" | "local";

  constructor(private options: BridgeManagerOptions) {
    super();
    this.dockerImage = options.dockerImage || "focus-wizard-bridge";
    this.mode = options.mode || "docker";
  }

  /** The FrameWriter instance (Docker mode only). */
  get frameWriter(): FrameWriter | null {
    return this._frameWriter;
  }

  // ── Docker Helpers ───────────────────────────────────

  /** Check if Docker daemon is available. */
  static isDockerAvailable(): boolean {
    try {
      execSync("docker info", { stdio: "ignore", timeout: 10000 });
      return true;
    } catch {
      return false;
    }
  }

  /** Check if the bridge Docker image exists locally. */
  private isImageBuilt(): boolean {
    try {
      execSync(`docker image inspect ${this.dockerImage}`, {
        stdio: "ignore",
        timeout: 5000,
      });
      return true;
    } catch {
      return false;
    }
  }

  /** Find the project root (where bridge/Dockerfile lives). */
  private findProjectRoot(): string {
    let dir = __dirname;
    for (let i = 0; i < 10; i++) {
      if (fs.existsSync(path.join(dir, "bridge", "Dockerfile"))) {
        return dir;
      }
      dir = path.dirname(dir);
    }
    throw new Error(
      "Could not find project root (looking for bridge/Dockerfile). " +
        "Run from the project directory, or build the image manually: " +
        "docker build -t focus-wizard-bridge -f bridge/Dockerfile .",
    );
  }

  /**
   * Build the Docker image if it doesn't already exist.
   * Emits 'status' events with build progress.
   */
  async buildImage(): Promise<void> {
    if (this.isImageBuilt()) {
      this.emit("status", "Docker image already built");
      return;
    }

    const projectRoot = this.findProjectRoot();
    this.emit(
      "status",
      "Building Docker image (first run — may take a few minutes)...",
    );

    return new Promise<void>((resolve, reject) => {
      const build = spawn("docker", [
        "build",
        "--platform",
        "linux/amd64",
        "-t",
        this.dockerImage,
        "-f",
        path.join(projectRoot, "bridge", "Dockerfile"),
        projectRoot,
      ], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      build.stdout?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) {
          console.log(`[Docker Build] ${text}`);
          // Forward a truncated status to the UI
          const lastLine = text.split("\n").pop() || text;
          this.emit("status", `Building: ${lastLine.slice(0, 100)}`);
        }
      });

      build.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) console.log(`[Docker Build] ${text}`);
      });

      build.on("close", (code) => {
        if (code === 0) {
          this.emit("status", "Docker image built successfully");
          resolve();
        } else {
          reject(new Error(`Docker build failed with exit code ${code}`));
        }
      });

      build.on("error", (err) => {
        reject(new Error(`Docker build error: ${err.message}`));
      });
    });
  }

  // ── Local Mode Helpers ───────────────────────────────

  /** Find the native bridge binary (local mode only). */
  private findBridgePath(): string {
    const candidates = [
      this.options.bridgePath,
      process.env.FOCUS_BRIDGE_PATH,
      path.join(__dirname, "..", "..", "..", "bridge", "build", "focus_bridge"),
      path.join(process.resourcesPath || "", "focus_bridge"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    throw new Error(
      "Could not find focus_bridge binary. " +
        "Build it with: cd bridge && mkdir build && cd build && cmake .. && make\n" +
        `Searched: ${candidates.join(", ")}`,
    );
  }

  // ── Start ────────────────────────────────────────────

  /**
   * Start the bridge (Docker or local depending on mode).
   */
  async start(): Promise<void> {
    if (this.process) {
      throw new Error("Bridge is already running");
    }

    if (this.mode === "docker") {
      await this.startDocker();
    } else {
      this.startLocal();
    }
  }

  /** Start the bridge inside a Docker container. */
  private async startDocker(): Promise<void> {
    if (!BridgeManager.isDockerAvailable()) {
      throw new Error(
        "Docker is not installed or not running. " +
          "Install Docker Desktop: https://www.docker.com/products/docker-desktop/",
      );
    }

    // Build image if needed
    await this.buildImage();

    // Stop any leftover container from a previous run
    try {
      execSync(`docker rm -f ${this.dockerImage}`, {
        stdio: "ignore",
        timeout: 5000,
      });
    } catch { /* no leftover container — fine */ }

    // Set up the shared frame directory
    this._frameWriter = new FrameWriter(this.options.frameDir);
    this._frameWriter.init();

    // Assemble docker run arguments
    const args = [
      "run",
      "--rm",
      "--platform",
      "linux/amd64",
      "--name",
      this.dockerImage,
      // Explicit DNS ensures fast resolution under x86 emulation on Apple Silicon
      "--dns",
      "8.8.8.8",
      "--dns",
      "8.8.4.4",
      "-v",
      `${this._frameWriter.directory}:/frames`,
      "-e",
      `SMARTSPECTRA_API_KEY=${this.options.apiKey}`,
      this.dockerImage,
      "--mode=server",
      `--file_stream_path=${this._frameWriter.containerFileStreamPath}`,
      "--erase_read_files=true",
      "--rescan_delay_ms=5",
    ];

    this.addThresholdArgs(args);

    console.log(`[BridgeManager] Starting Docker: docker ${args.join(" ")}`);
    this.emit("status", "Starting SmartSpectra container...");

    this.process = spawn("docker", args, {
      stdio: ["ignore", "pipe", "pipe"],
    });

    this.attachProcessHandlers();
  }

  /** Start the bridge as a native child process (local mode). */
  private startLocal(): void {
    const bridgePath = this.findBridgePath();
    const args: string[] = [
      `--api_key=${this.options.apiKey}`,
    ];

    if (this.options.cameraIndex !== undefined) {
      args.push(`--camera_device_index=${this.options.cameraIndex}`);
    }
    if (this.options.captureWidth !== undefined) {
      args.push(`--capture_width=${this.options.captureWidth}`);
    }
    if (this.options.captureHeight !== undefined) {
      args.push(`--capture_height=${this.options.captureHeight}`);
    }

    this.addThresholdArgs(args);

    console.log(
      `[BridgeManager] Starting local: ${bridgePath} ${args.join(" ")}`,
    );

    this.process = spawn(bridgePath, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env },
    });

    this.attachProcessHandlers();
  }

  /** Append analysis threshold flags to an argument array. */
  private addThresholdArgs(args: string[]): void {
    if (this.options.gazeThreshold !== undefined) {
      args.push(`--gaze_threshold=${this.options.gazeThreshold}`);
    }
    if (this.options.blinkThreshold !== undefined) {
      args.push(`--blink_threshold=${this.options.blinkThreshold}`);
    }
    if (this.options.pulseThreshold !== undefined) {
      args.push(`--pulse_threshold=${this.options.pulseThreshold}`);
    }
    if (this.options.breathingThreshold !== undefined) {
      args.push(`--breathing_threshold=${this.options.breathingThreshold}`);
    }
  }

  /** Wire up stdout/stderr/close/error handlers on the spawned process. */
  private attachProcessHandlers(): void {
    // Read JSON Lines from stdout
    this.process!.stdout?.on("data", (chunk: Buffer) => {
      this.lineBuffer += chunk.toString();
      this.processLines();
    });

    // Log stderr (SmartSpectra / glog / Docker output)
    this.process!.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text) {
        console.log(`[Bridge stderr] ${text}`);
      }
    });

    this.process!.on("close", (code) => {
      console.log(`[BridgeManager] Process exited with code ${code}`);
      this.process = null;
      this.isReady = false;
      this.emit("close", code);
    });

    this.process!.on("error", (err) => {
      console.error(`[BridgeManager] Process error:`, err);
      this.emit("error", err);
    });
  }

  /**
   * Parse complete lines from the buffer.
   */
  private processLines(): void {
    const lines = this.lineBuffer.split("\n");
    // Keep the last incomplete line in the buffer
    this.lineBuffer = lines.pop() || "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      try {
        const message: BridgeMessage = JSON.parse(trimmed);
        this.handleMessage(message);
      } catch (err) {
        console.warn(`[BridgeManager] Failed to parse line: ${trimmed}`);
      }
    }
  }

  /**
   * Handle a parsed message from the bridge.
   */
  private handleMessage(message: BridgeMessage): void {
    switch (message.type) {
      case "ready":
        this.isReady = true;
        this.emit("ready");
        break;

      case "focus":
        this.emit("focus", message.data as unknown as FocusData);
        break;

      case "metrics":
        this.emit("metrics", message.data);
        break;

      case "edge":
        this.emit("edge", message.data);
        break;

      case "status":
        this.emit("status", (message.data as { status: string }).status);
        break;

      case "error":
        this.emit(
          "bridge-error",
          (message.data as { message: string }).message,
        );
        break;

      default:
        console.warn(`[BridgeManager] Unknown message type: ${message.type}`);
    }
  }

  /**
   * Gracefully stop the bridge.
   */
  stop(): void {
    // Signal the C++ bridge to stop via end_of_stream marker
    if (this._frameWriter) {
      this._frameWriter.writeEndOfStream();
    }

    if (this.process) {
      console.log("[BridgeManager] Stopping...");

      if (this.mode === "docker") {
        // Docker: `docker stop` sends SIGTERM then SIGKILL after grace period
        try {
          execSync(`docker stop -t 5 ${this.dockerImage}`, {
            stdio: "ignore",
            timeout: 10000,
          });
        } catch {
          // Container might already be gone
        }
      } else {
        // Local: send SIGTERM, force-kill after 5s
        this.process.kill("SIGTERM");
        setTimeout(() => {
          if (this.process) {
            console.log("[BridgeManager] Force killing...");
            this.process.kill("SIGKILL");
          }
        }, 5000);
      }
    }

    // Clean up frame directory
    if (this._frameWriter) {
      this._frameWriter.cleanup();
      this._frameWriter = null;
    }
  }

  /**
   * Check if the bridge is running and ready.
   */
  get running(): boolean {
    return this.process !== null && this.isReady;
  }
}
