import { describe, expect, it } from "vitest";
import { replayable, textOnly } from "@/lib/brain/chat";

const history = [
  { role: "user", content: [{ type: "text", text: "Create the tickets again" }] },
  {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "...", signature: "s" },
      { type: "text", text: "Checking.", citations: null, parsed_output: null },
      { type: "tool_use", id: "t1", name: "get_project", input: { projectId: "p" }, caller: { type: "direct" } },
    ],
  },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "Project...", extra: 1 }] },
  { role: "assistant", content: [{ type: "text", text: "They exist." }] },
];

describe("chat history", () => {
  it("replays only the fields the API accepts", () => {
    const out = replayable(history);
    expect(out[1].content).toEqual([
      { type: "text", text: "Checking." },
      { type: "tool_use", id: "t1", name: "get_project", input: { projectId: "p" } },
    ]);
    expect(out[2].content).toEqual([{ type: "tool_result", tool_use_id: "t1", content: "Project..." }]);
  });

  it("falls back to alternating text turns", () => {
    expect(textOnly(history)).toEqual([
      { role: "user", content: [{ type: "text", text: "Create the tickets again" }] },
      { role: "assistant", content: [{ type: "text", text: "Checking.\nThey exist." }] },
    ]);
  });
});
