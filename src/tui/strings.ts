import stringWidth from "string-width";

const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/gu;

export function stripAnsi(value: string): string {
  return value.replace(ANSI_PATTERN, "");
}

export function visibleWidth(value: string): number {
  return stringWidth(stripAnsi(value));
}

export function truncateToWidth(value: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let total = 0;
  let output = "";
  for (const char of value) {
    const charWidth = stringWidth(char);
    if (total + charWidth > width) {
      break;
    }
    total += charWidth;
    output += char;
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
    return [value];
  }

  const paragraphs = value.split(/\r?\n/u);
  const lines: string[] = [];
  for (const paragraph of paragraphs) {
    if (!paragraph) {
      lines.push("");
      continue;
    }

    let current = "";
    for (const char of paragraph) {
      const next = `${current}${char}`;
      if (visibleWidth(next) > width && current) {
        lines.push(current);
        current = char;
      } else if (visibleWidth(next) > width) {
        lines.push(truncateToWidth(next, width));
        current = "";
      } else {
        current = next;
      }
    }

    if (current) {
      lines.push(current);
    }
  }

  return lines.length > 0 ? lines : [""];
}

