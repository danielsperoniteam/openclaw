import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { prepareSecretsRuntimeFastPathSnapshot } from "../../secrets/runtime-fast-path.js";
import {
  activateSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotState,
  getActiveSecretsRuntimeSnapshotRevisionState,
  graftActiveSecretsRuntimeAuthState,
  prepareSecretsRuntimeSnapshotRestoreState,
  activateSecretsRuntimeSnapshotStateIfCurrent,
} from "../../secrets/runtime-state.js";
import { closeOpenClawAgentDatabaseByPathAsync } from "../../state/openclaw-agent-db.js";
import { withEnv } from "../../test-utils/env.js";
import {
  loadPersistedAuthProfileStore as readPersistedStore,
  loadPersistedSharedAuthProfileStore as readSharedStore,
} from "./persisted.js";
import {
  getRuntimeAuthProfileStoreCredentialsRevision,
  getRuntimeAuthProfileStoreSnapshotsRevision,
  listOwnedRuntimeAuthProfileStoreSnapshots,
  prepareRuntimeAuthProfileStoreSnapshots,
  replaceOwnedRuntimeAuthProfileStoreSnapshots,
  setRuntimeAuthProfileStoreSnapshot as setSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots,
} from "./runtime-snapshots.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  loadAuthProfileStoreWithoutExternalProfiles as readStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches as saveIfUnchanged,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";
import {
  captureAuthProfileStorePersistenceSnapshot as capturePersistence,
  restoreAuthProfileStorePersistenceSnapshot as restorePersistence,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot } =
  createAuthOwnerTestFixtures();

type Root = Awaited<ReturnType<typeof seedRoot>>;
function update(
  root: Root,
  agentDir: string | undefined,
  mutate: (store: AuthProfileStore) => void,
) {
  return updateAuthProfileStoreWithLock({
    stateDir: root.stateDir,
    agentDir,
    saveOptions,
    updater: (current) => {
      mutate(current);
      return true;
    },
  });
}
function bindSnapshot(root: Root, agentDir: string) {
  withEnv(root.env, () => setSnapshot(readStore(agentDir), agentDir));
}
function prepare(
  root: Root,
  agentDir: string,
  loadAuthStore = () => withEnv(root.env, () => readStore(agentDir)),
) {
  const prepared = prepareSecretsRuntimeFastPathSnapshot({
    config: {},
    env: root.env,
    agentDirs: [agentDir],
    loadAuthStore,
  });
  if (!prepared) {
    throw new Error("missing prepared snapshot");
  }
  return prepared;
}
function commitShared(root: Root, baseline: ReturnType<typeof capturePersistence>, key: string) {
  return saveIfUnchanged({
    snapshot: baseline,
    stateDir: root.stateDir,
    store: store(key),
    options: saveOptions,
  });
}
function restoreActive(
  snapshot: NonNullable<ReturnType<typeof getActiveSecretsRuntimeSnapshotState>>,
  ownedSnapshot: typeof snapshot,
  expectedRevision: ReturnType<typeof getActiveSecretsRuntimeSnapshotRevisionState>,
) {
  expect(
    activateSecretsRuntimeSnapshotStateIfCurrent(
      prepareSecretsRuntimeSnapshotRestoreState({
        snapshot,
        ownedSnapshot,
        expectedRevision,
        refreshContext: null,
        refreshHandler: null,
      })!,
    ),
  ).toBe(true);
}

