import { expectDefined } from "@openclaw/normalization-core/expect";
import { expect, it, vi } from "vitest";
import { createDeferred } from "../../test/helpers/promise.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { CronJobCreate } from "../cron/types.js";
import type { GatewayScheduler } from "../infra/gateway-scheduler.js";
import {
  beginAgentDeletionJournal,
  removeAgentDeletionJournal,
} from "../test-utils/agent-deletion-journal.js";
import {
  createGatewaySchedulerClock,
  createTestGatewayScheduler,
} from "../test-utils/gateway-scheduler-clock.js";
import { withOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import type { buildGatewayCronService } from "./server-cron.js";

type CronFixture = ReturnType<typeof buildGatewayCronService>;

function holdInventory(state: CronFixture) {
  const entered = createDeferred();
  const release = createDeferred();
  const listJobs = state.cron.list.bind(state.cron);
  vi.spyOn(state.cron, "list").mockImplementationOnce(async (options) => {
    entered.resolve();
    await release.promise;
    return listJobs(options);
  });
  return { entered, release, listJobs };
}

export function registerGatewayCronSystemJobTests({
  createCronConfig,
  loadCronService,
  withCronService,
  setRuntimeConfig,
  addAgentTurnJob,
}: {
  createCronConfig: (name: string) => OpenClawConfig;
  loadCronService: (cfg: OpenClawConfig, options?: { scheduler?: GatewayScheduler }) => CronFixture;
  withCronService: (
    cfg: OpenClawConfig,
    run: (state: CronFixture) => Promise<void>,
  ) => Promise<void>;
  setRuntimeConfig: (cfg: OpenClawConfig) => void;
  addAgentTurnJob: (
    state: CronFixture,
    name: string,
    message: string,
    overrides?: Partial<Omit<CronJobCreate, "name" | "payload">>,
  ) => ReturnType<CronFixture["cron"]["add"]>;
}) {
  const heartbeatDefaults = (every: string) => ({ defaults: { heartbeat: { every } } });
  it("finishes an accepted config replacement without a second reconciliation request", async () => {
    const cfg = {
      ...createCronConfig("server-cron-accepted-replacement"),
      agents: { entries: { main: { heartbeat: { every: "1h" } } } },
    } satisfies OpenClawConfig;
    const state = loadCronService(cfg);
    let held: ReturnType<typeof holdInventory> | undefined;
    try {
      await state.reconcileSystemJobs();
      held = holdInventory(state);
      const reconcile = state.reconcileSystemJobs();
      await held.entered.promise;
      setRuntimeConfig({
        ...cfg,
        agents: { entries: { main: { heartbeat: { every: "2h" } } } },
      });
      held.release.resolve();
      await expect(reconcile).resolves.toBe("converged");
      expect(await held.listJobs({ includeDisabled: true })).toContainEqual(
        expect.objectContaining({
          payload: { kind: "heartbeat" },
          schedule: expect.objectContaining({ everyMs: 7_200_000 }),
        }),
      );
    } finally {
      held?.release.resolve();
      state.cron.stop();
    }
  });

  it("supersedes an in-flight heartbeat monitor reconciliation before mutation", async () => {
    const autoConfig = {
      ...createCronConfig("server-cron-monitor-reconcile-auto"),
      agents: heartbeatDefaults("1h"),
    };
    const offConfig = { ...autoConfig, agents: heartbeatDefaults("0m") };
    await withCronService(autoConfig, async (state) => {
      await expect(state.reconcileSystemJobs()).resolves.toBe("converged");
      const held = holdInventory(state);
      const addJob = vi.spyOn(state.cron, "add");
      const removeJob = vi.spyOn(state.cron, "remove");

      setRuntimeConfig(offConfig);
      const disable = state.reconcileSystemJobs();
      await held.entered.promise;
      setRuntimeConfig(autoConfig);
      const reenable = state.reconcileSystemJobs();
      held.release.resolve();

      await expect(disable).resolves.toBe("superseded");
      await expect(reenable).resolves.toBe("converged");
      expect(addJob).not.toHaveBeenCalledWith(
        expect.objectContaining({ enabled: false }),
        expect.anything(),
      );
      expect(removeJob).not.toHaveBeenCalled();
    });
  });

  it.each(["stop", "replace", "supersede"] as const)(
    "observes %s between committed heartbeat monitor mutations",
    async (action) => {
      const baseConfig = createCronConfig(`server-cron-fairness-heartbeat-${action}`);
      const cfg = {
        ...baseConfig,
        cron: { ...baseConfig.cron, enabled: false },
        agents: { ownership: "explicit", ...heartbeatDefaults("1h"), entries: { a: {}, b: {} } },
      } satisfies OpenClawConfig;
      const replacement = {
        ...cfg,
        agents: { ...cfg.agents, ...heartbeatDefaults("2h") },
      } satisfies OpenClawConfig;
      const state = loadCronService(cfg);
      const addJob = state.cron.add.bind(state.cron);
      let checkpoint: Promise<void> | undefined;
      let nextPass: ReturnType<typeof state.reconcileSystemJobs> | undefined;
      const committed: Array<{ agentId?: string; everyMs?: number }> = [];
      vi.spyOn(state.cron, "add").mockImplementation(async (input, options) => {
        const result = await addJob(input, options);
        if (input.declarationKey?.startsWith("heartbeat:")) {
          committed.push({
            agentId: input.agentId,
            everyMs: input.schedule.kind === "every" ? input.schedule.everyMs : undefined,
          });
          checkpoint ??= new Promise((resolve) => {
            setImmediate(() => {
              if (action === "stop") {
                state.cron.stop();
              } else {
                setRuntimeConfig(replacement);
                if (action === "supersede") {
                  nextPass = state.reconcileSystemJobs();
                }
              }
              resolve();
            });
          });
        }
        return result;
      });
      try {
        const result = await state.reconcileSystemJobs();
        await checkpoint;
        if (action === "stop") {
          expect(result).toBe("superseded");
          expect(committed.map(({ agentId }) => agentId)).toEqual(["a"]);
        } else {
          expect(result).toBe(action === "replace" ? "converged" : "superseded");
          if (nextPass) {
            await expect(nextPass).resolves.toBe("converged");
          }
          expect(committed).not.toContainEqual({ agentId: "b", everyMs: 3_600_000 });
          const jobs = (await state.cron.list({ includeDisabled: true })).filter((job) =>
            job.declarationKey?.startsWith("heartbeat:"),
          );
          expect(
            jobs.toSorted((a, b) => String(a.agentId).localeCompare(String(b.agentId))),
          ).toMatchObject([
            { agentId: "a", schedule: { everyMs: 7_200_000 } },
            { agentId: "b", schedule: { everyMs: 7_200_000 } },
          ]);
        }
      } finally {
        try {
          await checkpoint;
          await nextPass;
        } finally {
          state.cron.stop();
        }
      }
    },
  );

  it("schedules a retry after a heartbeat inventory failure and cancels it on stop", async () => {
    const clock = createGatewaySchedulerClock(Date.now());
    const cfg = createCronConfig("server-cron-monitor-partial-failure");
    const state = loadCronService(cfg, { scheduler: createTestGatewayScheduler(clock.clock) });
    try {
      const inventory = vi
        .spyOn(state.cron, "list")
        .mockRejectedValueOnce(new Error("inventory failed"));
      await expect(state.reconcileSystemJobs()).resolves.toBe("retry-scheduled");
      state.cron.stop();
      const callsBeforeStop = inventory.mock.calls.length;
      await clock.advanceBy(30_000);
      expect(inventory).toHaveBeenCalledTimes(callsBeforeStop);
    } finally {
      state.cron.stop();
    }
  });

  it("defers a retiring agent's heartbeat monitor and restores it after deletion rolls back", async () => {
    await withOpenClawTestState({ label: "cron-monitor-retirement" }, async (fixture) => {
      const clock = createGatewaySchedulerClock(Date.now());
      const cfg = {
        cron: { enabled: false },
        agents: {
          ownership: "explicit",
          ...heartbeatDefaults("1h"),
          entries: { main: {}, retiring: {} },
        },
      } satisfies OpenClawConfig;
      const scheduler = createTestGatewayScheduler(clock.clock);
      const state = loadCronService(cfg, { scheduler });
      const listJobs = state.cron.list.bind(state.cron);
      let deletion: ReturnType<typeof beginAgentDeletionJournal> | undefined;
      const inventory = vi.spyOn(state.cron, "list").mockImplementationOnce(async (options) => {
        const jobs = await listJobs(options);
        deletion = beginAgentDeletionJournal({
          agentId: "retiring",
          operationId: "monitor-retirement",
          agentDir: fixture.agentDir("retiring"),
          workspaceDir: fixture.path("workspace-retiring"),
          sessionsDir: fixture.sessionsDir("retiring"),
          deleteFiles: false,
        });
        return jobs;
      });
      try {
        await expect(state.reconcileSystemJobs()).resolves.toBe("lifecycle-deferred");
        expect((await listJobs({ includeDisabled: true })).map((job) => job.agentId)).toEqual([
          "main",
        ]);
        await expect(
          addAgentTurnJob(state, "retired-owner", "must not run", { agentId: "retiring" }),
        ).rejects.toMatchObject({
          name: "CronAgentDeletionBlockedError",
          message: "cron job agent is unavailable: retiring",
        });

        expect(
          removeAgentDeletionJournal(
            "retiring",
            expectDefined(deletion, "deletion journal").operationId,
          ),
        ).toBe(true);
        await clock.advanceBy(30_000);
        expect(await listJobs({ includeDisabled: true })).toContainEqual(
          expect.objectContaining({
            agentId: "retiring",
            declarationKey: "heartbeat:retiring",
            enabled: true,
            schedule: expect.objectContaining({ everyMs: 3_600_000 }),
          }),
        );
      } finally {
        inventory.mockRestore();
        try {
          await state.cron.stopAndDrain?.();
        } finally {
          await scheduler.stop();
        }
      }
    });
  });
}
