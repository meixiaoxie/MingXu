import stringWidth from "string-width";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;
const OSC_PATTERN = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/gu;
const DCS_PATTERN = /\u001bP[\s\S]*?\u001b\\/gu;
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B\u000C\u000E-\u001A\u007F]/gu;

export function stripAnsi(value: string): string {
  return value.replace(OSC_PATTERN, "").replace(DCS_PATTERN, "").replace(ANSI_PATTERN, "");
}

export function sanitizeTerminalText(value: string): string {
  return stripAnsi(value).replace(C0_CONTROL_PATTERN, "");
}

export function visibleWidth(value: string): number {
  return stringWidth(sanitizeTerminalText(value));
}

export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  const graphemes = splitGraphemes(value);
  let total = 0;
  let output = "";
  for (const grapheme of graphemes) {
    const graphemeWidth = stringWidth(grapheme);
    if (total + graphemeWidth > width) {
      break;
    }
    total += graphemeWidth;
    output += grapheme;
  }
  return output;
}

export function padToWidth(value: string, width: number): string {
  const currentWidth = visibleWidth(value);
  if (currentWidth >= width) {
    return value;
  }
  return `${value}${" ".repeat(width - currentWidth)}`;
}

export function wrapText(value: string, width: number): string[] {
  if (width <= 0) {
    return [sanitizeTerminalText(value)];
  }

  const paragraphs = sanitizeTerminalText(value).split(/\r?\n/u);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let current = "";
    let currentWidth = 0;
    for (const grapheme of splitGraphemes(paragraph)) {
      const graphemeWidth = stringWidth(grapheme);
      if (currentWidth > 0 && currentWidth + graphemeWidth > width) {
        lines.push(current);
        current = grapheme;
        currentWidth = graphemeWidth;
        continue;
      }
      if (currentWidth === 0 && graphemeWidth > width) {
        lines.push(truncateToWidth(grapheme, width));
        current = "";
        currentWidth = 0;
        continue;
      }
      current += grapheme;
      currentWidth += graphemeWidth;
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

function splitGraphemes(value: string): string[] {
  const segmenter = (Intl as typeof Intl & { Segmenter?: new (locale?: string, options?: Intl.SegmenterOptions) => Intl.Segmenter }).Segmenter;
  if (segmenter) {
    const iterator = new segmenter(undefined, { granularity: "grapheme" }).segment(value);
    return Array.from(iterator, (segment) => segment.segment);
  }
  return Array.from(value);
}