describe("explicit auth state ownership", () => {
  it.each(["mixed-live", "cleared-local"] as const)(
    "preserves $0 bookkeeping ownership across shared-root activation",
    async (bookkeepingOwner) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const agentDir = first.agentDir;
      const profileId = "local";
      const updateBookkeeping = (root: Root, lastUsed: number) =>
        update(root, agentDir, (current) => {
          current.usageStats = { [profileId]: { lastUsed, cooldownUntil: lastUsed + 60_000 } };
        });

      await update(first, undefined, (current) => {
        const sharedProfileId = bookkeepingOwner === "cleared-local" ? "local" : "shared";
        if (bookkeepingOwner === "cleared-local") {
          current.profiles.local = apiKey("shared-local");
        }
        current.usageStats = { [sharedProfileId]: { lastUsed: 30, cooldownUntil: 60_030 } };
      });
      const sharedProfileId = bookkeepingOwner === "cleared-local" ? "local" : "shared";
      expect(readSharedStore(first.env)?.usageStats?.[sharedProfileId]?.lastUsed).toBe(30);
      await updateBookkeeping(first, 10);
      if (bookkeepingOwner === "mixed-live") {
        await update(second, undefined, (current) => {
          current.usageStats = { shared: { lastUsed: 40 } };
        });
      }
      bindSnapshot(second, agentDir);
      const prepared = prepare(first, agentDir);
      expect(prepared.snapshot.authStores[0]?.store?.runtimeInheritsMainState === true).toBe(
        bookkeepingOwner === "mixed-live",
      );

      await closeOpenClawAgentDatabaseByPathAsync(first.agentPath);
      if (bookkeepingOwner === "cleared-local") {
        await update(second, agentDir, (current) => {
          delete current.usageStats;
        });
      } else {
        await updateBookkeeping(second, 20);
      }
      expect(getRuntimeAuthProfileStoreCredentialsRevision()).toBe(
        prepared.snapshot.authStoreCredentialsRevision,
      );
      expect(snapshotAt(first.agentPath)?.runtimeInheritsMainState === true).toBe(
        bookkeepingOwner === "mixed-live",
      );
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null });
      const expectedLastUsed = bookkeepingOwner === "cleared-local" ? 30 : 20;
      expect(snapshotAt(first.agentPath)?.usageStats?.[profileId]).toEqual({
        lastUsed: expectedLastUsed,
        cooldownUntil: expectedLastUsed + 60_000,
      });

      expect(snapshotAt(first.agentPath)?.usageStats?.[sharedProfileId]).toEqual({
        lastUsed: 30,
        cooldownUntil: 60_030,
      });
      expect(snapshotAt(first.agentPath)?.runtimeInheritsMainState).toBe(true);
    },
  );

  it("keeps known public snapshot owners across an unrelated outer overlay update", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const assertOuterUnchanged = unreadableOuter("future");
    replaceRuntimeAuthProfileStoreSnapshots(
      listOwnedRuntimeAuthProfileStoreSnapshots().map((entry) => {
        if (entry.databasePath === first.agentPath) {
          entry.store.usageStats = { shared: { lastUsed: 123 } };
        }
        return entry;
      }),
    );
    await update(second, undefined, (current) => {
      current.profiles.shared = apiKey("updated-second");
    });
    expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("updated-second"));
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    assertOuterUnchanged();
  });

  it.each(["rollback", "newer-same", "graft"] as const)(
    "preserves shared-root authority through %s on one agent database",
    async (mode) => {
      const currentKey = mode === "newer-same" ? "second" : "third";
      const [first, second, third] = await Promise.all([
        seedRoot("first"),
        seedRoot("second"),
        seedRoot(currentKey),
      ]);
      const agentDir = tempDirs.make("openclaw-auth-owner-rebound-agent-");
      if (mode === "rollback") {
        await persistAuthProfileBatch({
          stateDir: first.stateDir,
          agentDir,
          profiles: [{ profileId: "local", credential: apiKey("stable-local") }],
        });
        for (const [root, lastUsed] of [
          [first, 10],
          [second, 20],
        ] as const) {
          await update(root, undefined, (current) => {
            current.usageStats = { shared: { lastUsed } };
          });
        }
      }
      const activate = (root: typeof first) => {
        const prepared = prepare(root, agentDir);
        activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null });
      };
      activate(first);
      const baseline = getActiveSecretsRuntimeSnapshotState()!;
      activate(second);
      const owned = getActiveSecretsRuntimeSnapshotState()!;
      const revision = getActiveSecretsRuntimeSnapshotRevisionState();
      const expected = mode === "rollback" ? first : third;
      if (mode === "rollback") {
        await closeOpenClawAgentDatabaseByPathAsync(resolveAuthProfileDatabasePath(agentDir));
        await update(second, agentDir, (current) => {
          current.usageStats = { local: { lastUsed: 25 } };
        });
      }
      if (mode !== "rollback") {
        withEnv(third.env, () => setSnapshot(store(currentKey), agentDir));
      }
      vi.stubEnv("OPENCLAW_STATE_DIR", third.stateDir);
      if (mode === "graft") {
        const prepared = prepare(first, agentDir);
        graftActiveSecretsRuntimeAuthState(prepared.snapshot);
        activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null });
      } else {
        restoreActive(baseline, owned, revision);
      }
      expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
        apiKey(mode === "rollback" ? "first" : currentKey),
      );
      if (mode === "rollback") {
        expect(
          snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.usageStats?.local?.lastUsed,
        ).toBe(25);
        expect(
          snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.usageStats?.shared?.lastUsed,
        ).toBe(10);
      }
      await update(expected, undefined, (current) => {
        current.profiles.shared = apiKey("updated-owner");
      });
      expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
        apiKey("updated-owner"),
      );
    },
  );

  it("rejects a prepared snapshot after a scope-only owner transition", async () => {
    const first = await seedRoot("same");
    const second = await seedRoot("same");
    const agentDir = tempDirs.make("openclaw-auth-owner-stale-preparation-");
    withEnv(first.env, () => setSnapshot(store("same"), agentDir));
    const prepared = prepare(first, agentDir, () => store("same"));
    withEnv(second.env, () => setSnapshot(store("same"), agentDir));
    expect(() =>
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null }),
    ).toThrow("stale");
  });

  it("retains a removed snapshot owner through secrets activation rollback", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const captured = withEnv(first.env, () => {
      const activate = (authStores: Array<{ agentDir: string; store: AuthProfileStore }>) => {
        activateSecretsRuntimeSnapshotState({
          snapshot: {
            sourceConfig: {},
            config: {},
            authStores: prepareRuntimeAuthProfileStoreSnapshots(authStores),
            authStoreCredentialsRevision: getRuntimeAuthProfileStoreCredentialsRevision(),
            authStoreSnapshotsRevision: getRuntimeAuthProfileStoreSnapshotsRevision(),
            warnings: [],
            webTools: {
              search: { providerSource: "none", diagnostics: [] },
              fetch: { providerSource: "none", diagnostics: [] },
              diagnostics: [],
            },
          },
          refreshContext: null,
          refreshHandler: null,
        });
      };
      activate([
        {
          agentDir: first.agentDir,
          store: readStore(first.agentDir),
        },
      ]);
      const baseline = getActiveSecretsRuntimeSnapshotState();
      activate([]);
      const owned = getActiveSecretsRuntimeSnapshotState();
      if (!baseline || !owned) {
        throw new Error("missing activated secrets snapshot");
      }
      return { baseline, owned, revision: getActiveSecretsRuntimeSnapshotRevisionState() };
    });
    expect(snapshotAt(first.agentPath)).toBeUndefined();
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    restoreActive(captured.baseline, captured.owned, captured.revision);
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    await update(first, undefined, (current) => {
      current.profiles.shared = apiKey("updated-first");
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(readSharedStore(second.env)?.profiles.shared).toEqual(apiKey("second"));
  });

  it("ignores agent relocation when the selected shared owner is the state database", async () => {
    const root = await seedRoot("first");
    const relocated = tempDirs.make("openclaw-auth-owner-irrelevant-relocation-");
    withEnv({ ...root.env, OPENCLAW_AGENT_DIR: relocated }, () => {
      setSnapshot(readStore(root.agentDir), root.agentDir);
    });
    await update(root, undefined, (current) => {
      current.profiles.shared = apiKey("updated");
    });
    expect(snapshotAt(root.agentPath)?.profiles.shared).toEqual(apiKey("updated"));
    expect(fs.readdirSync(relocated)).toEqual([]);
  });

  it("rejects a save whose explicit state root disagrees with the captured owner", async () => {
    const root = await seedRoot("first");
    const otherStateDir = tempDirs.make("openclaw-auth-owner-mismatch-");
    const baseline = capturePersistence(undefined, {
      stateDir: root.stateDir,
    });
    expect(() =>
      saveIfUnchanged({
        snapshot: baseline,
        stateDir: otherStateDir,
        store: store("must-not-write"),
        options: saveOptions,
      }),
    ).toThrow("owner");
    expect(readSharedStore(root.env)?.profiles.shared).toEqual(apiKey("first"));
    expect(fs.readdirSync(otherStateDir)).toEqual([]);
  });

  it("rejects rollback whose explicit state root disagrees with the committed owner", async () => {
    const root = await seedRoot("first");
    const otherStateDir = tempDirs.make("openclaw-auth-owner-mismatch-");
    const baseline = capturePersistence(undefined, {
      stateDir: root.stateDir,
    });
    const committed = commitShared(root, baseline, "committed");
    expect(() =>
      restorePersistence(baseline, committed.owned, undefined, {
        stateDir: otherStateDir,
      }),
    ).toThrow("owner");
    expect(readSharedStore(root.env)?.profiles.shared).toEqual(apiKey("committed"));
    expect(fs.readdirSync(otherStateDir)).toEqual([]);
  });

  it.each(["invalid"] as const)(
    "publishes and compensates only the selected root under %s outer state",
    async (kind) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const otherSnapshots = listOwnedRuntimeAuthProfileStoreSnapshots().filter(
        (entry) =>
          entry.databasePath === second.sharedPath || entry.databasePath === second.agentPath,
      );
      const assertOuterUnchanged = unreadableOuter(kind);
      const baseline = capturePersistence(undefined, {
        stateDir: first.stateDir,
      });
      const committed = commitShared(first, baseline, "temporary");
      expect(readSharedStore(first.env)?.profiles.shared).toEqual(apiKey("temporary"));
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
      expect(committed.publishRuntimeSnapshots()).toBe(true);
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("temporary"));
      const derived = snapshotAt(first.agentPath);
      expect(derived?.profiles).toMatchObject({
        shared: apiKey("temporary"),
        local: apiKey("first-local"),
      });
      if (!derived) {
        throw new Error("missing first-root derived snapshot");
      }
      derived.profiles.external = {
        type: "token",
        provider: "anthropic",
        token: "runtime-only-fixture",
      };
      derived.runtimeExternalProfileIds = ["external"];
      replaceOwnedRuntimeAuthProfileStoreSnapshots(
        listOwnedRuntimeAuthProfileStoreSnapshots().map((entry) => {
          if (entry.databasePath === first.agentPath) {
            entry.store = derived;
          }
          return entry;
        }),
      );

      restorePersistence(baseline, committed.owned);

      expect(readSharedStore(first.env)?.profiles.shared).toEqual(apiKey("first"));
      expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("first"));
      expect(snapshotAt(first.agentPath)?.profiles).toEqual({
        shared: apiKey("first"),
        local: apiKey("first-local"),
        external: derived.profiles.external,
      });
      expect(
        listOwnedRuntimeAuthProfileStoreSnapshots().filter(
          (entry) =>
            entry.databasePath === second.sharedPath || entry.databasePath === second.agentPath,
        ),
      ).toEqual(otherSnapshots);
      expect(readSharedStore(second.env)?.profiles.shared).toEqual(apiKey("second"));
      assertOuterUnchanged();
    },
  );

  it("keeps concurrent batch compensation bound to its captured shared owner", async () => {
    const roots = await Promise.all([seedRoot("first"), seedRoot("second")]);
    const assertOuterUnchanged = unreadableOuter("future");
    const receipts = await Promise.all(
      roots.map(({ stateDir }) =>
        persistAuthProfileBatch({
          stateDir,
          profiles: [{ profileId: "attempt", credential: apiKey(stateDir) }],
        }),
      ),
    );
    const [firstReceipt, secondReceipt] = receipts;
    if (!firstReceipt || !secondReceipt) {
      throw new Error("missing batch compensation receipts");
    }
    await firstReceipt.rollback();
    expect(readSharedStore(roots[0].env)?.profiles.attempt).toBeUndefined();
    expect(readSharedStore(roots[1].env)?.profiles.attempt).toEqual(apiKey(roots[1].stateDir));
    expect(snapshotAt(roots[1].agentPath)?.profiles.attempt).toEqual(apiKey(roots[1].stateDir));
    await secondReceipt.rollback();
    await secondReceipt.rollback();
    for (const root of roots) {
      expect(readSharedStore(root.env)?.profiles.attempt).toBeUndefined();
      expect(snapshotAt(root.agentPath)?.profiles.attempt).toBeUndefined();
    }
    assertOuterUnchanged();
  });

  it("deduplicates OAuth against the selected shared owner, not an unrelated ambient owner", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const oauth: AuthProfileCredential = {
      type: "oauth",
      provider: "anthropic",
      access: "test-access",
      refresh: "test-refresh",
      expires: Date.now() + 600_000,
    };
    await persistAuthProfileBatch({
      stateDir: second.stateDir,
      profiles: [{ profileId: "oauth", credential: oauth }],
    });
    vi.stubEnv("OPENCLAW_STATE_DIR", second.stateDir);
    await persistAuthProfileBatch({
      stateDir: first.stateDir,
      agentDir: first.agentDir,
      profiles: [{ profileId: "oauth", credential: oauth }],
    });
    expect(readPersistedStore(first.agentDir)?.profiles.oauth).toEqual(oauth);
    await persistAuthProfileBatch({
      stateDir: first.stateDir,
      profiles: [{ profileId: "oauth", credential: oauth }],
    });
    const freshAgentDir = tempDirs.make("openclaw-auth-owner-fresh-agent-");
    await update(first, freshAgentDir, (current) => {
      current.profiles.oauth = oauth;
    });
    expect(readPersistedStore(freshAgentDir)?.profiles.oauth).toBeUndefined();
    // Existing local ownership is intentionally preserved, not retroactively deduplicated.
    expect(readPersistedStore(first.agentDir)?.profiles.oauth).toEqual(oauth);
    expect(readSharedStore(first.env)?.profiles.oauth).toEqual(oauth);
  });
});
