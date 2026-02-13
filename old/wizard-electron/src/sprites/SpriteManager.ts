import { SpriteSheet } from "./SpriteSheet";

export interface AnimatedSprite {
  sheet: SpriteSheet;
  x: number;
  y: number;
  scale?: number;
  /** Frames per second for this sprite's animation */
  fps?: number;
  /** Current column index within the active row (managed internally) */
  _col: number;
  /** Accumulated time since last frame advance (ms) */
  _elapsed: number;
  /** Whether the animation is playing */
  playing: boolean;
  /** Loop the animation */
  loop: boolean;
  /** Play the animation in reverse (columns go from framesPerRow-1 down to 0) */
  reverse: boolean;
  /** Active row to animate across (0-based). Changes which horizontal strip is used. */
  row: number;
  /** Override columns to animate within the active row (defaults to sheet.framesPerRow) */
  colCount?: number;
  /** Optional z-index for draw ordering (lower draws first) */
  z?: number;
  /** Whether to draw this sprite (default true) */
  visible?: boolean;
  /** Called once when a non-looping animation finishes */
  onComplete?: (() => void) | null;
}

export interface StaticSprite {
  image: CanvasImageSource;
  x: number;
  y: number;
  width: number;
  height: number;
  /** Optional z-index for draw ordering (lower draws first) */
  z?: number;
}

export type ManagedSprite =
  | ({ kind: "animated" } & AnimatedSprite)
  | ({ kind: "static" } & StaticSprite);

export class SpriteManager {
  private sprites = new Map<string, ManagedSprite>();
  private canvasWidth: number;
  private canvasHeight: number;

  constructor(canvasWidth: number, canvasHeight: number) {
    this.canvasWidth = canvasWidth;
    this.canvasHeight = canvasHeight;
  }

  addAnimated(
    id: string,
    sheet: SpriteSheet,
    x: number,
    y: number,
    options: {
      scale?: number;
      fps?: number;
      loop?: boolean;
      playing?: boolean;
      reverse?: boolean;
      row?: number;
      colCount?: number;
      z?: number;
      visible?: boolean;
      onComplete?: (() => void) | null;
    } = {},
  ): void {
    this.sprites.set(id, {
      kind: "animated",
      sheet,
      x,
      y,
      scale: options.scale ?? 1,
      fps: options.fps ?? 8,
      _col: 0,
      _elapsed: 0,
      playing: options.playing ?? true,
      loop: options.loop ?? true,
      reverse: options.reverse ?? false,
      row: options.row ?? 0,
      colCount: options.colCount,
      z: options.z ?? 0,
      visible: options.visible ?? true,
      onComplete: options.onComplete ?? null,
    });
  }

  addStatic(
    id: string,
    image: CanvasImageSource,
    x: number,
    y: number,
    width: number,
    height: number,
    z = 0,
  ): void {
    this.sprites.set(id, {
      kind: "static",
      image,
      x,
      y,
      width,
      height,
      z,
    });
  }

  remove(id: string): void {
    this.sprites.delete(id);
  }

  get(id: string): ManagedSprite | undefined {
    return this.sprites.get(id);
  }

  has(id: string): boolean {
    return this.sprites.has(id);
  }

  /** Update all animated sprites by the given delta time (ms). */
  update(deltaMs: number): void {
    for (const sprite of this.sprites.values()) {
      if (sprite.kind !== "animated") continue;
      if (!sprite.playing) continue;

      const frameDuration = 1000 / (sprite.fps ?? 8);
      sprite._elapsed += deltaMs;

      while (sprite._elapsed >= frameDuration) {
        sprite._elapsed -= frameDuration;
        const maxCol = sprite.colCount ?? sprite.sheet.framesPerRow;

        if (sprite.reverse) {
          const prevCol = sprite._col - 1;
          if (prevCol < 0) {
            if (sprite.loop) {
              sprite._col = maxCol - 1;
            } else {
              sprite.playing = false;
              sprite.onComplete?.();
            }
          } else {
            sprite._col = prevCol;
          }
        } else {
          const nextCol = sprite._col + 1;
          if (nextCol >= maxCol) {
            if (sprite.loop) {
              sprite._col = 0;
            } else {
              sprite.playing = false;
              sprite.onComplete?.();
            }
          } else {
            sprite._col = nextCol;
          }
        }
      }
    }
  }

  /** Draw all managed sprites to the canvas context, sorted by z-index. */
  draw(ctx: CanvasRenderingContext2D): void {
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, this.canvasWidth, this.canvasHeight);

    const sorted = [...this.sprites.values()].sort((a, b) =>
      (a.z ?? 0) - (b.z ?? 0)
    );

    for (const sprite of sorted) {
      if (sprite.kind === "animated") {
        if (sprite.visible === false) continue;
        // Compute the linear frame index from row + column
        const frameIndex = sprite.row * sprite.sheet.framesPerRow + sprite._col;
        sprite.sheet.drawFrame(
          ctx,
          frameIndex,
          sprite.x,
          sprite.y,
          sprite.scale,
        );
      } else {
        ctx.drawImage(
          sprite.image,
          Math.round(sprite.x),
          Math.round(sprite.y),
          sprite.width,
          sprite.height,
        );
      }
    }
  }
}
