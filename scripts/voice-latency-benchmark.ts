#!/usr/bin/env -S pnpm exec tsx
/** Opt-in, real-provider diagnostic. See docs/nodes/talk/realtime-sessions.md. */
import { randomUUID } from "node:crypto";
import { open, readFile } from "node:fs/promises";
import { basename } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";
import { GatewayClient } from "../src/gateway/client.js";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    url: { type: "string", default: "ws://127.0.0.1:18789" },
    agent: { type: "string", default: "main" },
    label: { type: "string" },
    output: { type: "string" },
    "require-agent": { type: "boolean", default: false },
    help: { type: "boolean", default: false },
  },
});
if (values.help || !values.output || !values.label || positionals.length === 0) {
  console.log(
    "Usage: pnpm exec tsx scripts/voice-latency-benchmark.ts --label baseline --output /tmp/voice-baseline.json [--url ws://127.0.0.1:18789] [--agent main] [--require-agent] turn1.pcm turn2.pcm\n" +
      "Input: synthetic mono 24 kHz signed little-endian PCM16 (no WAV header). Uses enrolled device credentials; never changes Gateway configuration.",
  );
  process.exit(values.help ? 0 : 1);
}

// Validate all fixtures before connecting to a paid provider.
const fixtures = await Promise.all(
  positionals.map(async (path) => {
    const pcm = await readFile(path);
    if (!pcm.length || pcm.length % 2 !== 0 || pcm.subarray(0, 4).toString() === "RIFF") {
      throw new Error(`Expected raw PCM16 input: ${basename(path)}`);
    }
    return { name: basename(path), pcm };
  }),
);
// Reserve the private artifact before any paid calls; never overwrite evidence.
const output = await open(values.output, "wx", 0o600);
const started = performance.now();
const now = () => Math.round((performance.now() - started) * 10) / 10;
const sessionKey = `agent:${values.agent}:voice-benchmark-${randomUUID()}`;
const events: Record<string, unknown>[] = [];
const turns: Array<{
  fixture: string;
  inputStartMs?: number;
  inputEndMs?: number;
  firstPacketMs?: number;
  firstNonSilentPcmMs?: number;
  firstPostAgentPcmMs?: number;
  agentTerminalMs?: number;
  inputEndToPcmMs?: number;
  inputEndToPostAgentPcmMs?: number;
  complete: boolean;
}> = [];
let sessionId: string | undefined;
let relayId: string | undefined;
let current: (typeof turns)[number] | undefined;
let source: { pcm: Buffer; offset: number; done: () => void } | undefined;
let audioDoneMs: number | undefined;
let lastSpeechMs: number;
let playbackUntilMs = 0;
let failure: string | undefined;
let pumping = false;
let pump: Promise<void> | undefined;
let history: unknown;
let created: unknown;
const interrupted = () => {
  failure = "Benchmark interrupted";
};
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);
const marks: Array<{ name: string; at: number }> = [];
const record = (event: string, fields: Record<string, unknown> = {}) => {
  events.push({ ms: now(), turn: turns.length, event, ...fields });
};
let resolveReady: () => void;
let rejectReady: (error: Error) => void;
const ready = new Promise<void>((resolve, reject) => {
  resolveReady = resolve;
  rejectReady = reject;
});
const client = new GatewayClient({
  url: values.url,
  clientName: "cli",
  clientDisplayName: "Voice latency diagnostic",
  mode: "cli",
  scopes: ["operator.read", "operator.write", "operator.talk"],
  sharedStateMode: "read-only",
  caps: ["tool-events"],
  requestTimeoutMs: 20_000,
  onHelloOk: () => resolveReady(),
  onConnectError: (error) => rejectReady(error),
  onClose: () => {
    if (pumping) {
      failure = "Gateway connection closed during the benchmark";
    }
  },
  onEvent: ({ event, payload }) => {
    if (!payload || typeof payload !== "object") {
      return;
    }
    const p = payload as Record<string, unknown>;
    if (event === "talk.event" && p.relaySessionId === relayId) {
      if (p.type === "audio" && typeof p.audioBase64 === "string") {
        const bytes = Buffer.from(p.audioBase64, "base64");
        playbackUntilMs = Math.max(playbackUntilMs, now()) + bytes.length / 48;
        if (!current) {
          return;
        }
        current.firstPacketMs ??= now();
        audioDoneMs = undefined;
        let sum = 0;
        for (let i = 0; i + 1 < bytes.length; i += 2) {
          sum += (bytes.readInt16LE(i) / 32768) ** 2;
        }
        const rms = Math.sqrt(sum / (bytes.length / 2));
        if (rms > 0.01) {
          lastSpeechMs = now();
          if (current.firstNonSilentPcmMs === undefined) {
            current.firstNonSilentPcmMs = now();
            record("firstNonSilentPcm", { rms });
          }
          if (current.agentTerminalMs !== undefined && current.firstPostAgentPcmMs === undefined) {
            current.firstPostAgentPcmMs = now();
            record("firstPostAgentPcm", { rms });
          }
        }
      } else if (p.type !== "inputAudio") {
        // Exclude tool arguments and output. Final speech and canonical history
        // are private diagnostic artifacts, never printed or committed.
        record(String(p.type), {
          role: p.role,
          text: p.type === "transcript" && p.final ? p.text : undefined,
          final: p.final,
          name: p.name,
          state: p.state,
          message: p.type === "error" ? p.message : undefined,
        });
        if (p.type === "audioDone") {
          audioDoneMs = now();
        }
        if (p.type === "clear") {
          playbackUntilMs = now();
          marks.length = 0;
        }
        if (p.type === "mark" && typeof p.markName === "string") {
          marks.push({ name: p.markName, at: playbackUntilMs });
        }
        if (p.type === "error") {
          failure = "Provider emitted a Talk error";
        }
      }
    }
    if (p.sessionKey !== sessionKey) {
      return;
    }
    if (event === "agent") {
      const data = p.data as Record<string, unknown> | undefined;
      record("agent", { runId: p.runId, stream: p.stream, phase: data?.phase });
      if (p.stream === "lifecycle" && data?.phase === "end" && current) {
        current.agentTerminalMs = now();
      }
      if (p.stream === "lifecycle" && data?.phase === "error") {
        failure = "Agent run failed";
      }
    }
    if (event === "chat" && ["final", "error", "aborted"].includes(String(p.state))) {
      record("chatTerminal", { runId: p.runId, state: p.state });
      if (p.state === "final" && current) {
        current.agentTerminalMs ??= now();
      }
      if (p.state !== "final") {
        failure = `Agent chat ${String(p.state)}`;
      }
    }
  },
});

