import { copyFileSync, existsSync, renameSync } from "node:fs";
import path from "node:path";
import { deserialize } from "node:v8";
import { Worker } from "node:worker_threads";
import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it, vi } from "vitest";
import {
  SqliteWorkerError,
  hasSqliteWorkerOutcomeUnknown,
  type SqliteWorkerRequest,
} from "../../infra/sqlite-worker-contract.js";
import * as operationAdmission from "../../infra/sqlite-worker-operation-admission.js";
import { sqliteWorkerOwnerProbe as probe } from "../../infra/sqlite-worker-owner-probe.test-support.js";
import * as sqliteWorkerStore from "../../infra/sqlite-worker-store.js";
import { closeOpenClawAgentDatabasesAsync } from "../../state/openclaw-agent-db.js";
import * as executions from "../../state/openclaw-agent-execution.js";
import * as workerPublications from "../../state/openclaw-agent-worker-store.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { captureOpenClawStateWorkerContext } from "../../state/openclaw-state-worker-context.js";
import {
  authProfileCredentialPublication,
  captureAuthProfileCredentialAuthority,
} from "../../state/user-model-account-authority.js";
import {
  connectUserModelAccount,
  readUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { ensureGatewayOwnerProfile } from "../../state/user-profiles.js";
import { withEnv } from "../../test-utils/env.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { noteCommittedSharedAuthStoreOwnership } from "./path-resolve.js";
import { loadPersistedAuthProfileStore as readPersistedStore } from "./persisted.js";
import { mergeLocalAuthProfileStoreWithInheritedStore } from "./runtime-snapshot-owner.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  getRuntimeAuthProfileStoreSnapshotCore as snapshot,
  registerRuntimeAuthProfileStoreMutationListener,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import * as sqliteRead from "./sqlite-read.js";
import {
  runAuthProfileWriteTransaction,
  resolveAuthProfileDatabasePath,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import {
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import * as publication from "./store-update-publication.js";
import { withEnvOnlyAuthProfileStore } from "./store.js";
import type { AuthProfileStore } from "./types.js";
import { reserveAuthProfileUsagePreparation } from "./usage-lifecycle.js";

const saveOptions = { filterExternalAuthProfiles: false, syncExternalCli: false };
const credential = (key: string) => ({ type: "api_key" as const, provider: "fixture", key });
const makeStore = (
  keys: Record<string, string>,
  state: Partial<Omit<AuthProfileStore, "profiles" | "version">> = {},
): AuthProfileStore => ({
  version: 1,
  profiles: Object.fromEntries(Object.entries(keys).map(([id, key]) => [id, credential(key)])),
  ...state,
});
function save(current: AuthProfileStore, agentDir?: string) {
  saveAuthProfileStore(current, agentDir, saveOptions);
}
function seedInherited(shared: AuthProfileStore, local: AuthProfileStore, agentDir: string) {
  save(shared);
  save(local, agentDir);
  setRuntimeAuthProfileStoreSnapshot(shared);
  setRuntimeAuthProfileStoreSnapshot(
    mergeLocalAuthProfileStoreWithInheritedStore(local, shared),
    agentDir,
  );
}
function updateSelected(key: string, agentDir?: string, sharedStoreWrite = false) {
  return updateAuthProfileStoreWithLock({
    agentDir,
    sharedStoreWrite,
    saveOptions,
    updater(current) {
      current.profiles.selected = credential(key);
      return true;
    },
  });
}
const withState = (run: Parameters<typeof withOpenClawTestState>[1]) =>
  withOpenClawTestState({ scenario: "minimal" }, run);

async function prepareCredentialReader(env: NodeJS.ProcessEnv, agentDir?: string) {
  const context = captureOpenClawStateWorkerContext({ env });
  const reader = agentDir
    ? sqliteRead.prepareAgentAuthProfileRowsRead({
        databasePath: resolveAuthProfileDatabasePath(agentDir),
        agentId: "child",
        env,
      })
    : undefined;
  try {
    const authority = reader
      ? reader.captureCredentialAuthority("selected")!
      : captureAuthProfileCredentialAuthority(
          context,
          {
            identity: `${context.admission.identity.key}:${context.admission.identity.birthtime ?? ""}`,
            databasePath: context.admission.databasePath,
          },
          "selected",
        );
    const rows = reader ? await reader.read() : await sqliteRead.readSharedAuthProfileRows(context);
    authority.observe(
      sqliteRead.loadPersistedAuthProfileStoreFromRows(
        rows,
        agentDir ? resolveAuthProfileDatabasePath(agentDir) : context.admission.databasePath,
      )?.profiles.selected,
    );
    return authority.readCurrentCredential;
  } finally {
    await reader?.dispose();
  }
}

afterEach(() => {
  vi.restoreAllMocks();
  clearRuntimeAuthProfileStoreSnapshots();
});

it.each(["shared", "agent"] as const)(
  "publishes %s credentials before release and preserves authority for metadata and rollback",
  async (target) => {
    await withState(async (state) => {
      const agentDir = target === "agent" ? state.agentDir("child") : undefined;
      const original = credential("synthetic-before");
      const replacement = credential("synthetic-after");
      save(makeStore({ selected: "synthetic-before" }), agentDir);
      const readCurrent = await prepareCredentialReader(state.env, agentDir);
      expect(readCurrent()).toEqual(original);
      let mode: "credential" | "metadata" | "rollback" = "credential";
      let grants = 0;
      let receipts = 0;
      const settled: unknown[] = [];
      const unsubscribe = authProfileCredentialPublication.subscribeFacts((change) => {
        if (change.kind === "settled") {
          settled.push(readCurrent());
        }
      });
      probe.admission(operationAdmission, (request, grant, admit) => {
        admit(request, (beforeRelease) => {
          if (request.stage === "commit") {
            grants++;
            if (mode === "metadata") {
              expect(readCurrent()).toEqual(replacement);
            } else {
              expect(readCurrent).toThrow("Auth profile credential authority is unavailable");
            }
            if (mode === "rollback") {
              throw new Error("synthetic credential commit refusal");
            }
          }
          return grant(beforeRelease);
        });
      });
      const observe = operationAdmission.observeSqliteWorkerCommittedFacts;
      vi.spyOn(operationAdmission, "observeSqliteWorkerCommittedFacts").mockImplementation(
        (admission, publish) =>
          observe(admission, (receipt) => {
            if (isRecord(receipt.facts) && receipt.facts.authCredentials) {
              receipts++;
              expect(readCurrent).toThrow("Auth profile credential authority is unavailable");
            }
            publish(receipt);
          }),
      );
      const update = (updater: (store: AuthProfileStore) => boolean) =>
        updateAuthProfileStoreWithLock({
          agentDir,
          sharedStoreWrite: target === "shared",
          saveOptions,
          updater,
        });
      try {
        await update((store) => {
          store.profiles.selected = replacement;
          return true;
        });
        expect(receipts).toBe(1);
        expect(settled).toEqual([replacement]);
        expect(readCurrent()).toEqual(replacement);
        mode = "metadata";
        await update((store) => {
          store.order = { fixture: ["selected"] };
          return true;
        });
        expect(receipts).toBe(1);
        expect(settled).toHaveLength(1);
        mode = "rollback";
        await expect(
          update((store) => {
            store.profiles.selected = credential("synthetic-refused");
            return true;
          }),
        ).rejects.toThrow("synthetic credential commit refusal");
        expect(grants).toBe(3);
        expect(settled).toEqual([replacement, replacement]);
        expect(readCurrent()).toEqual(replacement);
        expect(readPersistedStore(agentDir)?.profiles.selected).toEqual(replacement);
      } finally {
        unsubscribe();
      }
    });
  },
);

it("keeps shared credentials denied after worker death without a native outcome", async () => {
  await withState(async (state) => {
    save(makeStore({ selected: "synthetic-before" }));
    const readCurrent = await prepareCredentialReader(state.env);
    let target: { worker: Worker } | undefined;
    let terminated: Promise<number> | undefined;
    // oxlint-disable-next-line typescript/unbound-method -- The intercepted worker remains the receiver.
    const post = Worker.prototype.postMessage;
    vi.spyOn(Worker.prototype, "postMessage").mockImplementation(function (
      this: Worker,
      request: SqliteWorkerRequest,
      transferList,
    ) {
      if (request.type === "execute") {
        const command: unknown = deserialize(request.input);
        if (isRecord(command) && command.type === "authProfiles.update") {
          target = { worker: this };
        }
      }
      return post.call(this, request, transferList);
    });
    probe.admission(operationAdmission, (request, grant, admit) => {
      admit(request, (beforeRelease) => {
        if (target && request.stage === "commit") {
          expect(readCurrent).toThrow("Auth profile credential authority is unavailable");
          terminated = target.worker.terminate();
          return false;
        }
        return grant(beforeRelease);
      });
    });
    try {
      const failure = await updateSelected("synthetic-uncertain", undefined, true).catch(
        (error: unknown) => error,
      );
      expect(terminated).toBeDefined();
      expect(hasSqliteWorkerOutcomeUnknown(failure)).toBe(true);
      expect(readCurrent).toThrow();
      const recaptured = await prepareCredentialReader(state.env);
      expect(recaptured).toThrow("Auth profile credential authority is unavailable");
    } finally {
      await terminated;
    }
  });
});

it("keeps env-only agent callbacks isolated when saving", async () => {
  await withState(async (state) => {
    const localDir = state.agentDir("child");
    const shared = makeStore({ shared: "synthetic-hidden-shared" });
    const local = makeStore({ local: "synthetic-hidden-local" });
    const empty = makeStore({});
    const explicit = makeStore({ added: "synthetic-explicit" });
    save(shared);
    save(local, localDir);
    const updater = vi.fn<Parameters<typeof updateAuthProfileStoreWithLock>[0]["updater"]>(
      (store, _owner, inherited) => {
        expect(store).toEqual(empty);
        expect(inherited).toBeNull();
        store.profiles.added = explicit.profiles.added;
        return true;
      },
    );

    const result = await withEnvOnlyAuthProfileStore(() =>
      updateAuthProfileStoreWithLock({
        agentDir: localDir,
        saveOptions,
        updater,
      }),
    );
    expect(updater).toHaveBeenCalledOnce();
    expect(result).toEqual(explicit);
    expect(readPersistedStore()).toEqual(shared);
    expect(readPersistedStore(localDir)).toEqual(explicit);
  });
});

it("rejects a native auth owner before initializing its state directory", async () => {
  await withState(async (state) => {
    const refusedRoot = path.join(state.stateDir, "refused");
    expect(() =>
      runAuthProfileWriteTransaction(undefined, () => undefined, {
        stateDir: refusedRoot,
        sharedStoreWrite: true,
        assertEnvironment(env) {
          expect(env.OPENCLAW_STATE_DIR).toBe(refusedRoot);
          throw new Error("synthetic native owner revoked");
        },
      }),
    ).toThrow("synthetic native owner revoked");
    expect(existsSync(refusedRoot)).toBe(false);
  });
});

it.for(["local", "legacy-shared"] as const)(
  "retains the %s physical store before waiting for auth FIFO preparation",
  async (kind) => {
    await withState(async (state) => {
      const agentDir = state.agentDir(kind === "local" ? "child" : "main");
      noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" }, state.env);
      runAuthProfileWriteTransaction(
        agentDir,
        (database) => {
          writePersistedAuthProfileStoreRaw(
            makeStore({ selected: "synthetic-before" }),
            agentDir,
            database,
          );
        },
        { env: state.env },
      );
      await closeOpenClawAgentDatabasesAsync();
      const databasePath = resolveAuthProfileDatabasePath(agentDir);
      const reservation = reserveAuthProfileUsagePreparation([
        resolveOpenClawStateSqlitePath(state.env),
      ]);
      const updater = vi.fn(() => false);
      const updating = updateAuthProfileStoreWithLock({
        agentDir: kind === "local" ? agentDir : undefined,
        saveOptions,
        updater,
      });
      void updating.catch(() => {});
      try {
        const original = `${databasePath}.original`;
        renameSync(databasePath, original);
        copyFileSync(original, databasePath);
        reservation.release();
        await expect(updating).rejects.toThrow(/identity|physical|observed target/i);
        expect(updater).not.toHaveBeenCalled();
      } finally {
        reservation.release();
        await Promise.allSettled([updating]);
      }
    });
  },
);

it.each(["stale", "newer-write", "rebound-owner"])(
  "invalidates an unacknowledged commit after release with a %s view",
  async (scenario) => {
    await withState(async (state) => {
      const agentDir = state.agentDir("child");
      const initial = makeStore({ selected: "synthetic-before" });
      save(initial, agentDir);
      setRuntimeAuthProfileStoreSnapshot(initial, agentDir);
      const capture = executions.captureOpenClawAgentDatabaseExecution;
      let execution: ReturnType<typeof capture> | undefined;
      vi.spyOn(executions, "captureOpenClawAgentDatabaseExecution").mockImplementation(
        (...args) => {
          execution = capture(...args);
          return execution;
        },
      );
      const publish = workerPublications.executeOpenClawAgentWorkerPublication;
      vi.spyOn(workerPublications, "executeOpenClawAgentWorkerPublication").mockImplementation(
        async (...args) => {
          await publish(...args);
          if (scenario === "newer-write") {
            save(makeStore({ selected: "synthetic-newer" }), agentDir);
          }
          if (scenario === "rebound-owner") {
            withEnv({ OPENCLAW_STATE_DIR: path.join(state.stateDir, "rebound") }, () => {
              noteCommittedSharedAuthStoreOwnership({ location: "legacy-main" });
              setRuntimeAuthProfileStoreSnapshot(
                makeStore({ selected: "synthetic-rebound" }),
                agentDir,
              );
            });
          }
          if (!execution) {
            throw new Error("Missing real auth execution");
          }
          // Release revokes the real borrow synchronously; its pending operation must settle first.
          void execution.release().catch(() => {});
          throw new SqliteWorkerError("Synthetic lost commit acknowledgment", "outcome-unknown");
        },
      );
      await expect(updateSelected("synthetic-committed", agentDir)).rejects.toThrow();
      expect(readPersistedStore(agentDir)?.profiles.selected).toEqual(
        credential(scenario === "newer-write" ? "synthetic-newer" : "synthetic-committed"),
      );
      if (scenario === "newer-write") {
        expect(
          loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false }).profiles.selected,
        ).toEqual(credential("synthetic-newer"));
      } else if (scenario === "rebound-owner") {
        expect(snapshot(agentDir)?.profiles.selected).toEqual(credential("synthetic-rebound"));
      } else {
        expect(snapshot(agentDir)).toBeUndefined();
      }
    });
  },
);

it("drops incomplete incremental views after an acknowledged shared publication fails", async () => {
  await withState(async (state) => {
    const shared = makeStore({ selected: "synthetic-before", other: "synthetic-other" });
    const agentDir = state.agentDir("child");
    seedInherited(shared, makeStore({}), agentDir);
    let unregister = () => {};
    vi.spyOn(publication, "publishAuthProfileStoreUpdate").mockImplementation(async () => {
      const newer = readPersistedStore()!;
      newer.profiles.other = credential("synthetic-native");
      save(newer);
      unregister = registerRuntimeAuthProfileStoreMutationListener(() => {
        throw new Error("synthetic invalidation observer failure");
      });
      throw new Error("synthetic publication interruption");
    });
    try {
      await updateSelected("synthetic-committed", undefined, true);
    } finally {
      unregister();
    }
    const expected = {
      selected: credential("synthetic-committed"),
      other: credential("synthetic-native"),
    };
    expect(readPersistedStore()?.profiles).toEqual(expected);
    expect(loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false }).profiles).toEqual(
      expected,
    );
  });
});

