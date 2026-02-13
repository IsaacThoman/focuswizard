/**
 * Renders pixel-art numbers from number-sprites.png onto a canvas.
 *
 * The sprite sheet layout (77x33):
 *   - 11 columns of 7px wide characters: 1 2 3 4 5 6 7 8 9 0 :
 *   - 3 rows of 11px tall, one per colour:
 *       Row 0 = blue   (counting down / normal work)
 *       Row 1 = red    (counting up / penalty)
 *       Row 2 = green  (break time)
 */

export type NumberColor = "blue" | "red" | "green";

const CHAR_WIDTH = 7;
const CHAR_HEIGHT = 11;

const COLOR_ROW: Record<NumberColor, number> = {
  blue: 0,
  red: 1,
  green: 2,
};

/** Maps a display character to its column index in the sprite sheet. */
const CHAR_COL: Record<string, number> = {
  "1": 0,
  "2": 1,
  "3": 2,
  "4": 3,
  "5": 4,
  "6": 5,
  "7": 6,
  "8": 7,
  "9": 8,
  "0": 9,
  ":": 10,
};

export class NumberRenderer {
  private image: CanvasImageSource;

  constructor(image: CanvasImageSource) {
    this.image = image;
  }

  /**
   * Draw a string of digits / colons onto the canvas.
   * Characters not in the sprite sheet (e.g. spaces) are skipped but still
   * advance the cursor by one character width.
   */
  drawText(
    ctx: CanvasRenderingContext2D,
    text: string,
    x: number,
    y: number,
    color: NumberColor,
    scale = 1,
  ): void {
    const row = COLOR_ROW[color];
    const sy = row * CHAR_HEIGHT;
    let cursorX = x;

    for (const ch of text) {
      const col = CHAR_COL[ch];
      if (col !== undefined) {
        const sx = col * CHAR_WIDTH;
        ctx.drawImage(
          this.image,
          sx,
          sy,
          CHAR_WIDTH,
          CHAR_HEIGHT,
          Math.round(cursorX),
          Math.round(y),
          Math.round(CHAR_WIDTH * scale),
          Math.round(CHAR_HEIGHT * scale),
        );
      }
      // Always advance cursor (spaces just leave a gap)
      cursorX += CHAR_WIDTH * scale;
    }
  }

  /**
   * Draw a string centred horizontally at the given x coordinate.
   */
  drawTextCentered(
    ctx: CanvasRenderingContext2D,
    text: string,
    centerX: number,
    y: number,
    color: NumberColor,
    scale = 1,
  ): void {
    const totalWidth = text.length * CHAR_WIDTH * scale;
    this.drawText(ctx, text, centerX - totalWidth / 2, y, color, scale);
  }

  /** Character dimensions (unscaled). */
  static readonly CHAR_WIDTH = CHAR_WIDTH;
  static readonly CHAR_HEIGHT = CHAR_HEIGHT;
}
