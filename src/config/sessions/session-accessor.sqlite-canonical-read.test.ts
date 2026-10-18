import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../../test/helpers/temp-dir.js";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawAgentDatabasesForTest,
  openOpenClawAgentDatabase,
  resolveOpenClawAgentSqlitePath,
  runOpenClawAgentWriteTransaction,
} from "../../state/openclaw-agent-db.js";
import { closeStateDatabaseForTest } from "../../test-utils/database-cleanup.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { withOpenClawTestState } from "../../test-utils/openclaw-test-state.js";
import { normalizeSessionDeliveryState } from "../../utils/delivery-context.shared.js";
import { clearRuntimeConfigSnapshot, setRuntimeConfigSnapshot } from "../runtime-snapshot.js";
import {
  assignSessionOwner,
  listSessionEntriesReadOnly,
  loadSessionEntryByIdReadOnly,
  loadSessionEntryReadOnly,
  patchSessionEntryCore,
  persistSessionTranscriptTurn,
  replaceSessionEntrySync,
} from "./session-accessor.js";
import { readExactSessionEntryCandidatesInDatabase } from "./session-accessor.sqlite-entry-cache.js";
import { recordSessionParticipant } from "./session-accessor.sqlite-participants.native.js";
import { resolveSqliteTranscriptScope } from "./session-accessor.sqlite-scope.js";
import { ensureTranscriptSessionRoot } from "./session-accessor.sqlite-transcript-state.js";
import { appendTranscriptEventsInTransaction } from "./session-accessor.sqlite-transcript-store.js";
import { markCanonicalSessionValidationPending } from "./session-canonical-key.js";
import type { SessionEntry } from "./types.js";

const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(async () => {
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    closeOpenClawAgentDatabasesForTest();
    await closeStateDatabaseForTest();
    cleanup();
    clearRuntimeConfigSnapshot();
  }),
);

beforeEach(() => setRuntimeConfigSnapshot({}));

function createFixture(
  sessionKey = "agent:main:plain",
  env: NodeJS.ProcessEnv = { OPENCLAW_STATE_DIR: tempDirs.make("canonical-metadata-") },
) {
  const scope = { agentId: "main", env, sessionKey };
  const put = (key: string, entry: Partial<SessionEntry> = {}) =>
    replaceSessionEntrySync(
      { ...scope, sessionKey: key },
      { sessionId: key, updatedAt: 1, ...entry },
    );
  return {
    scope,
    put,
    read: (projection?: "full" | "list", key = sessionKey) =>
      loadSessionEntryReadOnly({ ...scope, sessionKey: key, projection }),
    byId: (sessionId: string) =>
      loadSessionEntryByIdReadOnly({ ...scope, sessionId, projection: "list" }),
    retain: (sessionId: string) =>
      runOpenClawAgentWriteTransaction(
        (database) =>
          ensureTranscriptSessionRoot(
            database,
            { ...scope, sessionKey: `agent:main:${sessionId}`, sessionId },
            1,
          ),
        scope,
      ),
  };
}

