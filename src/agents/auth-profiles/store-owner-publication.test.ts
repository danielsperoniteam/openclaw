import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runNodeScript } from "../../../test/helpers/run-node-script.js";
import { resolveRuntimeWorkerUrl } from "../../infra/runtime-worker-url.js";
import { prepareSecretsRuntimeFastPathSnapshot } from "../../secrets/runtime-fast-path.js";
import { activateSecretsRuntimeSnapshotState } from "../../secrets/runtime-state.js";
import { openOpenClawStateDatabase } from "../../state/openclaw-state-db.js";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { withEnv, withEnvAsync } from "../../test-utils/env.js";
import {
  withCanonicalAuthProfileCredentialObserver,
  type CanonicalAuthProfileCredentialObservation,
} from "./credential-observation.js";
import { refreshAuthProfileFileState } from "./file-state.js";
import {
  assertAuthProfileMigrationReady,
  AuthProfileMigrationRequiredError,
  markAuthProfileMigrationRequired,
} from "./legacy-source-diagnostic.js";
import {
  getRuntimeAuthProfileStoreCredentialMutationToken,
  getRuntimeAuthProfileStoreStateMutationToken,
} from "./mutation-lineage.js";
import { createOAuthRefreshFence } from "./oauth-refresh-marker.js";
import {
  loadPersistedAuthProfileStore as readPersistedStore,
  loadPersistedSharedAuthProfileStore as readSharedStore,
} from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshotsAsync,
  setRuntimeAuthProfileStoreSnapshot as setSnapshot,
} from "./runtime-snapshots.js";
import {
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles as ensureStore,
  loadAuthProfileStoreForCatalogAsync,
  loadAuthProfileStoreWithoutExternalProfiles as readStore,
  loadAuthProfileStoreForRuntime,
  saveAuthProfileStore,
  saveAuthProfileStoreIfPersistenceSnapshotMatches as saveIfUnchanged,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { authProfileScopeCwdEntrypoint } from "./store-scope-cwd-runtime.test-support.js";
import { createAuthOwnerTestFixtures } from "./store-state-owner.test-support.js";
import {
  captureAuthProfileStorePersistenceSnapshot as capturePersistence,
  restoreAuthProfileStorePersistenceSnapshot as restorePersistence,
  withAuthProfileStoreAgentDir,
  withEnvOnlyAuthProfileStore,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { persistAuthProfileBatch } from "./upsert-with-lock.js";

const { tempDirs, saveOptions, apiKey, store, snapshotAt, unreadableOuter, seedRoot } =
  createAuthOwnerTestFixtures();

type Root = Awaited<ReturnType<typeof seedRoot>>;
function bindSnapshot(root: Root, agentDir: string) {
  withEnv(root.env, () => setSnapshot(readStore(agentDir), agentDir));
}
function commitLocal(root: Root) {
  const scope = { stateDir: root.stateDir };
  const baseline = capturePersistence(root.agentDir, scope);
  const committed = saveIfUnchanged({
    snapshot: baseline,
    agentDir: root.agentDir,
    ...scope,
    store: { version: 1, profiles: { local: apiKey("temporary-local") } },
    options: saveOptions,
  });
  expect(committed.publishRuntimeSnapshots()).toBe(true);
  return () => restorePersistence(baseline, committed.owned, root.agentDir, scope);
}
function saveProfiles(profiles: AuthProfileStore["profiles"], agentDir?: string) {
  saveAuthProfileStore({ version: 1, profiles }, agentDir, saveOptions);
}

describe("auth publication owner receipts", () => {
  it("refreshes catalog credentials and their display source after committed owner writes", async () => {
    const stateDir = tempDirs.make("openclaw-catalog-auth-owner-");
    const agentDir = path.join(stateDir, "agents", "catalog", "agent");
    const localPath = resolveAuthProfileDatabasePath(agentDir);
    await withEnvAsync(
      { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: undefined },
      async () => {
        await persistAuthProfileBatch({
          stateDir,
          profiles: [{ profileId: "shared", credential: apiKey("shared") }],
        });
        const inherited = await loadAuthProfileStoreForCatalogAsync(agentDir);
        expect(inherited.displayPath).toBe(
          resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: stateDir }),
        );
        expect(inherited.store.profiles.shared).toEqual(apiKey("shared"));
        expect(readStore(agentDir).profiles.shared).toEqual(apiKey("shared"));

        saveProfiles({}, agentDir);
        const emptyLocal = await loadAuthProfileStoreForCatalogAsync(agentDir);
        expect(emptyLocal.displayPath).toBe(localPath);
        expect(emptyLocal.store.profiles.shared).toEqual(apiKey("shared"));

        for (const key of ["local", "replaced"]) {
          await persistAuthProfileBatch({
            stateDir,
            agentDir,
            profiles: [{ profileId: "shared", credential: apiKey(key) }],
          });
          const catalog = await loadAuthProfileStoreForCatalogAsync(agentDir);
          expect(catalog.displayPath).toBe(localPath);
          expect(catalog.store.profiles.shared).toEqual(apiKey(key));
          expect(readStore(agentDir).profiles.shared).toEqual(apiKey(key));
        }

        const unreadableAgentDir = path.join(stateDir, "agents", "unreadable", "agent");
        writePersistedAuthProfileStoreRaw(
          { version: 1, profiles: "invalid-profile-map" },
          unreadableAgentDir,
        );
        await expect(loadAuthProfileStoreForCatalogAsync(unreadableAgentDir)).rejects.toThrow(
          "is unreadable",
        );
        expect(() => readStore(unreadableAgentDir)).toThrow("is unreadable");
      },
    );
  });

  it.each(["native", "async"] as const)(
    "publishes a cold default snapshot through %s",
    async (mode) => {
      const stateDir = tempDirs.make("openclaw-auth-cold-snapshot-");
      const agentDir = path.join(stateDir, "shared-agent");
      await withEnvAsync(
        { OPENCLAW_STATE_DIR: stateDir, OPENCLAW_AGENT_DIR: agentDir },
        async () => {
          const snapshot = store("cold-default");
          if (mode === "native") {
            replaceRuntimeAuthProfileStoreSnapshots([{ store: snapshot }]);
          } else {
            await replaceRuntimeAuthProfileStoreSnapshotsAsync([{ store: snapshot }]);
          }
          expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles).toEqual(
            snapshot.profiles,
          );
        },
      );
    },
  );

  it("keeps an env-only runtime read outside an unreadable ambient owner", () => {
    const assertOuterUnchanged = unreadableOuter("future");
    expect(withEnvOnlyAuthProfileStore(() => loadAuthProfileStoreForRuntime())).toEqual({
      version: 1,
      profiles: {},
    });
    assertOuterUnchanged();
  });

  it("reads an explicit local owner without admitting an unrelated ambient owner", () => {
    const agentDir = tempDirs.make("openclaw-auth-explicit-local-");
    writePersistedAuthProfileStoreRaw(store("local-only"), agentDir);
    const assertOuterUnchanged = unreadableOuter("future");
    expect(readStore(agentDir, { inheritedAuthDir: agentDir }).profiles).toEqual(
      store("local-only").profiles,
    );
    assertOuterUnchanged();
  });

  it.each(["cold", "cached", "admitted"] as const)(
    "observes exact shared and local credential owners through a %s read",
    async (mode) => {
      const owner = await seedRoot("observed");
      if (mode === "cold") {
        clearRuntimeAuthProfileStoreSnapshots();
      } else if (mode === "admitted") {
        const { prepareSecretsRuntimeSnapshot } = await import("../../secrets/runtime.js");
        await withEnvAsync(owner.env, async () => {
          const snapshot = await prepareSecretsRuntimeSnapshot({
            config: {},
            env: owner.env,
            agentDirs: [owner.agentDir],
            includeConfigRefs: false,
            loadAuthStore: readStore,
          });
          activateSecretsRuntimeSnapshotState({
            snapshot,
            refreshContext: null,
            refreshHandler: null,
          });
        });
      }
      const observations: CanonicalAuthProfileCredentialObservation[] = [];
      await withEnvAsync(owner.env, () =>
        withCanonicalAuthProfileCredentialObserver(
          (value) => observations.push(value),
          async () => {
            const selected = ensureStore(owner.agentDir);
            expect(selected.profiles).toEqual({
              shared: apiKey("observed"),
              local: apiKey("observed-local"),
            });
          },
        ),
      );
      expect(observations).toEqual(
        expect.arrayContaining([
          { databasePath: owner.sharedPath, profiles: { shared: apiKey("observed") } },
          { databasePath: owner.agentPath, profiles: { local: apiKey("observed-local") } },
        ]),
      );
      expect(
        observations.some(
          (value) => value.databasePath === owner.agentPath && value.profiles.shared !== undefined,
        ),
      ).toBe(false);
    },
  );

  it.each(["prepare", "activate"] as const)(
    "requires a recorded migration diagnosis discovered at %s before empty-owner activation",
    async (discoveredAt) => {
      const { prepareSecretsRuntimeSnapshot } = await import("../../secrets/runtime.js");
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const agentDir = tempDirs.make("openclaw-auth-owner-empty-activation-");
      await updateAuthProfileStoreWithLock({
        stateDir: first.stateDir,
        saveOptions,
        updater: (current) => {
          current.profiles = {};
          return true;
        },
      });
      withEnv(second.env, () => setSnapshot(readStore(agentDir), agentDir));
      const legacyPath = path.join(agentDir, "auth.json");
      if (discoveredAt === "prepare") {
        fs.writeFileSync(legacyPath, "{}");
        await refreshAuthProfileFileState();
      }
      const snapshot = await prepareSecretsRuntimeSnapshot({
        config: {},
        env: first.env,
        agentDirs: [agentDir],
        allowUnavailableSecretOwners: true,
        loadAuthStore: () => withEnv(first.env, () => readStore(agentDir)),
      });
      expect(snapshot.authStores[0]?.store.profiles).toEqual({});
      const activate = () =>
        activateSecretsRuntimeSnapshotState({
          snapshot,
          refreshContext: null,
          refreshHandler: null,
        });
      if (discoveredAt === "prepare") {
        expect(snapshot.degradedOwners).toHaveLength(1);
        expect(activate).not.toThrow();
        expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles).toEqual({});
      } else {
        expect(snapshot.degradedOwners).toEqual([]);
        fs.writeFileSync(legacyPath, "{}");
        expect(activate).toThrow("requires legacy credential migration");
        expect(snapshotAt(resolveAuthProfileDatabasePath(agentDir))?.profiles.shared).toEqual(
          apiKey("second"),
        );
      }
    },
  );

  it("honors an explicit state root over the enclosing scope during update", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    await withAuthProfileStoreAgentDir(first.agentDir, second.stateDir, async () => {
      await updateAuthProfileStoreWithLock({
        agentDir: first.agentDir,
        stateDir: first.stateDir,
        saveOptions,
        updater: (current) => {
          current.profiles = { local: apiKey("updated-local") };
          return true;
        },
      });
    });
    expect(snapshotAt(first.agentPath)?.profiles).toEqual({
      local: apiKey("updated-local"),
      shared: apiKey("first"),
    });
    expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("second"));
  });

  it("keeps runtime-only rows out of unrelated agent-local batch persistence", async () => {
    const root = await seedRoot("original");
    const { agentDir, agentPath: databasePath } = root;
    const durableProfileId = "local";
    const durableCredential = apiKey("original-local");
    const staleProfileId = "openai:removed";
    const staleFenceId = "openai:stale-fence";
    const externalProfileId = "anthropic:runtime-external";
    const expiredOAuth = {
      type: "oauth",
      provider: "openai",
      access: "expired-access",
      refresh: "consumed-refresh",
      expires: Date.now() - 60_000,
    } satisfies AuthProfileCredential;
    const staleFence = createOAuthRefreshFence({
      profileId: staleFenceId,
      credential: expiredOAuth,
    });

    withEnv(root.env, () => {
      writePersistedAuthProfileStoreRaw(
        {
          version: 1,
          profiles: {
            [durableProfileId]: durableCredential,
            [staleProfileId]: apiKey("removed"),
            [staleFenceId]: staleFence,
          },
        },
        agentDir,
      );
      setSnapshot(readStore(agentDir), agentDir);
      writePersistedAuthProfileStoreRaw(
        { version: 1, profiles: { [durableProfileId]: durableCredential } },
        agentDir,
      );

      const runtimeStore = snapshotAt(databasePath);
      if (!runtimeStore) {
        throw new Error("missing runtime auth profile snapshot");
      }
      setSnapshot(
        {
          ...runtimeStore,
          profiles: {
            ...runtimeStore.profiles,
            [externalProfileId]: {
              type: "oauth",
              provider: "anthropic",
              access: "external-access",
              refresh: "external-refresh",
              expires: Date.now() + 60_000,
            },
          },
          runtimeExternalProfileIds: [externalProfileId],
        },
        agentDir,
      );
    });

    await persistAuthProfileBatch({
      stateDir: root.stateDir,
      agentDir,
      profiles: [{ profileId: "openai:unrelated", credential: apiKey("unrelated") }],
    });

    const persisted = readPersistedStore(agentDir);
    expect(persisted?.profiles).toEqual({
      [durableProfileId]: durableCredential,
      "openai:unrelated": apiKey("unrelated"),
    });
    expect(snapshotAt(databasePath)?.profiles).toMatchObject({
      [durableProfileId]: durableCredential,
      "openai:unrelated": apiKey("unrelated"),
      [externalProfileId]: {
        access: "external-access",
        refresh: "external-refresh",
      },
    });
    expect(snapshotAt(databasePath)?.profiles[staleProfileId]).toBeUndefined();
    expect(snapshotAt(databasePath)?.profiles[staleFenceId]).toBeUndefined();
  });

  it("validates empty committed shared migration facts with an unreadable local store", async () => {
    const root = await seedRoot("original");
    const oauthDir = tempDirs.make("openclaw-auth-owner-late-oauth-");
    const env = { ...root.env, OPENCLAW_OAUTH_DIR: oauthDir };
    bindSnapshot({ ...root, env }, root.agentDir);
    writePersistedAuthProfileStoreRaw({ version: 1, profiles: "invalid" }, root.agentDir);
    const legacyPath = path.join(oauthDir, "oauth.json");
    fs.writeFileSync(legacyPath, "{}");
    await refreshAuthProfileFileState();
    withEnv(env, () => saveProfiles({}));
    fs.unlinkSync(legacyPath);
    // The removed file cannot make this assertion discover the refusal itself.
    expect(() => assertAuthProfileMigrationReady(undefined, env)).toThrow(
      "requires legacy credential migration",
    );
    expect(snapshotAt(root.agentPath)).toBeUndefined();
  });

  it.each(["credentials", "state"] as const)(
    "records committed %s changes and evicts derived snapshots when migration refuses publication",
    async (kind) => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const readToken =
        kind === "credentials"
          ? getRuntimeAuthProfileStoreCredentialMutationToken
          : getRuntimeAuthProfileStoreStateMutationToken;
      const before = withEnv(first.env, () => readToken().revision);
      markAuthProfileMigrationRequired(
        undefined,
        new AuthProfileMigrationRequiredError({
          env: first.env,
          sources: [],
        }),
        first.env,
      );
      const next =
        kind === "credentials"
          ? store("updated-first")
          : {
              ...store("first"),
              order: { openai: ["shared"] },
            };
      withEnv(second.env, () =>
        saveAuthProfileStore(
          next,
          undefined,
          saveOptions,
          openOpenClawStateDatabase({ env: first.env }),
        ),
      );
      expect(readSharedStore(first.env)).toMatchObject(next);
      expect(snapshotAt(first.agentPath)).toBeUndefined();
      expect(withEnv(first.env, () => readToken().revision)).toBeGreaterThan(before);
      expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("second"));
      expect(() => assertAuthProfileMigrationReady(undefined, first.env)).toThrow(
        "requires legacy credential migration",
      );
    },
  );

  it("isolates shared rollback refusal after a state-only commit", async () => {
    const root = await seedRoot("original");
    const healthyAgentDir = tempDirs.make("openclaw-auth-owner-healthy-sibling-");
    const healthyPath = resolveAuthProfileDatabasePath(healthyAgentDir);
    bindSnapshot(root, healthyAgentDir);
    const unrelated = await seedRoot("unrelated");
    const baseline = capturePersistence(undefined, { env: root.env });
    const committed = saveIfUnchanged({
      snapshot: baseline,
      store: { ...store("original"), usageStats: { shared: { lastUsed: 99 } } },
      options: saveOptions,
    });
    expect(committed.publishRuntimeSnapshots()).toBe(true);
    markAuthProfileMigrationRequired(
      undefined,
      new AuthProfileMigrationRequiredError({ env: root.env, sources: [] }),
      root.env,
    );
    restorePersistence(baseline, committed.owned);
    expect(readSharedStore(root.env)?.profiles.shared).toEqual(apiKey("original"));
    expect(snapshotAt(root.agentPath)).toBeUndefined();
    expect(snapshotAt(root.sharedPath)).toBeUndefined();
    expect(snapshotAt(healthyPath)).toBeUndefined();
    expect(snapshotAt(unrelated.sharedPath)?.profiles.shared).toEqual(apiKey("unrelated"));
    expect(snapshotAt(unrelated.agentPath)?.profiles.shared).toEqual(apiKey("unrelated"));
    expect(() => assertAuthProfileMigrationReady(undefined, root.env)).toThrow(
      "requires legacy credential migration",
    );
  });

  it("preserves late auth.json migration semantics with a populated store", async () => {
    const root = await seedRoot("original");
    fs.writeFileSync(path.join(root.agentDir, "auth.json"), "{}");
    withEnv(root.env, () => saveProfiles({ local: apiKey("updated-local") }, root.agentDir));
    expect(snapshotAt(root.agentPath)?.profiles.shared).toEqual(apiKey("original"));
    expect(() => assertAuthProfileMigrationReady(root.agentDir, root.env)).not.toThrow();
  });

  it("preserves the selected shared owner for a supplied connection under a readable ambient root", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    withEnv(second.env, () => {
      saveAuthProfileStore(
        store("updated-first"),
        undefined,
        saveOptions,
        openOpenClawStateDatabase({ env: first.env }),
      );
    });
    expect(readSharedStore(first.env)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(snapshotAt(first.sharedPath)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-first"));
    expect(readSharedStore(second.env)?.profiles.shared).toEqual(apiKey("second"));
    expect(snapshotAt(second.agentPath)?.profiles.shared).toEqual(apiKey("second"));
  });

  it.each(["supplied"] as const)(
    "does not relabel another owner's resolved credentials during %s publication",
    async () => {
      const first = await seedRoot("first");
      const second = await seedRoot("second");
      const sharedRef = {
        type: "api_key",
        provider: "openai",
        keyRef: { source: "env", provider: "default", id: "OPENAI_API_KEY" },
      } satisfies AuthProfileCredential;
      for (const root of [first, second]) {
        await persistAuthProfileBatch({
          stateDir: root.stateDir,
          profiles: [{ profileId: "shared", credential: sharedRef }],
        });
      }
      withEnv(first.env, () => {
        const current = readStore(first.agentDir);
        current.profiles.shared = { ...sharedRef, key: "fixture-first-resolved" };
        current.profiles.external = {
          type: "oauth",
          provider: "anthropic",
          access: "fixture-first-access",
          refresh: "fixture-first-refresh",
          expires: Date.now() + 60_000,
        };
        current.runtimeExternalProfileIds = ["external"];
        setSnapshot(current, first.agentDir);
      });
      withEnv(second.env, () => {
        const next = readStore(first.agentDir);

        runAuthProfileWriteTransaction(first.agentDir, (database) => {
          saveAuthProfileStore(next, first.agentDir, saveOptions, database);
        });
      });
      expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(sharedRef);
      expect(snapshotAt(first.agentPath)?.profiles.external).toBeUndefined();
    },
  );

  it("keeps relative scope paths bound to their original working directory during preparation", async ({
    signal,
  }) => {
    const stateDir = tempDirs.make("openclaw-auth-scope-state-");
    const agentDir = tempDirs.make("openclaw-auth-scope-agent-");
    const entryCwd = tempDirs.make("openclaw-auth-scope-entry-cwd-");
    const laterCwd = path.join(tempDirs.make("openclaw-auth-scope-later-cwd-"), "nested");
    fs.mkdirSync(laterCwd);
    const result = await runNodeScript(
      (workerArgv) => [
        ...workerArgv(resolveRuntimeWorkerUrl(authProfileScopeCwdEntrypoint)),
        stateDir,
        agentDir,
        laterCwd,
      ],
      {
        ...process.env,
        TSX_TSCONFIG_PATH: fileURLToPath(new URL("../../../tsconfig.json", import.meta.url)),
      },
      undefined,
      { cwd: entryCwd, signal, requireProcessTreeExit: process.platform !== "win32" },
    );
    expect(result.error, result.stderr).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  });

  it("retains shared OAuth in the owner snapshot but excludes it from bounded exec", async () => {
    const original = await seedRoot("original");
    const oauth = {
      type: "oauth",
      provider: "openai",
      access: "fixture-shared-access",
      refresh: "fixture-shared-refresh",
      expires: Date.now() + 3_600_000,
    } satisfies AuthProfileCredential;
    await persistAuthProfileBatch({
      stateDir: original.stateDir,
      profiles: [{ profileId: "shared-oauth", credential: oauth }],
    });
    expect(snapshotAt(original.agentPath)?.profiles["shared-oauth"]).toEqual(oauth);
    const temporary = tempDirs.make("openclaw-auth-owner-bounded-oauth-");
    await withEnvAsync({ ...original.env, OPENCLAW_STATE_DIR: temporary }, async () => {
      await withAuthProfileStoreAgentDir(original.agentDir, original.stateDir, () => {
        const current = ensureStore();
        expect(current.profiles["shared-oauth"]).toBeUndefined();
        saveAuthProfileStore(current, undefined, saveOptions);
        expect(ensureStore().profiles["shared-oauth"]).toBeUndefined();
      });
    });
    expect(snapshotAt(original.agentPath)?.profiles["shared-oauth"]).toEqual(oauth);
  });

  it("preserves an independently newer runtime owner with identical credential bytes", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    const third = await seedRoot("second");
    bindSnapshot(second, first.agentDir);
    const originalRuntime = snapshotAt(first.agentPath);
    if (!originalRuntime) {
      throw new Error("missing second-owner runtime");
    }
    const restore = commitLocal(first);
    withEnv(third.env, () => setSnapshot(originalRuntime, first.agentDir));
    restore();
    expect(snapshotAt(first.agentPath)?.profiles).toEqual(originalRuntime.profiles);
    await persistAuthProfileBatch({
      stateDir: third.stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("updated-third") }],
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-third"));
  });

  it("restores the captured runtime owner separately from the persistence transaction owner", async () => {
    const first = await seedRoot("first");
    const second = await seedRoot("second");
    bindSnapshot(second, first.agentDir);
    const restore = commitLocal(first);
    restore();
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("second"));
    await persistAuthProfileBatch({
      stateDir: second.stateDir,
      profiles: [{ profileId: "shared", credential: apiKey("updated-second") }],
    });
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("updated-second"));
  });

  it.each(["compensate"] as const)(
    "reconciles two legacy roots sharing one relocated database during %s",
    () => {
      const sharedDir = tempDirs.make("openclaw-auth-owner-aliased-legacy-");
      const roots = ["first", "second"].map(() => ({
        agentDir: tempDirs.make("openclaw-auth-owner-aliased-agent-"),
        env: {
          ...process.env,
          OPENCLAW_STATE_DIR: tempDirs.make("openclaw-auth-owner-aliased-root-"),
          OPENCLAW_AGENT_DIR: sharedDir,
        },
      }));
      writePersistedAuthProfileStoreRaw(store("original"), sharedDir);
      for (const root of roots) {
        withEnv(root.env, () => setSnapshot(readStore(root.agentDir), root.agentDir));
      }
      const first = roots[0]!;
      const second = roots[1]!;
      const baseline = capturePersistence(undefined, { env: first.env });
      const committed = saveIfUnchanged({
        snapshot: baseline,
        store: store("candidate"),
        options: saveOptions,
      });
      expect(committed.publishRuntimeSnapshots()).toBe(true);

      withEnv(second.env, () => setSnapshot(readStore(second.agentDir), second.agentDir));
      restorePersistence(baseline, committed.owned);
      expect(snapshotAt(resolveAuthProfileDatabasePath(second.agentDir))?.profiles.shared).toEqual(
        apiKey("original"),
      );
    },
  );

  it("activates a valid prepared owner without reopening an unrelated public cold scope", async () => {
    const first = await seedRoot("first");
    const coldAgentDir = tempDirs.make("openclaw-auth-owner-unrelated-cold-");
    const assertOuterUnchanged = unreadableOuter("future");
    replaceRuntimeAuthProfileStoreSnapshots([{ agentDir: coldAgentDir, store: store("cold") }]);
    const prepared = prepareSecretsRuntimeFastPathSnapshot({
      config: {},
      env: first.env,
      agentDirs: [first.agentDir],
      loadAuthStore: () => withEnv(first.env, () => readStore(first.agentDir)),
    });
    if (!prepared) {
      throw new Error("missing prepared snapshot");
    }
    expect(() =>
      activateSecretsRuntimeSnapshotState({ ...prepared, refreshHandler: null }),
    ).not.toThrow();
    expect(snapshotAt(first.agentPath)?.profiles.shared).toEqual(apiKey("first"));
    assertOuterUnchanged();
  });
});
