import path from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { trackSqliteStatementExecutions } from "../../../test/helpers/sqlite-statement-execution-counter.js";
import { requireNodeSqlite } from "../../infra/node-sqlite.js";
import { runSqliteImmediateTransactionSync } from "../../infra/sqlite-transaction.js";
import {
  openOpenClawAgentDatabase,
  runOpenClawAgentWriteTransaction,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { requireNativeSqliteDatabase } from "../../test-utils/native-sqlite.js";
import { useSessionStoreTempDirs } from "../../test-utils/session-state-cleanup.js";
import {
  loadTranscriptEventsSync,
  resolveSessionTranscriptDatabasePath,
  upsertSessionEntryCore,
  validatePreparedAssistantAppendSync,
  type TranscriptEvent,
} from "./session-accessor.js";
import { resolveTranscriptMessageAppendParent } from "./session-accessor.sqlite-transcript-parent.js";
import {
  appendTranscriptEventSnapshotSync,
  appendTranscriptMessageSnapshotSync,
} from "./session-accessor.sqlite-transcript-write.js";
import { replaceTranscriptEventsSync } from "./session-accessor.sqlite-transcript-write.test-support.js";

const sessionDirs = useSessionStoreTempDirs(afterAll, "openclaw-ancestry-");

async function createTranscript(events: TranscriptEvent[]) {
  const scope = {
    agentId: "main",
    sessionId: "ancestry",
    sessionKey: "agent:main:ancestry",
    storePath: path.join(sessionDirs.make(), "sessions.json"),
  };
  await upsertSessionEntryCore(scope, { sessionId: scope.sessionId, updatedAt: 1 });
  replaceTranscriptEventsSync(scope, [
    { type: "session", version: 3, id: scope.sessionId },
    ...events,
  ]);
  const database = openOpenClawAgentDatabase({
    agentId: scope.agentId,
    path: resolveSessionTranscriptDatabasePath(scope),
  });
  return {
    scope,
    database,
    append: (id: string, parentId?: string, owner?: OpenClawAgentDatabase) =>
      appendTranscriptMessageSnapshotSync(
        scope,
        assistant(id, parentId),
        undefined,
        undefined,
        undefined,
        owner,
      ),
    transaction: <T>(operation: (current: OpenClawAgentDatabase) => T) =>
      runOpenClawAgentWriteTransaction(operation, { agentId: scope.agentId, path: database.path }),
    parent: (parentId: string | null) =>
      runSqliteImmediateTransactionSync(database.db, () =>
        resolveTranscriptMessageAppendParent(database, scope.sessionId, {
          appendIntent: "active-branch",
          parentId,
        }),
      ),
  };
}

function message(id: string, parentId: string | null): TranscriptEvent {
  return { type: "message", id, parentId, message: { role: "user", content: id } };
}

function assistant(eventId: string, parentId?: string) {
  return { eventId, parentId, message: { role: "assistant", content: eventId } };
}

it.each(["event", "message"] as const)(
  "keeps %s append rollback with its owning worker transaction without a savepoint",
  async (kind) => {
    const { database, scope, append, transaction } = await createTranscript([
      message("root", null),
    ]);
    const before = loadTranscriptEventsSync(scope);
    expect(() => append("outside-transaction", undefined, database)).toThrow(
      "Transcript write lost its owning transaction",
    );
    const transactionSql = vi.spyOn(database.db, "exec");
    try {
      expect(() =>
        transaction((current) => {
          const snapshot =
            kind === "event"
              ? appendTranscriptEventSnapshotSync(
                  scope,
                  { type: "custom", id: "rolled-back", parentId: "root" },
                  {},
                  undefined,
                  undefined,
                  current,
                )
              : append("rolled-back", undefined, current);
          expect(snapshot.ok).toBe(true);
          throw new Error("owning request refused commit");
        }),
      ).toThrow("owning request refused commit");
      expect(transactionSql.mock.calls.some(([sql]) => /SAVEPOINT/i.test(sql))).toBe(false);
    } finally {
      transactionSql.mockRestore();
    }
    expect(loadTranscriptEventsSync(scope)).toEqual(before);
    const next = append("committed");
    expect(next).toMatchObject({ ok: true, value: { result: { messageId: "committed" } } });
  },
);

it.each(["dirty", "unclassified"] as const)(
  "shares append metadata without retaining facts across rollback or foreign %s writes",
  async (change) => {
    const {
      database,
      scope,
      append: appendSnapshot,
      transaction,
    } = await createTranscript([message("root", null), message("tail", "root")]);
    const append = (id: string, parentId: string) => {
      const snapshot = appendSnapshot(id, parentId);
      if (!snapshot.ok) {
        throw new Error(`Append refused: ${snapshot.error.code}`);
      }
      return snapshot.value;
    };
    const queries = trackSqliteStatementExecutions(
      requireNativeSqliteDatabase(database.db),
      ["projection", "tail"],
      (sql) => {
        if (!/^select /i.test(sql)) {
          return null;
        }
        if (sql.includes('"session_transcript_index_state"')) {
          return "projection";
        }
        return /^select "seq" from "transcript_events"/i.test(sql) &&
          sql.includes('order by "seq" desc')
          ? "tail"
          : null;
      },
    );
    let first: ReturnType<typeof append>;
    try {
      first = append("answer", "tail");
      expect(queries.counts).toEqual({ projection: 2, tail: 0 });
    } finally {
      queries.restore();
    }
    expect(first.result?.anchor).toMatchObject({
      entryId: "answer",
      rawSeq: 3,
      activeMessagePosition: 2,
      effectiveParentId: "tail",
    });
    expect(first.visibleTail).toEqual({ entryId: "answer", generation: first.after.generation });
    expect(() =>
      transaction(() => {
        expect(append("rolled-back", "answer").visibleTail.entryId).toBe("rolled-back");
        throw new Error("rollback append");
      }),
    ).toThrow("rollback append");
    const second = append("after-rollback", "answer");
    expect(second.result?.anchor).toMatchObject({
      entryId: "after-rollback",
      rawSeq: 4,
      activeMessagePosition: 3,
    });

    const peer = new (requireNodeSqlite().DatabaseSync)(database.path);
    try {
      peer
        .prepare(
          change === "dirty"
            ? "UPDATE session_transcript_index_state SET needs_rebuild = 1 WHERE session_id = ?"
            : "UPDATE session_transcript_active_events SET context_eligible = NULL WHERE session_id = ?",
        )
        .run(scope.sessionId);
    } finally {
      peer.close();
    }
    const fresh = append("after-foreign", "after-rollback");
    expect(fresh.result?.anchor).toBeUndefined();
    expect(fresh.visibleTail).toEqual({
      entryId: "after-foreign",
      generation: fresh.after.generation,
    });
  },
);

it("returns the newer visible tail after native identity-insert reentry", async () => {
  const { append } = await createTranscript([message("root", null)]);
  const { StatementSync } = requireNodeSqlite();
  // oxlint-disable-next-line typescript/unbound-method -- Forwarded below with the original native receiver.
  const original = StatementSync.prototype.run;
  let reentered = false;
  const spy = vi.spyOn(StatementSync.prototype, "run").mockImplementation(
    new Proxy(original, {
      apply(target, receiver, args) {
        const value = Reflect.apply(target, receiver, args);
        if (
          !reentered &&
          receiver.sourceSQL.startsWith('insert into "transcript_event_identities"') &&
          args.includes("outer")
        ) {
          reentered = true;
          const nested = append("nested", "outer");
          expect(nested.ok).toBe(true);
        }
        return value;
      },
    }),
  );
  try {
    const result = append("outer", "root");
    expect(reentered).toBe(true);
    expect(result).toMatchObject({
      ok: true,
      value: {
        result: { messageId: "outer", anchor: { entryId: "outer", rawSeq: 2 } },
        visibleTail: { entryId: "nested" },
        after: { rawSeq: 3 },
      },
    });
  } finally {
    spy.mockRestore();
  }
});

describe("SQLite transcript append ancestry", () => {
  const linear = [message("root", null), message("tail", "root")];
  const cycle = [message("cycle-a", "cycle-b"), message("cycle-b", "cycle-a")];
  it.each([
    ["dangling ancestor", [message("tail", "missing")], "missing", "tail"],
    ["unrelated cycle", cycle, "outside", "outside"],
    ["cycle without root", cycle, null, null],
    [
      "invalid leaf navigation fallback",
      [...linear, { type: "leaf", id: "invalid", parentId: "tail", targetId: "missing" }],
      "root",
      "tail",
    ],
    [
      "parentless navigation fallback",
      [
        ...linear,
        { type: "message", id: "parentless", message: { role: "user", content: "late" } },
      ],
      "root",
      "root",
    ],
  ] satisfies [string, TranscriptEvent[], string | null, string | null][])(
    "preserves %s",
    async (_name, events, parentId, expected) => {
      const { parent } = await createTranscript(events);
      expect(parent(parentId)).toBe(expected);
    },
  );

  it("does not traverse an ancestor from another session", async () => {
    const { scope, parent } = await createTranscript([message("tail", "foreign")]);
    const other = { ...scope, sessionId: "other", sessionKey: "agent:main:other" };
    await upsertSessionEntryCore(other, { sessionId: other.sessionId, updatedAt: 1 });
    replaceTranscriptEventsSync(other, [message("foreign", "root")]);
    expect(parent("root")).toBe("root");
  });
});

it.each(["missing-prepared", "missing-admitted", "overflow-prepared"] as const)(
  "preserves prepared assistant %s refusal before parsing newer messages",
  async (scenario) => {
    const { database, scope } = await createTranscript([
      message("admitted", null),
      message("prepared", "admitted"),
      message("poison", "prepared"),
      message("tail", "poison"),
    ]);
    database.db
      .prepare("UPDATE transcript_events SET event_json = '{' WHERE session_id = ? AND seq = 3")
      .run(scope.sessionId);
    if (scenario === "overflow-prepared") {
      runSqliteImmediateTransactionSync(database.db, () => {
        database.db.exec("PRAGMA defer_foreign_keys = ON");
        const offset = 9007199254740993n;
        for (const query of [
          "UPDATE transcript_events SET seq = seq + ? WHERE session_id = ?",
          "UPDATE transcript_event_identities SET seq = seq + ? WHERE session_id = ?",
          "UPDATE session_transcript_active_events SET event_seq = event_seq + ? WHERE session_id = ?",
        ]) {
          database.db.prepare(query).run(offset, scope.sessionId);
        }
      });
      expect(() => validatePreparedAssistantAppendSync(scope, "prepared", "prepared")).toThrow(
        expect.objectContaining({ code: "ERR_OUT_OF_RANGE" }),
      );
    } else {
      database.db
        .prepare("DELETE FROM transcript_event_identities WHERE session_id = ? AND event_id = ?")
        .run(scope.sessionId, scenario === "missing-prepared" ? "prepared" : "admitted");
      expect(
        validatePreparedAssistantAppendSync(
          scope,
          "prepared",
          scenario === "missing-prepared" ? "prepared" : "admitted",
        ),
      ).toBeUndefined();
    }
    expect(database.db.isTransaction).toBe(false);
  },
);
