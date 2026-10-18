// Covers gateway restart process and supervisor paths.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isGatewayWorkAdmissionClosed,
  resetGatewayWorkAdmission,
} from "../process/gateway-work-admission.js";
import { captureFullEnv, withEnv } from "../test-utils/env.js";
import { mockProcessPlatform } from "../test-utils/vitest-spies.js";

const spawnSyncMock = vi.hoisted(() => vi.fn());
const execFileMock = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    [Symbol.for("nodejs.util.promisify.custom")]: vi.fn(),
    __promisify__: vi.fn(),
  }),
);
const resolveLsofCommandSyncMock = vi.hoisted(() => vi.fn());
const resolveGatewayPortMock = vi.hoisted(() => vi.fn());
const observedArgv = vi.hoisted(() => new Map<number, string[]>());

vi.mock("node:fs", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:fs")>("node:fs"),
    (actual) => ({
      readFileSync: new Proxy(actual.readFileSync, {
        apply(target, receiver, args) {
          const pid = Number(/^\/proc\/(\d+)\/cmdline$/.exec(String(args[0]))?.[1]);
          const argv = observedArgv.get(pid);
          if (!argv) {
            return Reflect.apply(target, receiver, args);
          }
          const bytes = Buffer.from(argv.join("\0"));
          const encoding = typeof args[1] === "string" ? args[1] : args[1]?.encoding;
          return encoding ? bytes.toString(encoding) : bytes;
        },
      }),
    }),
    { mirrorToDefault: true },
  );
});
vi.mock("../process/supervisor/darwin-process-command.js", () => ({
  readDarwinProcessCommand: (pid: number) => {
    const argv = observedArgv.get(pid);
    return argv ? { argv } : undefined;
  },
}));

vi.mock("node:child_process", async () => {
  const { mockNodeBuiltinModule } = await import("openclaw/plugin-sdk/test-node-mocks");
  return mockNodeBuiltinModule(
    () => vi.importActual<typeof import("node:child_process")>("node:child_process"),
    {
      execFile: execFileMock,
      spawnSync: (...args: unknown[]) => spawnSyncMock(...args),
    } as Partial<typeof import("node:child_process")>,
  );
});

vi.mock("./ports-lsof.js", () => ({
  resolveLsofCommandSync: (...args: unknown[]) => resolveLsofCommandSyncMock(...args),
}));

vi.mock("../config/paths.js", () => ({
  resolveGatewayPort: (...args: unknown[]) => resolveGatewayPortMock(...args),
  resolveStateDir: (env: NodeJS.ProcessEnv = process.env) =>
    env.OPENCLAW_STATE_DIR ?? "/tmp/openclaw-state",
}));

const { cleanStaleGatewayProcessesSync, findGatewayPidsOnPortSync } =
  await import("./restart-stale-pids.js");
const {
  consumeGatewayRestartAuthorization,
  normalizeGatewayRestartDelayMs,
  requestGatewayRestartWithSignalAdmission,
  resetGatewayRestartStateForInProcessRestart,
  scheduleGatewayRestart,
  triggerOpenClawRestart,
} = await import("./restart.js");

const envSnapshot = captureFullEnv();

beforeEach(() => {
  observedArgv.clear();
  execFileMock.mockReset();
  spawnSyncMock.mockReset();
  resolveLsofCommandSyncMock.mockReset();
  resolveGatewayPortMock.mockReset();
  resolveLsofCommandSyncMock.mockReturnValue("/usr/sbin/lsof");
  resolveGatewayPortMock.mockReturnValue(18789);
  vi.spyOn(Atomics, "wait").mockReturnValue("timed-out");
});

afterEach(() => {
  envSnapshot.restore();
  vi.restoreAllMocks();
});

function expectLsofCall(port: number, first = false) {
  const call = [
    "/usr/sbin/lsof",
    ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-Fpc"],
    expect.objectContaining({ encoding: "utf8", timeout: 5000 }),
  ];
  if (first) {
    expect(spawnSyncMock.mock.calls[0]).toEqual(call);
  } else {
    expect(spawnSyncMock.mock.calls).toContainEqual(call);
  }
}

describe.runIf(process.platform !== "win32")("findGatewayPidsOnPortSync", () => {
  it("parses lsof output and filters non-openclaw/current processes", () => {
    mockProcessPlatform("linux");
    const gatewayPidA = process.pid + 1000;
    const gatewayPidB = process.pid + 2000;
    const foreignPid = process.pid + 3000;
    observedArgv.set(gatewayPidA, ["openclaw-gateway"]);
    observedArgv.set(gatewayPidB, ["openclaw", "gateway"]);
    observedArgv.set(foreignPid, ["python", "server.py"]);
    spawnSyncMock.mockReturnValue({
      error: undefined,
      status: 0,
      stdout: [
        `p${process.pid}`,
        "copenclaw",
        `p${gatewayPidA}`,
        "copenclaw-gateway",
        `p${foreignPid}`,
        "cnode",
        `p${gatewayPidB}`,
        "cOpenClaw",
      ].join("\n"),
    });

    const pids = findGatewayPidsOnPortSync(18789);

    expect(pids).toEqual([gatewayPidA, gatewayPidB]);
    expectLsofCall(18789);
  });
});