it("omits saved prompts from metadata reads and transcript batches", async () => {
  const { scope, put, read } = createFixture();
  const { sessionKey } = scope;
  expect(read("list")).toBeUndefined();
  expect(fs.existsSync(resolveOpenClawAgentSqlitePath(scope))).toBe(false);
  const savedPrompt = "saved prompt ".repeat(40_000);
  put(sessionKey, {
    lifecycleRevision: "original",
    skillsSnapshot: { prompt: savedPrompt, skills: [] },
    systemPromptReport: {
      source: "run",
      generatedAt: 1,
      systemPrompt: { chars: 1, projectContextChars: 0, nonProjectContextChars: 1 },
      injectedWorkspaceFiles: [],
      skills: { promptChars: 1, entries: [] },
      tools: { listChars: 0, schemaChars: 0, entries: [] },
    },
  });
  assignSessionOwner(scope, {
    owner: { type: "agent", id: "owner" },
    assignedBy: { type: "human", id: "assigner" },
    assignedAt: 10,
  });
  recordSessionParticipant(scope, {
    identity: { type: "profile", id: "person" },
    promptedAt: 10,
  });
  const expected = { ...read()! };
  delete expected.skillsSnapshot;
  delete expected.systemPromptReport;
  const database = openOpenClawAgentDatabase(scope);
  const queries = trackSqliteStatementExecutions(
    requireNativeSqliteDatabase(database.db),
    ["entries"],
    (sql) => (/(?:from|join)\s+"session_nodes"/i.test(sql) ? "entries" : null),
  );
  try {
    expect(read("list")).toEqual(expected);
    expect(queries.textBytes.entries).toBeLessThan(2048);
    queries.textBytes.entries = 0;
    queries.counts.entries = 0;
    runOpenClawAgentWriteTransaction((writer) => {
      expect(
        appendTranscriptEventsInTransaction(
          writer,
          resolveSqliteTranscriptScope({ ...scope, sessionId: sessionKey }),
          [
            { type: "custom", id: "first", parentId: null, data: "synthetic" },
            { type: "custom", id: "second", parentId: "first", data: "synthetic" },
          ],
        ),
      ).toBe(2);
    }, scope);
    expect(queries.counts.entries).toBeGreaterThan(0);
    expect(queries.textBytes.entries).toBeLessThan(4096);
  } finally {
    queries.restore();
  }
  expect(read()?.skillsSnapshot?.prompt).toBe(savedPrompt);
  expect(read(undefined, sessionKey.replace("agent:", "AGENT:"))).toEqual(read());
  await patchSessionEntryCore(scope, (entry) => {
    expect(entry.skillsSnapshot?.prompt).toBe(savedPrompt);
    return { label: "renamed" };
  });
  expect(read()).toMatchObject({
    label: "renamed",
    skillsSnapshot: { prompt: savedPrompt },
  });
});

it("validates a folded sibling before selecting or preparing the exact opaque target", async () => {
  const sessionKey = "agent:main:matrix:channel:!Mixed:example.org";
  const { scope, put, read } = createFixture(sessionKey);
  const sibling = sessionKey.toLowerCase();
  for (const key of [sessionKey, sibling]) {
    put(key);
  }
  read();
  const database = openOpenClawAgentDatabase(scope);
  markCanonicalSessionValidationPending(database, [sibling]);
  database.db.prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?").run(
    JSON.stringify({
      sessionId: sibling,
      updatedAt: 1,
      delivery: normalizeSessionDeliveryState({
        context: { channel: "matrix", to: "!Mixed:example.org" },
      }),
    }),
    sibling,
  );
  database.db
    .prepare("UPDATE session_nodes SET entry_valid = 1 WHERE session_key = ?")
    .run(sibling);
  for (const projection of ["full", "list"] as const) {
    expect(() => read(projection)).toThrow("non-canonical persisted row");
    expect(() =>
      listSessionEntriesReadOnly({
        ...scope,
        projection,
        sessionKeys: [sessionKey],
        includeParticipants: false,
      }),
    ).toThrow("non-canonical persisted row");
  }
  const shouldAppend = vi.fn(() => true);
  await expect(
    persistSessionTranscriptTurn(
      { ...scope, sessionId: sessionKey },
      {
        expectedSessionId: sessionKey,
        messages: [{ message: { role: "user", content: "must not prepare" }, shouldAppend }],
        updateMode: "none",
      },
    ),
  ).rejects.toThrow("non-canonical persisted row");
  expect(shouldAppend).not.toHaveBeenCalled();
});
it("preserves visible listing order and excludes retained generations", () => {
  const { scope, put, byId, retain } = createFixture();
  for (const name of ["z-shared", "a-shared", "internal-session-effects:shared"]) {
    put(`agent:main:${name}`, {
      sessionId: "shared",
      label: name,
      spawnDepth: 2,
      skillsSnapshot: { prompt: "saved prompt", skills: [] },
    });
  }
  put("agent:main:internal-session-effects:hidden", { sessionId: "hidden" });
  for (const sessionId of ["previous", "current"]) {
    put("agent:main:rolled-over", { sessionId });
  }
  retain("retained");

  const selected = byId("shared");
  expect(selected).toEqual(
    listSessionEntriesReadOnly({ ...scope, projection: "list" }).find(
      ({ entry }) => entry.sessionId === "shared",
    ),
  );
  expect(selected).toMatchObject({
    sessionKey: "agent:main:a-shared",
    entry: { sessionId: "shared", label: "a-shared", spawnDepth: 2 },
  });
  expect(selected?.entry.skillsSnapshot).toBeUndefined();
  expect(byId("current")).toMatchObject({
    sessionKey: "agent:main:rolled-over",
    entry: { sessionId: "current" },
  });
  for (const sessionId of ["previous", "retained", "hidden", "missing"]) {
    expect(byId(sessionId)).toBeUndefined();
  }
});

