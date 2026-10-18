import assert from "node:assert/strict";
import { expect, it as baseIt } from "vitest";
import { createSessionRowProjection } from "../../gateway/session-row-projection.js";
import { sessionChanges } from "../../sessions/session-row-changes.js";
import { readOpenClawAgentDatabaseIdentity } from "../../state/openclaw-agent-db-identity.js";
import {
  closeOpenClawAgentDatabaseByPathAsync,
  openOpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { readPreparedSessionEntryChange } from "./session-accessor.sqlite-entry-cache-publication.js";
import {
  projectSessionSharingEntry,
  retainPreparedSessionSharingFacts,
} from "./session-accessor.sqlite-entry-cache.js";
import {
  readExactSessionEntryRow as readRow,
  writeSessionEntry,
} from "./session-accessor.sqlite-entry-store.js";
import { replaceSessionEntrySync } from "./session-accessor.sqlite-entry.js";
import { listTranscriptInstancesFromDatabase as listInstances } from "./session-accessor.sqlite-history.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import {
  applySessionEntryCanonicalReplacements,
  applySessionEntryExactReplacements,
  type SessionEntryCanonicalReplacement,
} from "./session-accessor.sqlite-replacement-projection.js";
import { getReplacementPublicationDelivery } from "./session-accessor.sqlite-replacement-publication.test-support.js";
import { listSessionMembersInDatabase } from "./session-sharing-store.kernel.js";
import { addSessionMember } from "./session-sharing-store.native.js";

const delivery = getReplacementPublicationDelivery();

function observePublication(sessionKey: string) {
  let published: ReturnType<typeof readPreparedSessionEntryChange>;
  const stop = sessionChanges.subscribeFacts((change) => {
    if ("sessionKey" in change && change.sessionKey === sessionKey) {
      published = readPreparedSessionEntryChange(change, sessionKey);
    }
  });
  return { [Symbol.dispose]: stop, read: () => published };
}

const replacements =
  <T>(rows: T[]) =>
  () => ({ result: undefined, replacements: rows });

const participant = (id: string) => ({
  type: "remote" as const,
  pluginId: "test-channel",
  domain: "workspace",
  idKind: "user",
  id,
});
const skills = (prompt: string) => ({ prompt, skills: [] });

function fixture() {
  const database = openOpenClawAgentDatabase({ agentId: "main" });
  const scope = (sessionKey: string) => ({ agentId: "main", storePath: database.path, sessionKey });
  return {
    database,
    scope,
    put: (key: string, entry: Parameters<typeof replaceSessionEntrySync>[1]) =>
      replaceSessionEntrySync(scope(key), entry),
    members: (key: string) =>
      listSessionMembersInDatabase(database, key).map((member) => member.identityId),
    canonical: (rows: SessionEntryCanonicalReplacement[]) =>
      applySessionEntryCanonicalReplacements({
        storePath: database.path,
        sessionKeys: rows.flatMap((row) => [row.sessionKey, ...row.previousSessionKeys]),
        update: replacements(rows),
      }),
  };
}
const it = baseIt.extend<{ store: ReturnType<typeof fixture> }>({
  store: async ({ task: _task }, use) =>
    withOpenClawTestState({ scenario: "minimal" }, () => use(fixture())),
});

it("restores and publishes superseded snapshots", async ({ store: { database, put } }) => {
  const sessionKey = "agent:main:snapshot";
  const entry = { sessionId: "snapshot", updatedAt: 1, skillsSnapshot: skills("old") };
  put(sessionKey, entry);
  using publication = observePublication(sessionKey);
  await applySessionEntryExactReplacements({
    storePath: database.path,
    sessionKeys: [sessionKey],
    update: replacements(
      [
        { ...entry, updatedAt: 2, skillsSnapshot: skills("new") },
        { ...entry, updatedAt: 3, label: "final" },
      ].map((replacement) => ({ sessionKey, entry: replacement })),
    ),
  });
  const expected = { label: "final", skillsSnapshot: { prompt: "old" } };
  expect(publication.read()?.fullEntry).toMatchObject(expected);
  await closeOpenClawAgentDatabaseByPathAsync(database.path);
  const reopened = openOpenClawAgentDatabase({ agentId: "main", path: database.path });
  expect(readRow(reopened, sessionKey)?.entry).toMatchObject(expected);
});

it("preserves shared-window provenance", async ({ store: { database, put, canonical } }) => {
  const a = "agent:main:replacement-window-a";
  const b = "agent:main:replacement-window-b";
  const entry = { sessionId: "shared", updatedAt: 1 };
  const window = () =>
    database.db
      .prepare(
        "SELECT session_key, hook_external_content_source FROM session_windows WHERE session_id = ?",
      )
      .get("shared");
  for (const sessionKey of [a, b]) {
    put(sessionKey, entry);
  }
  expect(window()?.session_key).toBe(b);
  await canonical([
    {
      sessionKey: a,
      previousSessionKeys: [],
      entry: { ...entry, updatedAt: 20, hookExternalContentSource: "gmail" },
    },
    { sessionKey: b, previousSessionKeys: [], entry: { ...entry, updatedAt: 21 } },
  ]);
  expect(window()).toEqual({ session_key: b, hook_external_content_source: "gmail" });
  const options = { sessionIds: ["shared"], includeAllWindows: true };
  expect(listInstances({ database, options })).toMatchObject([
    {
      sessionKey: b,
      provenanceKnown: true,
      entry: { updatedAt: 21, hookExternalContentSource: "gmail" },
      sourceMetadata: { hookExternalContentSource: "gmail" },
    },
  ]);
});

