import assert from "node:assert/strict";
import fs from "node:fs";
import type { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, test, vi } from "vitest";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { sqliteReaderDatabasePathKey } from "../../infra/sqlite-reader-lifecycle.js";
import * as walCheckpoint from "../../infra/sqlite-wal-checkpoint.js";
import { observeSqliteWalPeriodicWork } from "../../infra/sqlite-wal-scheduler.test-support.js";
import { configureSqliteWalMaintenance } from "../../infra/sqlite-wal.js";
import * as workerAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import { closeCachedOpenClawAgentDatabase } from "../../state/openclaw-agent-db-lifecycle.js";
import { withOpenClawAgentDatabaseReadOnly } from "../../state/openclaw-agent-db-readonly.js";
import { drainAgentDatabaseResources } from "../../state/openclaw-agent-db-resources.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  getOpenClawAgentDatabaseIfOpen,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import {
  closeOpenClawStateDatabaseByPathAsync,
  closeOpenClawStateDatabaseForTest,
} from "../../state/openclaw-state-db.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withSqliteSessionPageReclamation } from "./session-accessor.sqlite-page-reclamation.js";
import { runSqliteSessionReclamation } from "./session-accessor.sqlite-reclamation-run.js";
import { createLifecycleArtifactReclamationPlan } from "./session-accessor.sqlite-reclamation.js";
import { runExclusiveSqliteSessionWrite } from "./session-accessor.sqlite-scope.js";
import {
  deferPhysicalBudgetForCheckpoint,
  getBudgetKickState,
} from "./session-history-budget-state.js";

const hooks = vi.hoisted(() => ({
  admitted: undefined as (() => void) | undefined,
}));
vi.mock("./session-accessor.sqlite-scope.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./session-accessor.sqlite-scope.js")>();
  return {
    ...actual,
    runExclusiveSqliteSessionWrite: ((scope, run, operation, ...rest) =>
      actual.runExclusiveSqliteSessionWrite(
        scope,
        async () => {
          if (operation === "session.reclamation.worker-commit") {
            hooks.admitted?.();
          }
          return run();
        },
        operation,
        ...rest,
      )) satisfies typeof actual.runExclusiveSqliteSessionWrite,
  };
});

const tempDirs = useAutoCleanupTempDirTracker(afterEach);
afterEach(async () => {
  hooks.admitted = undefined;
  await closeOpenClawAgentDatabasesAsync();
  closeOpenClawAgentDatabasesForTest();
  closeOpenClawStateDatabaseForTest();
});

function createFixture() {
  const env = { OPENCLAW_STATE_DIR: tempDirs.make("openclaw-reclamation-wal-") };
  const options = { agentId: "main", env };
  const database = openOpenClawAgentDatabase(options);
  return {
    database,
    databaseOptions: { ...options, path: database.path },
    freePages: () => Number(database.db.prepare("PRAGMA freelist_count").get()?.freelist_count),
  };
}

function targetsDatabase(facts: unknown, pathKey: string) {
  return (
    isRecord(facts) &&
    isRecord(facts.identity) &&
    typeof facts.identity.nativeLocation === "string" &&
    sqliteReaderDatabasePathKey(facts.identity.nativeLocation) === pathKey
  );
}

function expectReclaimed(pages: number, limit: number) {
  expect(pages).toBeGreaterThan(0);
  expect(pages).toBeLessThanOrEqual(limit);
}

