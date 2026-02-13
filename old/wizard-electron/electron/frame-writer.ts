/**
 * frame-writer.ts — Manages the shared frame directory
 *
 * The Electron renderer captures webcam frames via getUserMedia,
 * sends them to the main process as JPEG buffers, and this module
 * writes them as numbered files that SmartSpectra's FileStreamVideoSource
 * picks up inside the Docker container.
 *
 * Naming convention:
 *   frame{timestamp_us_padded_to_16_digits}.jpg
 *   e.g. frame0001707312345678.jpg
 *
 * The Docker container volume-mounts this directory at /frames.
 */

import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export class FrameWriter {
  private readonly frameDir: string;
  private frameCount = 0;
  private active = false;

  constructor(frameDir?: string) {
    this.frameDir = frameDir || path.join(os.tmpdir(), "focus-wizard-frames");
  }

  /** The host directory where frames are written. */
  get directory(): string {
    return this.frameDir;
  }

  /**
   * The file_stream_path pattern for SmartSpectra.
   * The 16 zeros define the digit width; SmartSpectra replaces them
   * with the actual timestamp in microseconds.
   * This path is from inside the Docker container (/frames mount).
   */
  get containerFileStreamPath(): string {
    return "/frames/frame0000000000000000.jpg";
  }

  /** Total frames written this session. */
  get count(): number {
    return this.frameCount;
  }

  get isActive(): boolean {
    return this.active;
  }

  /**
   * Initialize the frame directory.
   * Creates it if missing, clears any leftover frames.
   */
  init(): void {
    if (!fs.existsSync(this.frameDir)) {
      fs.mkdirSync(this.frameDir, { recursive: true });
    }
    this.clearFrames();
    this.frameCount = 0;
    this.active = true;
  }

  /**
   * Write a JPEG frame to the shared directory.
   * @param timestampUs - Timestamp in microseconds (Date.now() * 1000)
   * @param jpegData    - Raw JPEG bytes
   */
  writeFrame(timestampUs: number, jpegData: Buffer): void {
    if (!this.active) return;

    const padded = Math.floor(timestampUs).toString().padStart(16, "0");
    const filename = `frame${padded}.jpg`;
    const filepath = path.join(this.frameDir, filename);

    try {
      fs.writeFileSync(filepath, jpegData);
      this.frameCount++;
    } catch (err) {
      // If the directory is gone, stop writing
      console.error(`[FrameWriter] Failed to write frame: ${err}`);
    }
  }

  /**
   * Write the end_of_stream marker file.
   * SmartSpectra's FileStreamVideoSource stops when it sees this.
   */
  writeEndOfStream(): void {
    try {
      const filepath = path.join(this.frameDir, "end_of_stream");
      fs.writeFileSync(filepath, "");
    } catch {
      // Ignore — directory might already be gone
    }
  }

  /**
   * Remove all frame files from the directory.
   */
  clearFrames(): void {
    try {
      const files = fs.readdirSync(this.frameDir);
      for (const file of files) {
        fs.unlinkSync(path.join(this.frameDir, file));
      }
    } catch {
      // Directory might not exist yet
    }
  }

  /**
   * Stop writing and clean up the frame directory entirely.
   */
  cleanup(): void {
    this.active = false;
    try {
      fs.rmSync(this.frameDir, { recursive: true, force: true });
    } catch {
      // Ignore errors
    }
  }
}
