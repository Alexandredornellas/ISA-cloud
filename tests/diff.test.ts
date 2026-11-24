import { describe, expect, it } from "vitest";
import { diffWords } from "@/lib/diff";

describe("diffWords", () => {
  it("marks removed and added words and keeps the rest", () => {
    const d = diffWords("Daily reward of 1 small coin.", "Daily reward of 100 coins.");
    expect(d.filter((p) => p.kind !== "same").map((p) => [p.kind, p.text.trim()])).toEqual([
      ["removed", "1 small coin."],
      ["added", "100 coins."],
    ]);
    // Joining the unchanged and added parts gives the new text; unchanged and removed, the old one.
    expect(d.filter((p) => p.kind !== "removed").map((p) => p.text).join("")).toBe("Daily reward of 100 coins.");
    expect(d.filter((p) => p.kind !== "added").map((p) => p.text).join("")).toBe("Daily reward of 1 small coin.");
  });

  it("handles empty and identical texts", () => {
    expect(diffWords("", "New text")).toEqual([{ kind: "added", text: "New text" }]);
    expect(diffWords("Same", "Same")).toEqual([{ kind: "same", text: "Same" }]);
  });
});
