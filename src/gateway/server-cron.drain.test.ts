import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as nextTurn } from "node:timers/promises";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  awaitGateBeforeSettlement,
  createDeferred,
  withinTest,
} from "../../test/helpers/promise.js";
import type { CliDeps } from "../cli/deps.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isCronJobActive } from "../cron/active-jobs.js";
import { CronService } from "../cron/service.js";
import { waitForActiveCronTaskRuns } from "../cron/service/active-run-cancellation.js";
import { captureCronSchedulerWakeForTest } from "../cron/service/scheduler-actor.test-support.js";
import * as cronServiceState from "../cron/service/state.js";
import * as cronRunFinalization from "../cron/service/timer-outcome-finalization.js";
import * as cronStore from "../cron/store.js";
import { trackAsyncWork } from "../shared/async-work-scope.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";

const { cancelAllMock, getRuntimeConfigMock, stopAllMock } = vi.hoisted(() => ({
  cancelAllMock: vi.fn<() => Promise<void>>(),
  getRuntimeConfigMock: vi.fn(),
  stopAllMock: vi.fn<() => Promise<void>>(),
}));

vi.mock("../config/io.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../config/io.js")>()),
  getRuntimeConfig: getRuntimeConfigMock,
}));

vi.mock("./cron-exit-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-exit-watchers.js")>()),
  createCronExitWatchers: () => ({
    reconcile: vi.fn(),
    cancel: vi.fn(),
    cancelAll: cancelAllMock,
    activeJobIds: () => [],
    updateHandlers: vi.fn(),
  }),
}));

vi.mock("./cron-stream-watchers.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./cron-stream-watchers.js")>()),
  createCronStreamWatchers: () => ({
    reconcile: vi.fn(async () => {}),
    resume: vi.fn(),
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => {}),
    stopBeforeUpdate: vi.fn(() => undefined),
    stopAll: stopAllMock,
    activeJobIds: () => [],
    inspect: () => undefined,
  }),
}));

import { sessionChanges } from "../sessions/session-row-changes.js";
import { buildGatewayCronService } from "./server-cron.js";
import { sessionHasAutomation } from "./session-automation-index.js";

type StartedGatewayCron = {
  clock: ReturnType<typeof createGatewaySchedulerClock>;
  scheduler: ReturnType<typeof createTestGatewayScheduler>;
  state: ReturnType<typeof buildGatewayCronService>;
  cfg: OpenClawConfig;
  stateDir: string;
  cleanupError?: Error;
};
const fixtures: StartedGatewayCron[] = [];

async function startGatewayCron(
  label: string,
  enabled = true,
  broadcast: Parameters<typeof buildGatewayCronService>[0]["broadcast"] = () => {},
): Promise<StartedGatewayCron> {
  const stateDir = await mkdtemp(path.join(os.tmpdir(), `openclaw-cron-drain-${label}-`));
  const cfg: OpenClawConfig = {
    session: { mainKey: "main" },
    cron: { enabled, triggers: { enabled: true } },
  };
  getRuntimeConfigMock.mockReturnValue(cfg);
  const clock = createGatewaySchedulerClock(Date.now());
  const scheduler = createTestGatewayScheduler(clock.clock);
  const state = buildGatewayCronService({
    storePath: await cronStore.resolveCronJobsStorePathFromConfigAsync(cfg, {
      ...process.env,
      OPENCLAW_STATE_DIR: stateDir,
    }),
    scheduler,
    cfg,
    deps: {} as CliDeps,
    broadcast,
    env: { ...process.env, OPENCLAW_SKIP_CRON: "0", OPENCLAW_STATE_DIR: stateDir },
  });
  const fixture: StartedGatewayCron = { state, cfg, stateDir, clock, scheduler };
  fixtures.push(fixture);
  await state.cron.start();
  await state.cron.add({
    name: `${label} stream source`,
    enabled: true,
    schedule: { kind: "stream", command: ["source"] },
    payload: { kind: "systemEvent", text: "event" },
    sessionTarget: "main",
    wakeMode: "next-heartbeat",
  });
  return fixture;
}