it.each([
  { target: "shared", changed: "selected", rollback: false },
  { target: "shared", changed: "other", rollback: false },
  { target: "agent", changed: "selected", rollback: false },
  { target: "shared", changed: "selected", rollback: true },
])(
  "reconciles an overtaking $target native save of $changed (rollback=$rollback)",
  async ({ target, changed, rollback }) => {
    await withState(async (state) => {
      const agentDir = target === "agent" ? state.agentDir("child") : undefined;
      const initial = makeStore({ selected: "synthetic-before", other: "synthetic-other" });
      save(initial, agentDir);
      setRuntimeAuthProfileStoreSnapshot(initial, agentDir);
      const derivedDir = state.agentDir("derived");
      if (target === "shared") {
        const empty = makeStore({});
        save(empty, derivedDir);
        setRuntimeAuthProfileStoreSnapshot(
          mergeLocalAuthProfileStoreWithInheritedStore(empty, initial),
          derivedDir,
        );
      }
      const publish = publication.publishAuthProfileStoreUpdate;
      vi.spyOn(publication, "publishAuthProfileStoreUpdate").mockImplementation(async (...args) => {
        const newer = readPersistedStore(agentDir)!;
        newer.profiles[changed] = credential("synthetic-native");
        if (rollback) {
          expect(() =>
            runAuthProfileWriteTransaction(agentDir, () => {
              save(newer, agentDir);
              throw new Error("synthetic rollback");
            }),
          ).toThrow("synthetic rollback");
        } else {
          save(newer, agentDir);
        }
        return publish(...args);
      });
      await updateSelected("synthetic-worker", agentDir);
      const expected: AuthProfileStore["profiles"] = {
        ...initial.profiles,
        selected: credential("synthetic-worker"),
      };
      if (!rollback) {
        expected[changed] = credential("synthetic-native");
      }
      expect(readPersistedStore(agentDir)?.profiles).toEqual(expected);
      expect(snapshot(agentDir)?.profiles).toEqual(expected);
      if (target === "shared") {
        expect(snapshot(derivedDir)?.profiles).toEqual(expected);
      }
    });
  },
);

