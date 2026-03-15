/**
 * utils/metrics.ts
 * Lightweight in-process metrics: latency histograms per pipeline stage.
 * Emitted to logs and optionally to a Prometheus /metrics endpoint.
 */

import { logger } from "./logger";

export type Stage =
  | "stt_interim"   // mic-end → first interim transcript
  | "stt_final"     // mic-end → final transcript
  | "llm_first"     // transcript → first LLM token
  | "llm_complete"  // transcript → full LLM response
  | "tts_first"     // first LLM sentence → first TTS audio chunk
  | "tts_complete"  // → full TTS audio
  | "e2e";          // mic-end → first audio byte out

interface Sample {
  stage: Stage;
  sessionId: string;
  durationMs: number;
  ts: number;
}

class MetricsCollector {
  private samples: Sample[] = [];
  private timers = new Map<string, number>();

  /** Start a timer for a stage in a session */
  start(stage: Stage, sessionId: string): void {
    this.timers.set(`${sessionId}:${stage}`, Date.now());
  }

  /** Stop a timer, record the sample, and log it */
  end(stage: Stage, sessionId: string): number {
    const key = `${sessionId}:${stage}`;
    const startedAt = this.timers.get(key);
    if (startedAt === undefined) return -1;

    const durationMs = Date.now() - startedAt;
    this.timers.delete(key);

    const sample: Sample = { stage, sessionId, durationMs, ts: Date.now() };
    this.samples.push(sample);

    // Keep last 1000 samples in memory
    if (this.samples.length > 1000) this.samples.shift();

    logger.info({ metric: true, stage, sessionId, durationMs }, `⏱  ${stage}: ${durationMs}ms`);

    // Warn on SLA breaches
    const sla: Partial<Record<Stage, number>> = {
      stt_interim: 700,
      stt_final: 1500,
      llm_first: 1200,
      tts_first: 800,
      e2e: 2500,
    };
    const limit = sla[stage];
    if (limit !== undefined && durationMs > limit) {
      logger.warn({ stage, sessionId, durationMs, slaMs: limit }, `⚠  SLA breach: ${stage}`);
    }

    return durationMs;
  }

  /** Return p50/p90/p99 for a stage over recent samples */
  percentiles(stage: Stage): { p50: number; p90: number; p99: number; count: number } {
    const values = this.samples
      .filter((s) => s.stage === stage)
      .map((s) => s.durationMs)
      .sort((a, b) => a - b);

    if (values.length === 0) return { p50: 0, p90: 0, p99: 0, count: 0 };

    const at = (pct: number) => values[Math.floor(values.length * pct)] ?? 0;
    return {
      p50: at(0.5),
      p90: at(0.9),
      p99: at(0.99),
      count: values.length,
    };
  }

  /** Prometheus-style text format */
  toPrometheusText(): string {
    const stages: Stage[] = ["stt_interim", "stt_final", "llm_first", "tts_first", "e2e"];
    const lines: string[] = [];
    for (const stage of stages) {
      const p = this.percentiles(stage);
      const safeName = stage.replace(/_/g, "_");
      lines.push(`# TYPE voice_bridge_${safeName}_ms summary`);
      lines.push(`voice_bridge_${safeName}_ms{quantile="0.5"} ${p.p50}`);
      lines.push(`voice_bridge_${safeName}_ms{quantile="0.9"} ${p.p90}`);
      lines.push(`voice_bridge_${safeName}_ms{quantile="0.99"} ${p.p99}`);
      lines.push(`voice_bridge_${safeName}_ms_count ${p.count}`);
    }
    return lines.join("\n");
  }
}

export const metrics = new MetricsCollector();