try {
  client.start();
  const connectTimer = setTimeout(
    () => rejectReady(new Error("Gateway connection timed out")),
    20_000,
  );
  try {
    await ready;
  } finally {
    clearTimeout(connectTimer);
  }
  const session = await client.request<{
    sessionId: string;
    relaySessionId?: string;
    audio?: {
      inputEncoding: string;
      inputSampleRateHz: number;
      outputEncoding: string;
      outputSampleRateHz: number;
    };
  }>("talk.session.create", {
    sessionKey,
    mode: "realtime",
    transport: "gateway-relay",
    brain: "agent-consult",
  });
  created = session;
  sessionId = session.sessionId;
  relayId = session.relaySessionId ?? sessionId;
  if (
    session.audio?.inputEncoding !== "pcm16" ||
    session.audio.inputSampleRateHz !== 24_000 ||
    session.audio.outputEncoding !== "pcm16" ||
    session.audio.outputSampleRateHz !== 24_000
  ) {
    throw new Error("Benchmark requires mono PCM16 at 24 kHz in both directions");
  }
  pumping = true;
  // One input clock spans setup, responses, playback, and inter-turn gaps.
  // No blocking per-turn sleep can starve the provider of microphone silence.
  pump = (async () => {
    let next = performance.now();
    while (true) {
      if (!pumping || failure) {
        break;
      }
      const frame = Buffer.alloc(4800);
      const pending = source;
      if (pending) {
        if (current) {
          current.inputStartMs ??= now();
        }
        const end = Math.min(pending.offset + frame.length, pending.pcm.length);
        pending.pcm.copy(frame, 0, pending.offset, end);
        pending.offset = end;
        if (end === pending.pcm.length && current) {
          current.inputEndMs = now() + (end % frame.length || frame.length) / 48;
        }
      }
      await client.request("talk.session.appendAudio", {
        sessionId,
        audioBase64: frame.toString("base64"),
      });
      if (pending && pending.offset === pending.pcm.length) {
        source = undefined;
        pending.done();
      }
      // A late acknowledgment must not produce a catch-up burst of audio.
      const lagMs = performance.now() - next;
      if (lagMs > 100) {
        record("inputCadenceLate", { lagMs });
      }
      next = Math.max(next + 100, performance.now());
      await sleep(Math.max(0, next - performance.now()));
    }
  })().catch((error: unknown) => {
    failure = String(error);
  });
  await sleep(1500);
  for (const fixture of fixtures) {
    if (failure) {
      break;
    }
    current = { fixture: fixture.name, complete: false };
    turns.push(current);
    audioDoneMs = undefined;
    lastSpeechMs = 0;
    record("inputStart");
    source = { pcm: fixture.pcm, offset: 0, done: () => record("inputSent") };
    const deadline = now() + fixture.pcm.length / 48 + 90_000;
    while (now() < deadline) {
      if (failure) {
        break;
      }
      while (marks.length && marks[0].at <= now()) {
        const mark = marks.shift()!;
        await client.request("talk.session.acknowledgeMark", { sessionId, markName: mark.name });
      }
      if (
        !source &&
        current.firstNonSilentPcmMs !== undefined &&
        audioDoneMs !== undefined &&
        now() > playbackUntilMs + 1500 &&
        now() > lastSpeechMs + 1500 &&
        (!values["require-agent"] ||
          (current.agentTerminalMs !== undefined && audioDoneMs >= current.agentTerminalMs))
      ) {
        current.complete = true;
        break;
      }
      await sleep(50);
    }
    if (current.inputEndMs !== undefined) {
      if (current.firstNonSilentPcmMs !== undefined) {
        current.inputEndToPcmMs = current.firstNonSilentPcmMs - current.inputEndMs;
      }
      if (current.firstPostAgentPcmMs !== undefined) {
        current.inputEndToPostAgentPcmMs = current.firstPostAgentPcmMs - current.inputEndMs;
      }
    }
    record("turnEnd", { complete: current.complete });
    if (!current.complete) {
      failure ??= "Turn timed out before complete audio and required agent result";
      break;
    }
    current = undefined;
    await sleep(1000);
  }
} catch (error) {
  failure = String(error);
} finally {
  pumping = false;
  await pump;
  if (sessionId) {
    try {
      await client.request("talk.session.close", { sessionId });
    } catch (error) {
      failure ??= `Close failed: ${String(error)}`;
    }
    try {
      history = await client.request("chat.history", { sessionKey, limit: 100 });
    } catch (error) {
      failure ??= `History capture failed: ${String(error)}`;
    }
  }
  client.stop();
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
  const complete =
    !failure && turns.length === fixtures.length && turns.every((turn) => turn.complete);
  await output.writeFile(
    JSON.stringify(
      {
        label: values.label,
        sessionKey,
        created,
        rmsThreshold: 0.01,
        complete,
        failure,
        turns,
        events,
        history,
      },
      null,
      2,
    ),
  );
  await output.close();
  console.log(
    JSON.stringify({
      label: values.label,
      complete,
      attempted: turns.length,
      expected: fixtures.length,
    }),
  );
  if (!complete) {
    process.exitCode = 1;
  }
}
