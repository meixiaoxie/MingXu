import { describe, expect, it } from "vitest";

import { resolveTranscriptTheme, styleTranscript } from "../src/cli/transcript-theme.js";

describe("transcript theme", () => {
  it("forces plain mode for --plain, NO_COLOR, and TERM=dumb", () => {
    expect(resolveTranscriptTheme({ plain: true })).toMatchObject({ mode: "no-color", colorize: false });
    expect(resolveTranscriptTheme({ env: { NO_COLOR: "1" } as NodeJS.ProcessEnv })).toMatchObject({ mode: "no-color", colorize: false });
    expect(resolveTranscriptTheme({ env: { TERM: "dumb" } as NodeJS.ProcessEnv })).toMatchObject({ mode: "no-color", colorize: false });
  });

  it("colorizes transcript text when enabled", () => {
    const colored = resolveTranscriptTheme({ env: { MINGXU_THEME: "light" } as NodeJS.ProcessEnv });
    const plain = resolveTranscriptTheme({ plain: true });

    expect(styleTranscript(colored, "assistant", "hello")).toContain("\u001b[");
    expect(styleTranscript(plain, "assistant", "hello")).toBe("hello");
  });
});
