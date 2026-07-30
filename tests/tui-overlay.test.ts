import { describe, expect, it } from "vitest";

import { OverlayHost, type OverlayFrame } from "@mingxu/tui";

describe("OverlayHost", () => {
  it("routes input to the top overlay and forwards the viewport height", () => {
    const events: string[] = [];
    const host = new OverlayHost();

    const low: OverlayFrame = {
      id: "low",
      priority: 1,
      render: (width, height) => {
        events.push(`low render ${width} ${height ?? "none"}`);
        return ["low"];
      },
      handleInput: () => {
        events.push("low input");
        return { type: "none" };
      },
      invalidate: () => undefined,
    };

    const high: OverlayFrame = {
      id: "high",
      priority: 10,
      render: (width, height) => {
        events.push(`high render ${width} ${height ?? "none"}`);
        return ["high"];
      },
      handleInput: (input) => {
        events.push(`high input ${input.sequence}`);
        return { type: "none" };
      },
      invalidate: () => undefined,
    };

    host.push(low);
    host.push(high);

    expect(host.top?.id).toBe("high");
    expect(host.render(80, 12)).toEqual(["high"]);
    host.handleInput({ sequence: "x", name: "x" });
    expect(events).toContain("high render 80 12");
    expect(events).toContain("high input x");
    expect(events).not.toContain("low input");

    host.remove("high");
    expect(host.top?.id).toBe("low");
    host.handleInput({ sequence: "y", name: "y" });
    expect(events).toContain("low input");
  });
});