test.each(["reclaim", "resource-close", "shared-state-close"] as const)(
  "reclaims pages off-thread and applies current checkpoint receipts (%s)",
  async (recovery) => {
    const { database, databaseOptions, freePages } = createFixture();
    const databasePathKey = sqliteReaderDatabasePathKey(database.path);
    database.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
    VALUES ('wal-proof', 'pages', zeroblob(4194304), 1);
    DELETE FROM cache_entries WHERE scope = 'wal-proof';`);
    expect(database.walMaintenance.checkpoint()).toBe(true);
    const { DatabaseSync } = requireNodeSqlite();
    const reader = new DatabaseSync(database.path, { readOnly: true });
    using parentReclaim = vi.spyOn(database.walMaintenance, "reclaimFreePages");
    const ordering: string[] = [];
    const params = {
      storePath: database.path,
      mode: "enforce" as const,
      maintenance: { maxDiskBytes: 1, highWaterBytes: 1 },
    };
    const budget = getBudgetKickState(params.storePath, params.maintenance);
    let commitRequestedAtNs: bigint | undefined;
    const observeAdmission = probe.admission(workerAdmission, (request, grant, admit) => {
      if (request.stage === "commit" && targetsDatabase(request.facts, databasePathKey)) {
        commitRequestedAtNs = process.hrtime.bigint();
      }
      admit(request, grant);
    });
    let completedAt: number | undefined;
    const relayedCompletions: number[] = [];
    const publish = walCheckpoint.publishSqliteWalCheckpointObservation;
    const relay = vi
      .spyOn(walCheckpoint, "publishSqliteWalCheckpointObservation")
      .mockImplementation((databasePath, snapshot) => {
        if (
          sqliteReaderDatabasePathKey(databasePath) !== databasePathKey ||
          snapshot.health.state !== "complete" ||
          completedAt === undefined
        ) {
          return publish(databasePath, snapshot);
        }
        relayedCompletions.push(completedAt);
        return publish(databasePath, {
          ...snapshot,
          health: {
            ...snapshot.health,
            observedAtMs: completedAt,
            lastCompletedAtMs: completedAt,
          },
        });
      });
    let following: Promise<void> | undefined;
    try {
      reader.exec("BEGIN");
      reader.prepare("SELECT COUNT(*) FROM cache_entries").get();
      database.db.exec(`INSERT INTO cache_entries(scope, key, blob, updated_at)
      VALUES ('wal-proof', 'live', X'72657461696E6564', 1);`);
      const original = freePages();
      await withSqliteSessionPageReclamation(databaseOptions, (reclaim) =>
        runExclusiveSqliteSessionWrite(
          databaseOptions,
          async () => {
            ordering.push("archive-start");
            following = runExclusiveSqliteSessionWrite(
              databaseOptions,
              async () => {
                ordering.push("following-writer");
              },
              "session.transcript.batch",
            );
            const blocked = await reclaim();
            expect(blocked).toMatchObject({
              checkpointCompleted: false,
              checkpoint: { health: { state: "blocked" } },
              checkpointIncomplete: 1,
              vacuumPasses: 0,
            });
            expect(freePages()).toBe(original);
            deferPhysicalBudgetForCheckpoint(params, database.path, blocked.checkpoint);
            assert(blocked.checkpoint);
            completedAt = blocked.checkpoint.health.observedAtMs - 1;
            if (recovery === "reclaim") {
              reader.exec("ROLLBACK");
              const completed = await reclaim(7);
              expect(completed).toMatchObject({
                checkpointCompleted: true,
                checkpointIncomplete: 0,
                vacuumPasses: 1,
                vacuumPagesRequested: 7,
              });
              assert(commitRequestedAtNs !== undefined);
              assert(completed.checkpoint);
              expect(completed.checkpoint.observedAtNs).toBeGreaterThanOrEqual(commitRequestedAtNs);
              expectReclaimed(original - freePages(), 7);
            }
            expect(ordering).toEqual(["archive-start"]);
            ordering.push("archive-complete");
          },
          "session.history.archive-prune",
        ),
      );
      await following;
      expect(ordering).toEqual(["archive-start", "archive-complete", "following-writer"]);
      expect(parentReclaim).not.toHaveBeenCalled();
      if (recovery !== "reclaim") {
        closeCachedOpenClawAgentDatabase(database);
        expect(database.db.isOpen).toBe(false);
        const deferredCheckpoint = budget.checkpointBlocked;
        assert(deferredCheckpoint);
        const observed: string[] = [];
        const unsubscribe = walCheckpoint.onSqliteWalCheckpoint(({ databasePath, health }) => {
          if (databasePath === databasePathKey) {
            observed.push(health.state);
          }
        });
        let closing: Promise<void> | undefined;
        try {
          reader.exec("ROLLBACK");
          reader.close();
          expect(budget.checkpointBlocked).toBe(deferredCheckpoint);
          if (recovery === "shared-state-close") {
            const { admission } = captureOpenClawStateWorkerContext({ env: databaseOptions.env });
            admission.assertCurrent();
            closing = closeOpenClawStateDatabaseByPathAsync(admission.databasePath).then(
              () => undefined,
            );
            expect(() => admission.assertCurrent()).toThrow("admission is closed");
          } else {
            closing = drainAgentDatabaseResources(
              { path: database.path, agentId: databaseOptions.agentId },
              async () => undefined,
            );
          }
          await closing;
          const walPath = `${database.path}-wal`;
          expect(fs.existsSync(walPath) ? fs.statSync(walPath).size : 0).toBe(0);
          expect(observed).toContain("complete");
        } finally {
          await Promise.allSettled([closing]);
          unsubscribe();
        }
      }
      expect(relayedCompletions.length).toBeGreaterThan(0);
      expect(budget.checkpointBlocked).toBeUndefined();
    } finally {
      if (reader.isOpen) {
        if (reader.isTransaction) {
          reader.exec("ROLLBACK");
        }
        reader.close();
      }
      relay.mockRestore();
      observeAdmission.mockRestore();
      await Promise.allSettled([following]);
    }
  },
);

test("periodic vacuum waits for an admitted reclamation to settle", async () => {
  const { database, databaseOptions, freePages } = createFixture();
  // sqlite-allow-raw -- Disposable free pages exercise the real incremental vacuum.
  database.db.exec(`CREATE TABLE reclamation_fixture (payload BLOB);
      INSERT INTO reclamation_fixture VALUES (zeroblob(8388608));
      DROP TABLE reclamation_fixture;`);
  const before = freePages();
  expect(before).toBeGreaterThan(512);
  const plan = createLifecycleArtifactReclamationPlan({
    agentId: databaseOptions.agentId,
    databaseOptions,
    entries: [],
    materializedPlans: [],
  });
  const maintenanceErrors: unknown[] = [];
  let nativeSettled = false;
  let reclamationWorker: Worker | undefined;
  const stopObservingWorkers: Array<() => void> = [];
  const observeWorker = (worker: Worker) => {
    const onMessage = (message: unknown) => {
      if (isRecord(message) && message.type === "admission-request") {
        reclamationWorker = worker;
        nativeSettled = false;
      }
      if (
        worker === reclamationWorker &&
        isRecord(message) &&
        (message.type === "reclaimed" || message.type === "refused") &&
        message.settled === true
      ) {
        nativeSettled = true;
      }
    };
    const onExit = () => {
      if (worker === reclamationWorker) {
        nativeSettled = true;
      }
    };
    worker.on("message", onMessage);
    worker.once("exit", onExit);
    stopObservingWorkers.push(() => {
      worker.off("message", onMessage);
      worker.off("exit", onExit);
    });
  };
  process.on("worker", observeWorker);
  const maintenanceAdmissions: Array<{
    stage: "transaction" | "commit";
    nativeSettled: boolean;
  }> = [];
  const databasePathKey = sqliteReaderDatabasePathKey(database.path);
  using _ = probe.admission(workerAdmission, (request, grant, admit) => {
    if (
      (request.stage === "transaction" || request.stage === "commit") &&
      targetsDatabase(request.facts, databasePathKey)
    ) {
      maintenanceAdmissions.push({ stage: request.stage, nativeSettled });
    }
    admit(request, grant);
  });
  using execSpy = vi.spyOn(database.db, "exec");
  const scheduled = observeSqliteWalPeriodicWork();
  let maintenance: ReturnType<typeof configureSqliteWalMaintenance>;
  try {
    maintenance = configureSqliteWalMaintenance(requireNativeSqliteDatabase(database.db), {
      busyTimeoutMs: 1_000,
      onCheckpointError: (error) => maintenanceErrors.push(error),
    });
  } finally {
    scheduled.restore();
  }
  const periodic = scheduled.periodic;
  const periodicWork: Promise<unknown>[] = [];
  hooks.admitted = () => {
    // Periodic work must join behind the writer whose admission is already held.
    periodicWork.push(Promise.resolve(periodic()));
  };
  try {
    const reclamation = runSqliteSessionReclamation({ plan });
    await expect(reclamation).resolves.toMatchObject({
      kind: "lifecycle-artifacts",
      value: { removedEntries: 0 },
    });
    expect(periodicWork.length).toBeGreaterThan(0);
    await Promise.all(periodicWork);
    expect(maintenanceAdmissions[0]).toEqual({ stage: "transaction", nativeSettled: true });
    expect(maintenanceAdmissions.some((request) => request.stage === "commit")).toBe(true);
    expect(maintenanceAdmissions.every((request) => request.nativeSettled)).toBe(true);
    expect(
      execSpy.mock.calls.filter(([statement]) =>
        statement.startsWith("PRAGMA incremental_vacuum("),
      ),
    ).toEqual([]);
    expect(getOpenClawAgentDatabaseIfOpen(databaseOptions)?.db === database.db).toBe(true);
    await maintenance.stop();
    maintenance.close({ checkpointMode: "PASSIVE" });
    await closeOpenClawAgentDatabasesAsync();
    expect(reclamationWorker?.threadId).toBe(-1);
    const remaining = withOpenClawAgentDatabaseReadOnly(
      ({ db }) => Number(db.prepare("PRAGMA freelist_count").get()?.freelist_count),
      databaseOptions,
    );
    assert.ok(remaining.found);
    expectReclaimed(before - remaining.value, 512);
    expect(maintenanceErrors).toEqual([]);
  } finally {
    process.off("worker", observeWorker);
    for (const stop of stopObservingWorkers) {
      stop();
    }
    await maintenance.stop();
    await Promise.all(periodicWork);
    if (database.db.isOpen) {
      maintenance.close({ checkpointMode: "PASSIVE" });
    }
    await closeOpenClawAgentDatabasesAsync();
  }
}, 20_000);