it.for([false, true])(
  "rehome preserves newer native metadata (%s)",
  async (newerNative, { store: { database, scope, put, canonical, members } }) => {
    const sessionKey = "agent:main:target";
    const aliasKey = "agent:main:alias";
    const entry = {
      sessionId: "t",
      lifecycleRevision: "r1",
      updatedAt: 2,
      visibility: "shared" as const,
    };
    writeSessionEntry(database, sessionKey, entry);
    writeSessionEntry(database, aliasKey, { sessionId: "member-alias", updatedAt: 1 });
    for (const [key, identityId] of [
      [sessionKey, "target"],
      [aliasKey, "alias"],
    ] as const) {
      addSessionMember(scope(key), { identityId, addedBy: "owner", addedAt: 1 });
      recordSessionParticipant(scope(key), {
        identity: participant(identityId),
        promptedAt: key === sessionKey ? 1 : 2,
      });
    }
    const identity = readOpenClawAgentDatabaseIdentity(database).identity;
    assert.ok(typeof identity === "string", "Expected durable fixture");
    const sharing = retainPreparedSessionSharingFacts({
      databaseIdentity: `file:${identity}`,
      sessionKey,
      entry: projectSessionSharingEntry(entry),
      membership: new Set(members(sessionKey)),
    });
    using _ = { [Symbol.dispose]: sharing.release };
    expect(sharing.readCurrent()?.membership).toEqual(new Set(["target"]));
    using publication = observePublication(sessionKey);
    delivery.afterResult = () => {
      if (newerNative) {
        put(sessionKey, { ...entry, updatedAt: 3, visibility: "draft" });
        expect(sharing.readCurrent()).toBeUndefined();
      }
    };
    await canonical([{ sessionKey, previousSessionKeys: [aliasKey], entry }]);
    expect(readRow(database, aliasKey)).toBeUndefined();
    expect(readRow(database, sessionKey)?.entry.visibility).toBe(newerNative ? "draft" : "shared");
    expect(members(sessionKey)).toEqual(["alias", "target"]);
    expect(sharing.readCurrent()).toEqual(
      newerNative
        ? undefined
        : { entry: projectSessionSharingEntry(entry), membership: new Set(["alias", "target"]) },
    );
    if (!newerNative) {
      expect(publication.read()?.entry).toMatchObject({
        participants: ["target", "alias"].map((id) => ({ identity: participant(id) })),
        participantCount: 2,
      });
    }
  },
);

it.for([false, true])(
  "retires aliases before observers without replacing recreated rows (%s)",
  async (recreated, { store: { database, put, canonical } }) => {
    const key = "agent:main:alias-survivor";
    const alias = "agent:main:alias-retired";
    const entry = { sessionId: "old", updatedAt: 1 };
    for (const sessionKey of [key, alias]) {
      put(sessionKey, entry);
    }
    const projection = await createSessionRowProjection({ cfg: {}, modelCatalog: [] });
    using lifetime = new DisposableStack();
    lifetime.defer(() => projection.dispose());
    await projection.ensureMaterialized();
    const query = { agentId: "main", key: alias, storePath: database.path };
    const capture = () => projection.capture(query)?.storedEntry?.sessionId;
    const sharing = () => projection.sharingTarget(query)?.entry.sessionId;
    expect(projection.capture(query)).toBeDefined();
    const seen: Array<[boolean, string | undefined, string | undefined]> = [];
    let nativeRecreation = false;
    delivery.afterResult = () => {
      if (recreated) {
        nativeRecreation = true;
        try {
          put(alias, { ...entry, sessionId: "new", updatedAt: 2 });
        } finally {
          nativeRecreation = false;
        }
      }
    };
    const stop = sessionChanges.subscribe((change) => {
      if ("sessionKey" in change && change.sessionKey === alias) {
        seen.push([nativeRecreation, capture(), sharing()]);
      }
    });
    lifetime.defer(stop);
    await canonical([{ sessionKey: key, previousSessionKeys: [alias], entry }]);
    if (recreated) {
      expect(seen[0]).toEqual([true, "new", "new"]);
      for (const sessionId of seen.flatMap(([, captured, shared]) => [captured, shared])) {
        expect([undefined, "new"]).toContain(sessionId);
      }
    } else {
      expect(seen).toEqual([[false, undefined, undefined]]);
    }
    await projection.ensureMaterialized();
    const expected = recreated ? "new" : undefined;
    expect([capture(), sharing()]).toEqual([expected, expected]);
    expect(readRow(database, alias)?.entry.sessionId).toBe(expected);
  },
);
