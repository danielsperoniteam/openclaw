import type { ChildProcess } from "node:child_process";
import type { Worker } from "node:worker_threads";
import { expect, vi } from "vitest";
import { awaitGateBeforeSettlement, createDeferred } from "../../../test/helpers/promise.js";
import * as sqlite from "../../infra/node-sqlite.js";
import * as integrity from "../../infra/sqlite-integrity-worker.js";
import type { OpenClawAgentReadOnlyDatabase as ReadOnlyDatabase } from "../../state/openclaw-agent-db-readonly.js";
import { getOpenClawAgentDatabaseValidation } from "../../state/openclaw-agent-db-validation-cache.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { closeOpenClawStateDatabaseAsync } from "../../state/openclaw-state-db.js";
import { SqliteReclamationWorker as Reclaimer } from "./session-accessor.sqlite-reclamation-worker-lifetime.js";

type ReclamationRun = Parameters<Reclaimer["run"]>[0];

function interceptReclamationWorker(
  intercept: (params: ReclamationRun) => ReclamationRun,
  preparing?: () => void,
) {
  const prototype = Reclaimer.prototype;
  const run = prototype.run;
  vi.spyOn(prototype, "run").mockImplementation(function (this: Reclaimer, params) {
    return run.call(this, intercept(params));
  });
  if (preparing) {
    const prepare = prototype.prepare;
    vi.spyOn(prototype, "prepare").mockImplementation(function (this: Reclaimer, params) {
      preparing();
      return prepare.call(this, params);
    });
  }
}

const expectAdmission = <T>(entered: Promise<T>, operation: Promise<unknown>) =>
  awaitGateBeforeSettlement(entered, operation, "Operation completed before admission");

export function holdReclamationAdmission(databasePath: string) {
  const entered = createDeferred();
  const release = createDeferred();
  let admissions = 0;
  interceptReclamationWorker((params) => {
    if (
      params.plan.databaseOptions.path !== databasePath ||
      params.plan.kind !== "lifecycle-projection-commit"
    ) {
      return params;
    }
    return {
      ...params,
      withWriteAdmission: (performWrite, diagnostics) =>
        params.withWriteAdmission(async (...admissionArgs) => {
          if (!admissionArgs[0]) {
            admissions += 1;
            entered.resolve();
            await release.promise;
          }
          return performWrite(...admissionArgs);
        }, diagnostics),
    };
  });
  return {
    release,
    count: () => admissions,
    expectPending: (operation: Promise<unknown>) => expectAdmission(entered.promise, operation),
  };
}

export type PreparedIntegrityOwner = "executor" | "reclamation" | "other";
export type PreparedAdmissionHooks = {
  fork?: (child: ChildProcess) => void;
  afterMaterialize?: () => Promise<void>;
  integrityChecks?: SharedArrayBuffer;
  integrityRelease?: SharedArrayBuffer;
  integrityFirstCheck?: SharedArrayBuffer;
  integrityPath?: string;
  worker?: (worker: Worker, owner: PreparedIntegrityOwner) => void;
  integrityPhase?: (
    ...args: [Worker, PreparedIntegrityOwner, "checking" | "checked", boolean]
  ) => void;
};
type PreparedAdmissionContext = {
  hooks: PreparedAdmissionHooks;
  releases: Array<() => void>;
  own: <T>(promise: Promise<T>) => Promise<T>;
};
const realOpen = sqlite.openNodeSqliteDatabase;
const realIntegrity = integrity.assertSqliteIntegrityInWorker;

export function observePreparedAdmission(
  databasePath: string,
  { hooks, releases, own }: PreparedAdmissionContext,
  hold = false,
) {
  const checks = { parent: 0, admissions: 0, settled: 0 };
  let forkingIntegrity = false;
  const entered = createDeferred();
  const release = createDeferred();
  releases.push(() => release.resolve());
  if (!hold) {
    release.resolve();
  }
  const children: Array<{
    close?: [number | null, string | null];
    phases: integrity.SqliteIntegrityWorkerPhase[];
    resultOk?: boolean;
  }> = [];
  hooks.fork = (child) => {
    if (!forkingIntegrity) {
      return;
    }
    const row: (typeof children)[number] = { phases: [] };
    children.push(row);
    child.on("message", (message: integrity.SqliteIntegrityWorkerMessage) => {
      if ("type" in message) {
        row.phases.push(message.phase);
      } else {
        row.resultOk = message.ok;
      }
    });
    const closed = createDeferred();
    child.once("close", (code, signal) => {
      row.close = [code, signal];
      closed.resolve();
    });
    void own(closed.promise);
  };
  vi.spyOn(sqlite, "openNodeSqliteDatabase").mockImplementation((pathname, options) => {
    const database = realOpen(pathname, options);
    if (pathname !== databasePath || options?.readOnly) {
      return database;
    }
    const prepare = database.prepare.bind(database);
    database.prepare = (sql) => {
      const statement = prepare(sql);
      if (sql === "PRAGMA integrity_check;" || sql === "PRAGMA integrity_check('sqlite_schema');") {
        const all = statement.all.bind(statement);
        statement.all = () => {
          checks.parent += 1;
          return all();
        };
      }
      return statement;
    };
    return database;
  });
  vi.spyOn(integrity, "assertSqliteIntegrityInWorker").mockImplementation(async (...args) => {
    if (args[0] !== databasePath) {
      return await realIntegrity(...args);
    }
    checks.admissions += 1;
    let check: Promise<void>;
    forkingIntegrity = true;
    try {
      check = realIntegrity(...args);
    } finally {
      forkingIntegrity = false;
    }
    entered.resolve();
    await Promise.all([check, release.promise]).finally(() => checks.settled++);
  });
  return {
    release,
    expectPending: (operation: Promise<unknown>) => expectAdmission(entered.promise, operation),
    expectHealthy(count: number) {
      expect(checks).toEqual({ parent: 0, admissions: count, settled: count });
      expect(children.length).toBeGreaterThanOrEqual(count);
      expect(children.length).toBeLessThanOrEqual(count * 4);
      const phases = ["opening", "checking", "closing"];
      const expected = { close: [0, null], resultOk: true, phases };
      children.forEach((child) => expect(child).toEqual(expected));
    },
  };
}

