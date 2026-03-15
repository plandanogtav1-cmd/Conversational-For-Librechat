/**
 * llm/LibreChatClient.ts
 *
 * Streaming LLM client compatible with LibreChat's OpenAI-compatible endpoint
 * as well as OpenAI directly.
 *
 * - Keeps conversation history (messages array) per session
 * - Streams tokens via SSE (fetch + text/event-stream)
 * - Emits sentence-boundary callbacks so TTS can start early
 * - Supports barge-in cancellation via AbortController
 */

import { config } from "../config";
import { logger } from "../utils/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmStreamCallbacks {
  /** Called with each new token as it arrives */
  onToken: (token: string) => void;
  /**
   * Called when a sentence boundary is detected in the streamed text.
   * The full sentence text is passed, allowing early TTS synthesis.
   */
  onSentence: (sentence: string) => void;
  /** Called with the complete final response text */
  onComplete: (fullText: string) => void;
  /** Called on error */
  onError: (err: Error) => void;
}

// Sentence-ending punctuation pattern
const SENTENCE_END = /[.!?]["']?\s/;

export class LibreChatClient {
  private history: ChatMessage[] = [];
  private abortController: AbortController | null = null;

  constructor(private readonly sessionId: string) {
    // Prime with system prompt
    this.history.push({
      role: "system",
      content: config.LLM_SYSTEM_PROMPT,
    });
  }

  /** Cancel any in-flight LLM request (barge-in) */
  cancel(): void {
    if (this.abortController) {
      this.abortController.abort("barge-in");
      this.abortController = null;
    }
  }

  /** Add user turn and stream the assistant response */
  async streamResponse(
    userText: string,
    callbacks: LlmStreamCallbacks
  ): Promise<void> {
    this.history.push({ role: "user", content: userText });

    const controller = new AbortController();
    this.abortController = controller;

    logger.debug(
      { sessionId: this.sessionId, userText: userText.slice(0, 80) },
      "Sending to LLM"
    );

    let fullText = "";
    let sentenceBuffer = "";

    const flushSentence = (force = false) => {
      if (
        force ||
        SENTENCE_END.test(sentenceBuffer) ||
        sentenceBuffer.length > 200
      ) {
        const trimmed = sentenceBuffer.trim();
        if (trimmed.length > 0) {
          callbacks.onSentence(trimmed);
        }
        sentenceBuffer = "";
      }
    };

    try {
      const response = await fetch(`${config.LLM_BASE_URL}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${config.LLM_API_KEY}`,
          Accept: "text/event-stream",
        },
        body: JSON.stringify({
          model: config.LLM_MODEL,
          messages: this.history,
          stream: true,
          max_tokens: config.LLM_MAX_TOKENS,
          temperature: config.LLM_TEMPERATURE,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text();
        throw new Error(`LLM HTTP ${response.status}: ${body}`);
      }

      if (!response.body) throw new Error("LLM response has no body");

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let sseBuffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        sseBuffer += decoder.decode(value, { stream: true });

        // Process complete SSE lines
        const lines = sseBuffer.split("\n");
        sseBuffer = lines.pop() ?? ""; // keep incomplete line

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6).trim();
          if (data === "[DONE]") break;

          try {
            const parsed = JSON.parse(data) as {
              choices?: Array<{ delta?: { content?: string } }>;
            };
            const token = parsed.choices?.[0]?.delta?.content;
            if (!token) continue;

            fullText += token;
            sentenceBuffer += token;
            callbacks.onToken(token);
            flushSentence();
          } catch {
            // Malformed SSE line — skip
          }
        }
      }

      // Flush any remaining text as a final sentence
      flushSentence(true);

      // Store assistant turn in history
      if (fullText.trim()) {
        this.history.push({ role: "assistant", content: fullText.trim() });
      }

      callbacks.onComplete(fullText);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        logger.debug({ sessionId: this.sessionId }, "LLM stream cancelled (barge-in)");
        // Store partial response in history so context is preserved
        if (fullText.trim()) {
          this.history.push({
            role: "assistant",
            content: fullText.trim() + " [interrupted]",
          });
        }
        return;
      }
      const error = err instanceof Error ? err : new Error(String(err));
      logger.error({ sessionId: this.sessionId, err }, "LLM stream error");
      callbacks.onError(error);
    } finally {
      this.abortController = null;
    }
  }

  /** Clear conversation history (start fresh) */
  resetHistory(): void {
    this.history = [
      { role: "system", content: config.LLM_SYSTEM_PROMPT },
    ];
  }

  /** Get current history length (turns, not tokens) */
  get turnCount(): number {
    return this.history.filter((m) => m.role === "user").length;
  }
}
