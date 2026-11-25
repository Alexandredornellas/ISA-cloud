import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import type { z } from "zod";
import { log, traced } from "@/lib/log";

export const MODEL = "claude-opus-5-5";

export type Effort = "low" | "medium" | "high";

/** One structured call to Claude. Injected so the pipeline can be tested without the API. */
export type StructuredLLM = <S extends z.ZodType>(req: {
  system: string;
  // Stable context (projects, rules) first so it can be cached; the new item last.
  context: string;
  input: string;
  schema: S;
  effort: Effort;
}) => Promise<z.infer<S>>;

export class RefusalError extends Error {}

let client: Anthropic | null = null;

export const claudeStructured: StructuredLLM = (req) => traced("claude", `structured ${req.effort}`, () => structuredCall(req));

const structuredCall: StructuredLLM = async ({ system, context, input, schema, effort }) => {
  client ??= new Anthropic();
  const started = Date.now();
  const response = await client.beta.messages.parse({
    model: MODEL,
    max_tokens: 16000,
    // On a safety decline, the API retries on Anthropic's recommended fallback model.
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    system: [{ type: "text", text: system, cache_control: { type: "ephemeral" } }],
    messages: [
      {
        role: "user",
        content: [
          { type: "text", text: context, cache_control: { type: "ephemeral" } },
          { type: "text", text: input },
        ],
      },
    ],
    output_config: { effort, format: betaZodOutputFormat(schema) },
  });

  // Sizes and timing only, never the prompt or the answer.
  log.info("claude structured call", {
    effort,
    ms: Date.now() - started,
    stopReason: response.stop_reason,
    model: response.model,
    inputTokens: response.usage?.input_tokens,
    outputTokens: response.usage?.output_tokens,
    cacheReadTokens: response.usage?.cache_read_input_tokens ?? undefined,
    contextChars: context.length,
    inputChars: input.length,
  });
  if (response.stop_reason === "refusal") {
    throw new RefusalError("Claude declined this item");
  }
  if (response.stop_reason === "max_tokens") {
    throw new Error("Claude's answer was cut off (max_tokens)");
  }
  if (response.parsed_output == null) {
    throw new Error("Claude's answer did not match the expected format");
  }
  return response.parsed_output as z.infer<typeof schema>;
};