it("leaves a missing store absent", () => {
  const root = tempDirs.make("openclaw-session-by-id-missing-");
  const env = { OPENCLAW_STATE_DIR: path.join(root, "state") };
  expect(
    loadSessionEntryByIdReadOnly({ agentId: "main", env, sessionId: "missing" }),
  ).toBeUndefined();
  expect(fs.readdirSync(root)).toEqual([]);
});

it("preserves delivery JSON semantics, retained windows, and invalid-row failures", async () => {
  await withOpenClawTestState({ label: "narrow-delivery" }, async (state) => {
    setRuntimeConfigSnapshot({});
    const { scope, put, retain } = createFixture("agent:main:plain", state.env);
    const delivery = normalizeSessionDeliveryState({
      context: {
        channel: "matrix",
        to: "!Opaque:example.org",
        accountId: "work",
        threadId: "Topic",
      },
    });
    const entry = { sessionId: "source", updatedAt: 1, delivery, groupId: "!Opaque:example.org" };
    const json = JSON.stringify(entry);
    const cases: Array<[name: string, json: string]> = [
      ["ordinary", json],
      [
        "duplicate",
        json
          .replace('"sessionId":"source"', '"sessionId":"discarded","sessionId":"source"')
          .replace('"delivery":', '"delivery":null,"delivery":'),
      ],
      ["deep", json.slice(0, -1) + ',"unused":' + "[".repeat(1100) + "0" + "]".repeat(1100) + "}"],
      ["null", JSON.stringify({ ...entry, delivery: null, groupId: false })],
      ["escaped", JSON.stringify({ ...entry, groupId: "opaque-\ud800" })],
      ["absent", '{"sessionId":"source","updatedAt":1}'],
    ];
    const database = openOpenClawAgentDatabase(scope);
    for (const [name] of cases) {
      const sessionKey = `agent:main:${name}`;
      put(sessionKey, entry);
    }
    const retained = "agent:main:retained";
    retain("retained");
    const keys = [...cases.map(([name]) => `agent:main:${name}`), retained, "agent:main:missing"];
    const read = (projection: "list" | "delivery") =>
      readExactSessionEntryCandidatesInDatabase(
        database,
        keys.map((key) => [key]),
        projection,
      );
    expect(read("delivery").every((result) => result.ok)).toBe(true);
    // Admitted readers preserve raw metadata parsing; cold admission still rejects uncertified rows.
    for (const [index, [, stored]] of cases.entries()) {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(stored, keys[index]!);
    }
    expect(read("delivery")).toEqual([
      ...cases.map(([, stored], index) => {
        const projected: Record<string, unknown> = JSON.parse(stored);
        delete projected.unused;
        return { ok: true, value: [{ sessionKey: keys[index], entry: projected }] };
      }),
      { ok: true, value: [] },
      { ok: true, value: [] },
    ]);
    for (const broken of [
      json + "\u0000tail",
      '{"unrelated":true}',
      json.replace('"updatedAt":1', '"updatedAt":2'),
    ]) {
      database.db
        .prepare("UPDATE session_nodes SET entry_json = ? WHERE session_key = ?")
        .run(broken, keys[0]!);
      expect(read("delivery").map((r) => r.ok)).toEqual(read("list").map((r) => r.ok));
      expect(read("delivery")[0]).toMatchObject({
        ok: false,
        error: { code: "SESSION_CANONICAL_KEY_MIGRATION_REQUIRED" },
      });
    }
  });
});