export function observePreparedWorkerAdmission({
  databasePath,
  mode,
  hooks,
  releases,
  expectParentHealthy,
}: Omit<PreparedAdmissionContext, "own"> & {
  databasePath: string;
  mode: "warm" | "cold";
  expectParentHealthy: () => void;
}) {
  const entered = createDeferred<PreparedIntegrityOwner>();
  const counter = () => new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const counts = new Int32Array(counter());
  const release = new Int32Array(counter());
  const resume = () => {
    Atomics.store(release, 0, 1);
    Atomics.notify(release, 0);
  };
  releases.push(resume);
  if (mode === "warm") {
    resume();
  }
  Object.assign(hooks, {
    integrityChecks: counts.buffer,
    integrityRelease: release.buffer,
    integrityFirstCheck: mode === "cold" ? counter() : undefined,
    integrityPath: databasePath,
  });
  const workers: Worker[] = [];
  const phaseCounts = () => ({ executor: 0, reclamation: 0, other: 0 });
  const phases = { checking: phaseCounts(), checked: phaseCounts() };
  const heldCheck: { worker?: Worker; completed: boolean } = { completed: false };
  hooks.worker = (worker, owner) => {
    if (owner !== "other") {
      workers.push(worker);
    }
  };
  hooks.integrityPhase = (worker, owner, phase, held) => {
    phases[phase][owner] += 1;
    if (held) {
      if (phase === "checking") {
        // The atomic claimant, not cross-worker message order, identifies the held check.
        heldCheck.worker = worker;
        entered.resolve(owner);
      } else {
        heldCheck.completed = worker === heldCheck.worker;
      }
    }
  };
  return {
    release: { resolve: resume },
    expectPending: (operation: Promise<unknown>) => expectAdmission(entered.promise, operation),
    async expectHealthy(expected: Record<PreparedIntegrityOwner, number>) {
      expectParentHealthy();
      await closeOpenClawAgentDatabaseByPathAsync(databasePath);
      await closeOpenClawStateDatabaseAsync();
      expect(phases).toEqual({ checking: expected, checked: expected });
      const expectedCount = expected.executor + expected.reclamation + expected.other;
      expect(Atomics.load(counts, 0)).toBe(expectedCount);
      expect(heldCheck.completed).toBe(mode === "cold");
      expect([...new Set(workers.map(({ threadId }) => threadId))]).toEqual([-1]);
    },
  };
}

export function observeRetainedMaintenanceFinalizer(databasePath: string) {
  const finalizers: Array<[ReadOnlyDatabase | undefined, boolean, boolean, boolean]> = [];
  let preparations = 0;
  interceptReclamationWorker(
    (params) => {
      if (
        params.plan.databaseOptions.path === databasePath &&
        params.plan.kind === "maintenance-finalize"
      ) {
        const owner = params.validationOwner;
        const retained = owner && "database" in owner ? owner : undefined;
        finalizers.push([
          retained?.database,
          retained?.isCurrent() ?? false,
          retained?.database.db.isOpen ?? false,
          retained !== undefined &&
            getOpenClawAgentDatabaseValidation(retained.database) === undefined,
        ]);
      }
      return params;
    },
    () => preparations++,
  );
  return {
    expectExpired(database: OpenClawAgentDatabase) {
      expect(preparations, "retained finalization must not use cold preparation").toBe(0);
      expect(finalizers.map(([, ...facts]) => facts)).toEqual([[true, true, true]]);
      expect(finalizers[0]?.[0]).toBe(database);
    },
  };
}
