export interface SpriteSheetOptions {
  frameCount?: number;
  framesPerRow?: number;
}

type ImageSourceWithSize = CanvasImageSource & {
  width: number;
  height: number;
};

const getSourceSize = (
  source: CanvasImageSource,
): { width: number; height: number } => {
  const sized = source as ImageSourceWithSize;
  return { width: sized.width, height: sized.height };
};

export class SpriteSheet {
  readonly image: CanvasImageSource;
  readonly frameWidth: number;
  readonly frameHeight: number;
  readonly frameCount: number;
  readonly framesPerRow: number;

  constructor(
    image: CanvasImageSource,
    frameWidth: number,
    frameHeight: number,
    options: SpriteSheetOptions = {},
  ) {
    this.image = image;
    this.frameWidth = frameWidth;
    this.frameHeight = frameHeight;

    const { width, height } = getSourceSize(image);
    const columns = Math.max(1, Math.floor(width / frameWidth));
    const rows = Math.max(1, Math.floor(height / frameHeight));
    const maxFrames = columns * rows;

    this.framesPerRow = Math.max(
      1,
      Math.min(options.framesPerRow ?? columns, columns),
    );
    this.frameCount = Math.min(options.frameCount ?? maxFrames, maxFrames);
  }

  drawFrame(
    ctx: CanvasRenderingContext2D,
    frameIndex: number,
    x: number,
    y: number,
    scale = 1,
  ): void {
    const frame = Math.max(0, Math.min(frameIndex, this.frameCount - 1));
    const sx = (frame % this.framesPerRow) * this.frameWidth;
    const sy = Math.floor(frame / this.framesPerRow) * this.frameHeight;
    const dx = Math.round(x);
    const dy = Math.round(y);
    const dw = Math.round(this.frameWidth * scale);
    const dh = Math.round(this.frameHeight * scale);

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(
      this.image,
      sx,
      sy,
      this.frameWidth,
      this.frameHeight,
      dx,
      dy,
      dw,
      dh,
    );
  }
}