describe.runIf(process.platform !== "win32")("cleanStaleGatewayProcessesSync", () => {
  it("uses explicit port override when provided", () => {
    const stalePid = process.pid + 1000;
    observedArgv.set(stalePid, ["openclaw-gateway"]);
    spawnSyncMock
      .mockReturnValueOnce({
        error: undefined,
        status: 0,
        stdout: [`p${stalePid}`, "copenclaw"].join("\n"),
      })
      .mockReturnValue({
        error: undefined,
        status: 1,
        stdout: "",
      });
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);

    const killed = cleanStaleGatewayProcessesSync(19999);

    expect(killed).toEqual([stalePid]);
    expect(resolveGatewayPortMock).not.toHaveBeenCalled();
    const lsofCalls = spawnSyncMock.mock.calls.filter((call) => call[0] === "/usr/sbin/lsof");
    expect(lsofCalls).toHaveLength(2);
    expectLsofCall(19999, true);
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGTERM");
    expect(killSpy).toHaveBeenCalledWith(stalePid, "SIGKILL");
  });
});

describe("triggerOpenClawRestart", () => {
  function withLaunchAgent(bootstrapStatus: number, run: (uid: number) => void) {
    mockProcessPlatform("darwin");
    withEnv(
      { VITEST: undefined, NODE_ENV: undefined, HOME: "/Users/test", OPENCLAW_PROFILE: "default" },
      () => {
        spawnSyncMock.mockImplementation((command: string, args: string[]) => {
          if (command === "launchctl") {
            if (args[0] === "kickstart") {
              return args[1] === "-k"
                ? { error: undefined, status: 113, stderr: "service not loaded" }
                : { error: undefined, status: bootstrapStatus === 0 ? 1 : 0, stdout: "" };
            }
            if (args[0] === "bootstrap") {
              return {
                error: undefined,
                status: bootstrapStatus,
                stderr: bootstrapStatus === 0 ? "" : "Operation already in progress",
              };
            }
          }
          return { error: undefined, status: 1, stdout: "" };
        });
        run(typeof process.getuid === "function" ? process.getuid() : 501);
      },
    );
  }

  it("does not kickstart after bootstrap registers an unloaded LaunchAgent", () => {
    withLaunchAgent(0, (uid) => {
      const result = triggerOpenClawRestart();

      expect(result).toEqual({
        ok: true,
        method: "launchctl",
        tried: [
          `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
          `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
        ],
      });
    });
  });

  it("continues when launchctl bootstrap reports the service is already loaded", () => {
    withLaunchAgent(37, (uid) => {
      const result = triggerOpenClawRestart();

      expect(result).toEqual({
        ok: true,
        method: "launchctl",
        tried: [
          `launchctl kickstart -k gui/${uid}/ai.openclaw.gateway`,
          `launchctl bootstrap gui/${uid} /Users/test/Library/LaunchAgents/ai.openclaw.gateway.plist`,
          `launchctl kickstart gui/${uid}/ai.openclaw.gateway`,
        ],
      });
    });
  });
});

describe("gateway restart delivery and delay", () => {
  it("rejects restart without signaling an embedded host that has no restart handler", () => {
    mockProcessPlatform("linux");
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const listeners = process.listeners("SIGUSR2");
    process.removeAllListeners("SIGUSR2");
    resetGatewayRestartStateForInProcessRestart();
    resetGatewayWorkAdmission();
    try {
      expect(requestGatewayRestartWithSignalAdmission("embedded-host")).toEqual({
        status: "failed",
      });
      expect(killSpy).not.toHaveBeenCalled();
      expect(consumeGatewayRestartAuthorization()).toBe(false);
      expect(isGatewayWorkAdmissionClosed()).toBe(false);
    } finally {
      for (const listener of listeners) {
        process.on("SIGUSR2", listener);
      }
      resetGatewayRestartStateForInProcessRestart();
      resetGatewayWorkAdmission();
    }
  });

  it("uses the default delay when the requested delay is NaN", () => {
    expect(normalizeGatewayRestartDelayMs(Number.NaN)).toBe(2000);
  });

  it("does not emit an overflow-sized restart before its effective 60-second delay", async () => {
    vi.useFakeTimers();
    const killSpy = vi.spyOn(process, "kill").mockImplementation(() => true);
    try {
      const restart = scheduleGatewayRestart({
        delayMs: 2_147_153_648,
      });

      expect(restart.delayMs).toBe(60_000);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(killSpy).not.toHaveBeenCalled();
    } finally {
      resetGatewayRestartStateForInProcessRestart();
      vi.useRealTimers();
    }
  });
});