it.each(["selected"])(
  "does not retain old inherited order when a native rotation of %s overtakes state publication",
  async (profileId) => {
    await withState(async (state) => {
      const shared = makeStore(
        { selected: "synthetic-shared", other: "synthetic-other", third: "synthetic-third" },
        { order: { fixture: ["selected", "other", "third"] } },
      );
      const local = makeStore({ selected: "synthetic-local" });
      const agentDir = state.agentDir("child");
      seedInherited(shared, local, agentDir);
      const prepare = sqliteRead.prepareAgentAuthProfileRowsRead;
      let rotated = false;
      vi.spyOn(sqliteRead, "prepareAgentAuthProfileRowsRead").mockImplementation((options) => {
        const reader = prepare(options);
        return {
          ...reader,
          async read() {
            const rows = await reader.read();
            if (!rotated) {
              rotated = true;
              const newer = readPersistedStore()!;
              newer.profiles[profileId] = credential("synthetic-rotated");
              save(newer);
            }
            return rows;
          },
        };
      });
      await updateAuthProfileStoreWithLock({
        sharedStoreWrite: true,
        saveOptions,
        updater(store) {
          store.order = { fixture: ["selected", "third", "other"] };
          return true;
        },
      });
      expect(rotated).toBe(true);
      const published = loadAuthProfileStoreForRuntime(agentDir, { syncExternalCli: false });
      expect(published.order).toEqual({ fixture: ["selected", "third", "other"] });
      expect(published.profiles.selected).toEqual(local.profiles.selected);
    });
  },
);