async function cleanGatewayCron({ state, stateDir }: StartedGatewayCron): Promise<void> {
  try {
    await state.cron.stopAndDrain?.();
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}

async function finishPending(pending: unknown[], signal: AbortSignal) {
  await withinTest(Promise.allSettled(pending), signal);
}

function observe(promise: Promise<unknown>) {
  let outcome: { ok: true } | { ok: false; error: unknown } | undefined;
  return {
    get outcome() {
      return outcome;
    },
    settled: promise.then(
      () => {
        outcome = { ok: true };
      },
      (error: unknown) => {
        outcome = { ok: false, error };
      },
    ),
  };
}

async function enteredBeforeSettled(
  entered: Promise<void>,
  pending: Promise<unknown>,
  signal: AbortSignal,
  label: string,
) {
  await withinTest(awaitGateBeforeSettlement(entered, pending, label), signal);
}

async function withExitWatcher(
  label: string,
  run: (
    original: StartedGatewayCron,
    release: ReturnType<typeof createDeferred<void>>,
  ) => Promise<void>,
) {
  const release = createDeferred();
  cancelAllMock.mockReturnValue(release.promise);
  const original = await startGatewayCron(label);
  try {
    await run(original, release);
  } finally {
    release.resolve();
  }
}

async function addCommand(original: StartedGatewayCron, name: string, deleteAfterRun: boolean) {
  return original.state.cron.add({
    name,
    enabled: true,
    schedule: { kind: "at", at: new Date(original.clock.clock.now() - 1_000).toISOString() },
    payload: { kind: "command", argv: [process.execPath, "-e", "process.exit(0)"] },
    sessionTarget: "isolated",
    wakeMode: "next-heartbeat",
    delivery: { mode: "none" },
    deleteAfterRun,
  });
}

describe("gateway cron stop-and-drain automation ownership", () => {
  afterEach(async function cleanup() {
    const fixture = fixtures.pop();
    if (!fixture) {
      return;
    }
    try {
      if (fixture.cleanupError) {
        await expect(cleanGatewayCron(fixture)).rejects.toBe(fixture.cleanupError);
      } else {
        await cleanGatewayCron(fixture);
      }
    } finally {
      try {
        await fixture.scheduler.stop();
      } finally {
        await cleanup();
      }
    }
  });

  beforeEach(() => {
    cancelAllMock.mockReset();
    cancelAllMock.mockResolvedValue(undefined);
    getRuntimeConfigMock.mockReset();
    stopAllMock.mockReset();
    stopAllMock.mockResolvedValue(undefined);
  });

  it.for(["shutdown", "handoff", "watcher-failure"] as const)(
    "joins an in-flight system-job reconciliation during %s and permits restart",
    async (stopMode, { signal }) => {
      const original = await startGatewayCron(`system-jobs-${stopMode}`, false);
      // Disabled startup cancels watchers; join that setup before observing the handoff.
      await original.state.reconcileExitWatchers();
      cancelAllMock.mockClear();
      const cfg: OpenClawConfig = {
        ...original.cfg,
        agents: { entries: { main: { heartbeat: { every: "1h" } } } },
      };
      getRuntimeConfigMock.mockReturnValue(cfg);
      const entered = createDeferred();
      const release = createDeferred();
      const listJobs = original.state.cron.list.bind(original.state.cron);
      const inventory = vi
        .spyOn(original.state.cron, "list")
        .mockImplementationOnce(async (options) => {
          const snapshot = await listJobs(options);
          entered.resolve();
          await release.promise;
          return snapshot;
        });
      const add = vi.spyOn(original.state.cron, "add");
      const stopError = new Error("stream drain failed");
      const reconcile = original.state.reconcileSystemJobs();
      let drain: Promise<void> | undefined;
      let lateReconcile: ReturnType<typeof original.state.reconcileSystemJobs> | undefined;
      try {
        await enteredBeforeSettled(entered.promise, reconcile, signal, "System-job inventory gate");
        if (stopMode === "watcher-failure") {
          stopAllMock.mockRejectedValueOnce(stopError);
        }
        const stopped =
          stopMode === "handoff"
            ? expectDefined(
                await original.state.prepareExitWatcherHandoff?.(),
                "exit handoff",
              ).stopOwner()
            : expectDefined(original.state.cron.stopAndDrain?.(), "cron drain");
        const observed = observe(stopped);
        drain = observed.settled;
        lateReconcile = original.state.reconcileSystemJobs();
        await cronStore.loadCronJobsStoreWithConfigJobs(original.state.storePath);
        expect(observed.outcome).toBeUndefined();
        expect(add).not.toHaveBeenCalled();
        if (stopMode === "handoff") {
          expect(cancelAllMock).not.toHaveBeenCalled();
        }

        release.resolve();
        await withinTest(Promise.all([reconcile, lateReconcile, drain]), signal);
        await expect(reconcile).resolves.toBe("superseded");
        await expect(lateReconcile).resolves.toBe("superseded");
        expect(observed.outcome).toEqual(
          stopMode === "watcher-failure" ? { ok: false, error: stopError } : { ok: true },
        );
        expect(add).not.toHaveBeenCalled();

        await withinTest(original.state.cron.start(), signal);
        expect(await listJobs({ includeDisabled: true })).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              agentId: "main",
              payload: { kind: "heartbeat" },
              schedule: expect.objectContaining({ everyMs: 3_600_000 }),
            }),
          ]),
        );
      } finally {
        release.resolve();
        original.state.cron.stop();
        original.scheduler.beginClose();
        inventory.mockRestore();
        add.mockRestore();
        await finishPending([reconcile, lateReconcile, drain], signal);
      }
    },
  );

  it("joins a retired system-job retry callback without joining itself or sibling schedules", async ({
    signal,
  }) => {
    const original = await startGatewayCron("system-job-retry", false);
    const entered = createDeferred();
    const releaseChild = createDeferred();
    const listJobs = original.state.cron.list.bind(original.state.cron);
    const inventory = vi
      .spyOn(original.state.cron, "list")
      .mockRejectedValueOnce(new Error("inventory failed"));
    let retry: ReturnType<typeof original.clock.advanceBy> = undefined;
    let drain: Promise<void> | undefined;
    try {
      await expect(withinTest(original.state.reconcileSystemJobs(), signal)).resolves.toBe(
        "retry-scheduled",
      );
      inventory.mockImplementationOnce(async (options) => {
        const snapshot = await listJobs(options);
        void trackAsyncWork(() => releaseChild.promise);
        entered.resolve();
        return snapshot;
      });
      retry = original.clock.advanceBy(30_000);
      await enteredBeforeSettled(
        entered.promise,
        Promise.resolve(retry),
        signal,
        "Retry inventory gate",
      );
      // A newer pass can finish while the retired callback still owns a descendant.
      await expect(withinTest(original.state.reconcileSystemJobs(), signal)).resolves.toBe(
        "converged",
      );
      const observed = observe(expectDefined(original.state.cron.stopAndDrain?.(), "cron drain"));
      drain = observed.settled;
      const sibling = vi.fn();
      original.scheduler.schedule({ id: "system-job-retry-sibling", delayMs: 0, run: sibling });
      await withinTest(Promise.resolve(original.clock.advanceBy(0)), signal);
      await cronStore.loadCronJobsStoreWithConfigJobs(original.state.storePath);
      expect(sibling).toHaveBeenCalledOnce();
      expect(original.scheduler.signal.aborted).toBe(false);
      expect(observed.outcome).toBeUndefined();

      releaseChild.resolve();
      await withinTest(Promise.all([retry, drain]), signal);
      expect(observed.outcome).toEqual({ ok: true });
      const callsAfterStop = inventory.mock.calls.length;
      await original.clock.advanceBy(30_000);
      expect(inventory).toHaveBeenCalledTimes(callsAfterStop);
    } finally {
      releaseChild.resolve();
      original.state.cron.stop();
      original.scheduler.beginClose();
      inventory.mockRestore();
      await finishPending([retry, drain], signal);
    }
  });

  it("joins a self-stopped worker tick without closing sibling schedules", async ({ signal }) => {
    let ownedState: ReturnType<typeof cronServiceState.createCronServiceState> | undefined;
    const createState = cronServiceState.createCronServiceState;
    const captureState = vi.spyOn(cronServiceState, "createCronServiceState");
    captureState.mockImplementationOnce((deps) => {
      captureState.mockRestore();
      ownedState = createState(deps);
      return ownedState;
    });
    const { result: original, wake } = await captureCronSchedulerWakeForTest(() =>
      startGatewayCron("timer-scope"),
    );
    const cronState = expectDefined(ownedState, "constructed cron state");
    const entered = createDeferred();
    const release = createDeferred();
    const sibling = vi.fn();
    await original.state.cron.add({
      name: "stopped before reservation",
      enabled: true,
      schedule: { kind: "at", at: new Date(original.clock.clock.now() + 1_000).toISOString() },
      sessionTarget: "main",
      wakeMode: "next-heartbeat",
      payload: { kind: "systemEvent", text: "must remain due" },
    });
    const sessionAgents = vi
      .spyOn(cronState.deps, "resolveSessionStoreAgentIds")
      .mockImplementationOnce(async () => {
        original.state.cron.stop();
        entered.resolve();
        await release.promise;
        return [];
      });
    original.clock.setTime(original.clock.clock.now() + 1_000);
    const tick = wake(cronState);
    let drain: Promise<void> | undefined;
    try {
      await enteredBeforeSettled(
        entered.promise,
        Promise.resolve(tick),
        signal,
        "Worker maintenance gate",
      );
      const observed = observe(expectDefined(original.state.cron.stopAndDrain?.(), "cron drain"));
      drain = observed.settled;
      original.scheduler.schedule({ id: "cron-drain-sibling", delayMs: 0, run: sibling });
      await withinTest(Promise.resolve(original.clock.advanceBy(0)), signal);
      await cronStore.loadCronJobsStoreWithConfigJobs(original.state.storePath);
      expect(sibling).toHaveBeenCalledOnce();
      expect(original.scheduler.signal.aborted).toBe(false);
      expect(observed.outcome).toBeUndefined();

      release.resolve();
      await withinTest(Promise.all([tick, drain]), signal);
      expect(observed.outcome).toEqual({ ok: true });
    } finally {
      release.resolve();
      original.state.cron.stop();
      original.scheduler.beginClose();
      sessionAgents.mockRestore();
      await finishPending([tick, drain], signal);
    }
  });

  it.each(["success", "exit-watcher-failure"] as const)(
    "waits for durable manual-run finalization after its payload has settled (%s)",
    async (stopResult) => {
      const finalizationEntered = createDeferred();
      const releaseFinalization = createDeferred();
      const stopError = new Error("exit watcher drain failed");
      let jobId: string | undefined;
      const original = await startGatewayCron("finalization", false);
      const finalize = cronRunFinalization.finalizeCompletedCronRunOutcomes;
      const finalization = vi
        .spyOn(cronRunFinalization, "finalizeCompletedCronRunOutcomes")
        .mockImplementation(async (cronState, outcomes, opts) => {
          if (outcomes.some((outcome) => outcome.jobId === jobId)) {
            finalizationEntered.resolve();
            await releaseFinalization.promise;
          }
          return finalize(cronState, outcomes, opts);
        });
      let run: Promise<unknown> | undefined;
      let drain: Promise<void> | undefined;
      try {
        const job = await addCommand(original, "finalization drain", false);
        jobId = job.id;
        run = original.state.cron.run(job.id, "force");
        await awaitGateBeforeSettlement(
          finalizationEntered.promise,
          run,
          "Cron run settled before entering finalization",
        );
        expect(await waitForActiveCronTaskRuns(0)).toEqual({ drained: true, active: 0 });
        expect(isCronJobActive(job.id)).toBe(true);
        if (stopResult === "exit-watcher-failure") {
          cancelAllMock.mockRejectedValueOnce(stopError);
          original.cleanupError = stopError;
        }
        const observed = observe(expectDefined(original.state.cron.stopAndDrain?.(), "cron drain"));
        drain = observed.settled;
        const pending = (
          await cronStore.loadCronJobsStoreWithConfigJobs(original.state.storePath)
        ).store.jobs.find((entry) => entry.id === job.id);
        expect(pending?.state.runningAtMs).toEqual(expect.any(Number));
        expect(pending?.state.lastRunStatus).toBeUndefined();
        expect(observed.outcome).toBeUndefined();

        releaseFinalization.resolve();
        await expect(run).resolves.toMatchObject({ ok: true, ran: true });
        await drain;
        expect(observed.outcome).toEqual(
          stopResult === "success" ? { ok: true } : { ok: false, error: stopError },
        );
        const completed = (
          await cronStore.loadCronJobsStoreWithConfigJobs(original.state.storePath)
        ).store.jobs.find((entry) => entry.id === job.id);
        expect(completed).toMatchObject({ enabled: false, state: { lastRunStatus: "ok" } });
        expect(completed?.state.runningAtMs).toBeUndefined();
        expect(isCronJobActive(job.id)).toBe(false);
      } finally {
        releaseFinalization.resolve();
        finalization.mockRestore();
        await Promise.allSettled([run, drain]);
      }
    },
  );

  it.each([false, true])(
    "publishes a one-shot binding removal after completion (delete=%s)",
    async (deleteAfterRun) => {
      const original = await startGatewayCron(`one-shot-${deleteAfterRun}`, false);
      const changed = vi.fn();
      let stop = () => {};
      try {
        const job = await addCommand(original, "one-shot binding", deleteAfterRun);
        const key = `agent:main:cron:${job.id}`;
        expect(sessionHasAutomation(key, original.cfg)).toBe(true);
        stop = sessionChanges.subscribe(changed);
        expect(await original.state.cron.run(job.id, "force")).toMatchObject({
          ok: true,
          ran: true,
        });
        expect(original.state.cron.getJob(job.id)?.state.lastError).toBeUndefined();
        expect(sessionHasAutomation(key, original.cfg)).toBe(false);
        const automation = changed.mock.calls
          .map(([change]) => change)
          .filter((change) => change.scope === "automation");
        expect(automation).toEqual([{ sessionKey: key, scope: "automation" }]);
        expect(original.state.cron.getJob(job.id)?.enabled).toBe(
          deleteAfterRun ? undefined : false,
        );
      } finally {
        stop();
      }
    },
  );

  it.each(["drain", "restart"] as const)(
    "waits for cancelled exit watchers before completing %s",
    async (action) => {
      await withExitWatcher(`exit-watcher-${action}`, async ({ state }, release) => {
        if (action === "restart") {
          state.cron.stop();
        }
        const observed = observe(
          action === "restart"
            ? state.cron.start()
            : expectDefined(state.cron.stopAndDrain?.(), "cron drain"),
        );
        await vi.waitFor(() => expect(cancelAllMock).toHaveBeenCalledOnce());
        await nextTurn();
        expect(observed.outcome).toBeUndefined();
        release.resolve();
        await observed.settled;
        expect(observed.outcome).toEqual({ ok: true });
      });
    },
  );

  it.each(["resume", "stop"] as const)(
    "joins concurrent starts while paused until %s",
    async (action) => {
      const broadcast = vi.fn();
      const start = vi.spyOn(CronService.prototype, "start");
      const original = await startGatewayCron(`paused-start-${action}`, true, broadcast);
      try {
        await original.state.cron.stopAndDrain?.();
        start.mockClear();
        broadcast.mockClear();
        original.state.cron.pauseScheduling();
        const starts = [original.state.cron.start(), original.state.cron.start()];
        await nextTurn();
        expect(start).not.toHaveBeenCalled();
        expect(original.state.cron.getSuspensionBlockerCount?.()).toBeGreaterThan(0);
        expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
        expect(broadcast).not.toHaveBeenCalled();

        if (action === "resume") {
          original.state.cron.resumeScheduling();
          await Promise.all(starts);
          await original.state.cron.start();
          expect(start).toHaveBeenCalledOnce();
          expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);
          expect(broadcast).toHaveBeenCalledExactlyOnceWith(
            "sessions.changed",
            { reason: "cron-bindings-loaded", ts: expect.any(Number) },
            { dropIfSlow: true },
          );
        } else {
          await original.state.cron.stopAndDrain?.();
          await Promise.all(starts);
          expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
          expect(broadcast).not.toHaveBeenCalled();
        }
        expect(original.state.cron.getSuspensionBlockerCount?.()).toBe(0);
      } finally {
        start.mockRestore();
      }
    },
  );

  it("does not reopen the scheduler when a later stop wins a pending restart", async () => {
    await withExitWatcher("exit-watcher-restart-cancelled", async (original, release) => {
      original.state.cron.stop();
      const restart = original.state.cron.start();
      await vi.waitFor(() => expect(cancelAllMock).toHaveBeenCalledOnce());

      original.state.cron.stop();
      release.resolve();
      await restart;

      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
    });
  });

  it("observes asynchronous exit cleanup failure and preserves it across drain and restart", async () => {
    const exitWatcherDrain = createDeferred();
    cancelAllMock.mockReturnValue(exitWatcherDrain.promise);
    const original = await startGatewayCron("exit-watcher-cleanup-failure");
    const error = new Error("cleanup could not be confirmed");
    original.cleanupError = error;
    try {
      original.state.cron.stop();
      exitWatcherDrain.reject(error);
      // cron.stop has no returned promise; its owner must observe rejection itself.
      await nextTurn();
      expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
      await expect(original.state.cron.stopAndDrain?.()).rejects.toBe(error);
      await expect(original.state.cron.start()).rejects.toBe(error);
      await expect(original.state.cron.stopAndDrain?.()).rejects.toBe(error);
      expect(cancelAllMock).toHaveBeenCalledOnce();
    } finally {
      exitWatcherDrain.reject(error);
    }
  });

  it("observes failed exit cleanup during disabled reconciliation", async () => {
    const original = await startGatewayCron("disabled-exit-cleanup-failure", false);
    const error = new Error("cleanup could not be confirmed");
    original.cleanupError = error;
    await original.state.reconcileExitWatchers();
    cancelAllMock.mockRejectedValue(error);
    await expect(original.state.reconcileExitWatchers()).resolves.toBeUndefined();
    await nextTurn();
  });

  it("unregisters a stopped scheduler when stream draining fails and permits retry", async () => {
    stopAllMock.mockRejectedValueOnce(new Error("stream drain failed"));
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("failed");

    expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);
    await expect(original.state.cron.stopAndDrain?.()).rejects.toThrow("stream drain failed");
    expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
    await expect(original.state.cron.stopAndDrain?.()).resolves.toBeUndefined();
    expect(stopAllMock).toHaveBeenCalledTimes(2);
    expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(false);
  });

  it("does not unregister a replacement scheduler when a stale drain fails", async () => {
    const pendingDrain = createDeferred();
    stopAllMock.mockImplementationOnce(() => pendingDrain.promise);
    stopAllMock.mockResolvedValue(undefined);
    const original = await startGatewayCron("stale");
    expect(sessionHasAutomation("agent:main:main", original.cfg)).toBe(true);
    const staleDrain = expectDefined(original.state.cron.stopAndDrain?.(), "cron drain");
    const replacement = await startGatewayCron("replacement");
    expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
    const failedDrain = expect(staleDrain).rejects.toThrow("stream drain failed");
    pendingDrain.reject(new Error("stream drain failed"));
    await failedDrain;
    expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
    await expect(original.state.cron.stopAndDrain?.()).resolves.toBeUndefined();
    expect(sessionHasAutomation("agent:main:main", replacement.cfg)).toBe(true);
  });
});
