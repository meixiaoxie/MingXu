import stringWidth from "string-width";

const BINARY_OUTPUT_PLACEHOLDER = "[binary output omitted]";
const C0_CONTROL_PATTERN = /[\u0000-\u0008\u000B-\u001A\u007F-\u009F]/gu;
const UNPAIRED_SURROGATE_PATTERN = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/gu;

export function stripAnsi(value: string): string {
  let output = "";
  for (let index = 0; index < value.length;) {
    const code = value.charCodeAt(index);
    if (code === 0x1b) {
      index = skipEscapeSequence(value, index);
      continue;
    }
    if (code === 0x90 || code === 0x9d || code === 0x9e || code === 0x9f) {
      index = skipStringSequence(value, index + 1);
      continue;
    }
    if (code === 0x9b) {
      index = skipControlSequence(value, index + 1);
      continue;
    }
    output += value[index] ?? "";
    index += 1;
  }
  return output;
}

export function sanitizeTerminalText(value: string): string {
  if (looksLikeBinary(value)) {
    return BINARY_OUTPUT_PLACEHOLDER;
  }
  return stripAnsi(value)
    .replace(/\r\n?/gu, "\n")
    .replace(/\t/gu, "    ")
    .replace(C0_CONTROL_PATTERN, "")
    .replace(UNPAIRED_SURROGATE_PATTERN, "\uFFFD");
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

export function splitGraphemes(value: string): string[] {
  const segmenter = (Intl as typeof Intl & { Segmenter?: new (locale?: string, options?: Intl.SegmenterOptions) => Intl.Segmenter }).Segmenter;
  if (segmenter) {
    const iterator = new segmenter(undefined, { granularity: "grapheme" }).segment(value);
    return Array.from(iterator, (segment) => segment.segment);
  }
  return Array.from(value);
}

function skipEscapeSequence(value: string, escapeIndex: number): number {
  const next = value.charCodeAt(escapeIndex + 1);
  if (next === 0x5b) return skipControlSequence(value, escapeIndex + 2);
  if (next === 0x5d || next === 0x50 || next === 0x5e || next === 0x5f) {
    return skipStringSequence(value, escapeIndex + 2);
  }
  return Math.min(value.length, escapeIndex + 2);
}

function skipControlSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    index += 1;
    if (code >= 0x40 && code <= 0x7e) break;
  }
  return index;
}

function skipStringSequence(value: string, start: number): number {
  let index = start;
  while (index < value.length) {
    const code = value.charCodeAt(index);
    if (code === 0x07) return index + 1;
    if (code === 0x1b && value.charCodeAt(index + 1) === 0x5c) return index + 2;
    if (code === 0x9c) return index + 1;
    index += 1;
  }
  return value.length;
}

function looksLikeBinary(value: string): boolean {
  let suspicious = 0;
  let nulls = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code === 0) nulls += 1;
    if ((code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d && code !== 0x1b)
      || (code >= 0x7f && code <= 0x9f)) {
      suspicious += 1;
    }
  }
  return nulls >= 2 || (suspicious >= 4 && suspicious / Math.max(1, value.length) >= 0.2);
}