it("keeps a shared rotation that commits while a local save awaits publication", async () => {
  await withState(async (state) => {
    const shared = makeStore({ shared: "synthetic-shared-before" });
    const local = makeStore({ local: "synthetic-local-before" });
    const agentDir = state.agentDir("child");
    seedInherited(shared, local, agentDir);
    const publish = publication.publishAuthProfileStoreUpdate;
    let rotated = false;
    vi.spyOn(publication, "publishAuthProfileStoreUpdate").mockImplementation(
      async (owner, committed, assertCurrent, nativeCommits, committedIsCurrent) => {
        if (!rotated && owner.databasePath !== owner.sharedDatabasePath) {
          rotated = true;
          await updateAuthProfileStoreWithLock({
            sharedStoreWrite: true,
            saveOptions,
            updater(store) {
              store.profiles.shared = credential("synthetic-shared-after");
              return true;
            },
          });
        }
        return publish(owner, committed, assertCurrent, nativeCommits, committedIsCurrent);
      },
    );
    await updateAuthProfileStoreWithLock({
      agentDir,
      saveOptions,
      updater(store) {
        store.profiles.local = credential("synthetic-local-after");
        return true;
      },
    });
    expect(rotated).toBe(true);
    expect(snapshot(agentDir)?.profiles).toEqual({
      local: credential("synthetic-local-after"),
      shared: credential("synthetic-shared-after"),
    });
    expect(readPersistedStore(agentDir)?.profiles).toEqual({
      local: credential("synthetic-local-after"),
    });
  });
});

