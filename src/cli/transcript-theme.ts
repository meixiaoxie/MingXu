export type TranscriptThemeMode = "dark" | "light" | "no-color";

export type TranscriptTone =
  | "accent"
  | "assistant"
  | "error"
  | "muted"
  | "status"
  | "success"
  | "tool"
  | "user"
  | "warning";

export interface TranscriptTheme {
  readonly mode: TranscriptThemeMode;
  readonly colorize: boolean;
}

const ANSI_RESET = "\u001b[0m";

const DARK_PALETTE: Readonly<Record<TranscriptTone, string>> = {
  accent: "\u001b[38;5;39m",
  assistant: "\u001b[38;5;51m",
  error: "\u001b[38;5;203m",
  muted: "\u001b[2m",
  status: "\u001b[38;5;246m",
  success: "\u001b[38;5;82m",
  tool: "\u001b[38;5;220m",
  user: "\u001b[38;5;117m",
  warning: "\u001b[38;5;214m",
};

const LIGHT_PALETTE: Readonly<Record<TranscriptTone, string>> = {
  accent: "\u001b[38;5;25m",
  assistant: "\u001b[38;5;18m",
  error: "\u001b[38;5;160m",
  muted: "\u001b[2m",
  status: "\u001b[38;5;90m",
  success: "\u001b[38;5;28m",
  tool: "\u001b[38;5;94m",
  user: "\u001b[38;5;31m",
  warning: "\u001b[38;5;130m",
};

export function resolveTranscriptTheme(options: {
  readonly env?: NodeJS.ProcessEnv;
  readonly plain?: boolean;
  readonly theme?: TranscriptThemeMode;
} = {}): TranscriptTheme {
  const env = options.env ?? process.env;
  const forcedPlain = options.plain === true || env.NO_COLOR !== undefined || env.TERM === "dumb";
  if (forcedPlain) {
    return { mode: "no-color", colorize: false };
  }

  const mode = options.theme ?? normalizeThemeName(env.MINGXU_THEME);
  if (mode === "no-color") {
    return { mode: "no-color", colorize: false };
  }

  return { mode, colorize: true };
}

export function styleTranscript(theme: TranscriptTheme, tone: TranscriptTone, text: string): string {
  if (!theme.colorize) {
    return text;
  }
  const palette = theme.mode === "light" ? LIGHT_PALETTE : DARK_PALETTE;
  const code = palette[tone] ?? palette.accent;
  return `${code}${text}${ANSI_RESET}`;
}

function normalizeThemeName(value: string | undefined): TranscriptThemeMode {
  if (value === "light" || value === "no-color") {
    return value;
  }
  return "dark";
}