it.each(["before-callback", "in-callback", "commit"] as const)(
  "refuses personal-account update authority revoked at %s",
  async (phase) => {
    await withState(async () => {
      const original = {
        type: "token" as const,
        provider: "anthropic",
        token: "synthetic-personal-before",
      };
      const { authProfileId } = connectUserModelAccount({
        ownerProfileId: ensureGatewayOwnerProfile("Synthetic owner").id,
        credential: original,
        assertCurrent() {},
      });
      let revoked = phase === "before-callback";
      if (phase === "commit") {
        const createAdmission = sqliteWorkerStore.createSqliteWorkerWriteAdmission;
        vi.spyOn(sqliteWorkerStore, "createSqliteWorkerWriteAdmission").mockImplementation(
          (assertCurrent, nativeLocations, attachment) =>
            createAdmission(
              (request) => {
                if (request.stage === "commit") {
                  revoked = true;
                }
                assertCurrent(request);
              },
              nativeLocations,
              attachment,
            ),
        );
      }
      const updater = vi.fn((store: AuthProfileStore) => {
        store.profiles[authProfileId] = { ...original, token: "synthetic-personal-after" };
        revoked = phase === "in-callback";
        return true;
      });
      await expect(
        updateAuthProfileStoreWithLock({
          profileId: authProfileId,
          updater,
          assertCurrent() {
            if (revoked) {
              throw new Error("synthetic personal authority revoked");
            }
          },
        }),
      ).rejects.toThrow("synthetic personal authority revoked");
      expect(updater).toHaveBeenCalledTimes(phase === "before-callback" ? 0 : 1);
      expect(readUserModelAuthProfile(authProfileId)?.credential).toEqual(original);
    });
  },
);
