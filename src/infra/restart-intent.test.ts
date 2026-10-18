import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DB as OpenClawStateKyselyDatabase } from "../state/openclaw-state-db.generated.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../state/openclaw-state-db.js";
import * as stateWorker from "../state/openclaw-state-worker-store.js";
import { useStateDatabaseTempDirs } from "../test-utils/state-database-temp-dirs.js";
import { acquireFileLockSync } from "./file-lock-manager.js";
import { resolveGatewayStateOwnerPath } from "./gateway-state-owner.js";
import {
  executeSqliteQuerySync,
  executeSqliteQueryTakeFirstSync,
  getNodeSqliteKysely,
} from "./kysely-sync.js";
import {
  clearGatewayRestartIntentSync,
  prepareGatewayRestartIntentConsumption,
  writeGatewayRestartIntentSync,
} from "./restart-intent.js";

function consumeIntent(now?: number, assertCurrent?: () => void) {
  return prepareGatewayRestartIntentConsumption(env, now, assertCurrent)();
}

function expectWrittenIntent(
  options: Omit<Parameters<typeof writeGatewayRestartIntentSync>[0], "env"> = {},
) {
  expect(writeGatewayRestartIntentSync({ targetPid: process.pid, ...options, env })).toBe(true);
}

let env: NodeJS.ProcessEnv;
const tempDirs = useStateDatabaseTempDirs();
type GatewayRestartIntentDatabase = Pick<OpenClawStateKyselyDatabase, "gateway_restart_intent">;

function createIntentEnv(initialize = true): NodeJS.ProcessEnv {
  const createdEnv = {
    ...process.env,
    OPENCLAW_STATE_DIR: tempDirs.make("openclaw-restart-intent-"),
  };
  if (initialize) {
    openOpenClawStateDatabase({ env: createdEnv });
  }
  return createdEnv;
}

function legacyIntentPath(): string {
  return path.join(env.OPENCLAW_STATE_DIR ?? "", "gateway-restart-intent.json");
}

function readIntentRow() {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
  return executeSqliteQueryTakeFirstSync(
    db,
    stateDb
      .selectFrom("gateway_restart_intent")
      .select(["intent_key", "kind", "pid", "created_at", "reason", "force", "wait_ms"])
      .where("intent_key", "=", "gateway-restart"),
  );
}

function insertIntentRow(values: { kind?: string; createdAt?: number }) {
  const { db } = openOpenClawStateDatabase({ env });
  const stateDb = getNodeSqliteKysely<GatewayRestartIntentDatabase>(db);
  const now = Date.now();
  executeSqliteQuerySync(
    db,
    stateDb.insertInto("gateway_restart_intent").values({
      intent_key: "gateway-restart",
      kind: values.kind ?? "gateway-restart",
      pid: process.pid,
      created_at: values.createdAt ?? now,
      reason: null,
      force: null,
      wait_ms: null,
      updated_at_ms: now,
    }),
  );
}

describe("gateway restart intent", () => {
  beforeEach(() => {
    env = createIntentEnv();
  });

  it("consumes a fresh intent for the current process", async () => {
    const env = createIntentEnv();

    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(true);

    expect(await consumeGatewayRestartIntentPayload(env)).toEqual({});
    expect(readIntentRow(env)).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath(env))).toBe(false);
  });

  it("settles a contended consume exactly once without blocking the signal thread", async () => {
    expectWrittenIntent({ reason: "gateway.restart" });
    const { path: filename } = openOpenClawStateDatabase({ env });
    using foreign = new DatabaseSync(filename);
    foreign.exec("BEGIN IMMEDIATE");
    const consuming = consumeIntent();
    // The worker can wait for the writer while the signal thread releases it.
    foreign.exec("COMMIT");
    expect(await consuming).toEqual({ reason: "gateway.restart" });
    expect(readIntentRow()).toBeUndefined();
    expect(await consumeIntent()).toBeNull();
  });

  it("keeps an intent when the captured signal owner retires before admission", async () => {
    expectWrittenIntent();
    let current = true;
    const consuming = consumeIntent(Date.now(), () => {
      if (!current) {
        throw new Error("signal owner retired");
      }
    });
    current = false;
    await expect(consuming).rejects.toThrow("signal owner retired");
    expect(readIntentRow()).toBeDefined();
    expect(await consumeIntent()).toEqual({});
  });

  it("recovers a committed intent after its ordinary reply is lost without consuming again", async () => {
    expectWrittenIntent({ reason: "gateway.restart" });
    const execute = stateWorker.runOpenClawStateWorkerOperation;
    vi.spyOn(stateWorker, "runOpenClawStateWorkerOperation").mockImplementationOnce(
      async (...args) => {
        await execute(...args);
        throw new Error("ordinary reply lost after native settlement");
      },
    );
    expect(await consumeIntent()).toEqual({ reason: "gateway.restart" });
    expect(await consumeIntent()).toBeNull();
  });

  it("records restart options while an older Gateway owns a pending-migration database", () => {
    const database = openOpenClawStateDatabase({ env });
    const filename = database.path;
    closeOpenClawStateDatabaseForTest();
    using db = new DatabaseSync(filename);
    // The restart table is unchanged across this schema boundary.
    db.exec("PRAGMA user_version=15; UPDATE schema_meta SET schema_version=15");
    const before = db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all();
    // Independent custody models the older serving process without lending schema authority.
    const pathname = resolveGatewayStateOwnerPath(filename);
    const owner = acquireFileLockSync(pathname, {
      lockPath: pathname,
      retry: { retries: 0 },
      payload: () => ({
        pid: process.pid,
        createdAt: new Date().toISOString(),
        configPath: "synthetic",
      }),
    });
    try {
      expectWrittenIntent({
        intent: { reason: "gateway.restart", force: true, waitMs: 12_345 },
      });
      expect(
        db.prepare("SELECT pid, reason, force, wait_ms FROM gateway_restart_intent").get(),
      ).toEqual({
        pid: process.pid,
        reason: "gateway.restart",
        force: 1,
        wait_ms: 12_345,
      });
      expect(db.prepare("PRAGMA user_version").get()).toEqual({ user_version: 15 });
      expect(db.prepare("SELECT schema_version FROM schema_meta").get()).toEqual({
        schema_version: 15,
      });
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
      clearGatewayRestartIntentSync(env);
      expect(db.prepare("SELECT * FROM gateway_restart_intent").all()).toEqual([]);
      expect(db.prepare("SELECT * FROM sqlite_schema ORDER BY name").all()).toEqual(before);
    } finally {
      owner.release();
    }
  });

  it("skips intent recording instead of bootstrapping missing Gateway state", () => {
    env = createIntentEnv(false);
    expect(writeGatewayRestartIntentSync({ env, targetPid: process.pid })).toBe(false);
    expect(fs.readdirSync(env.OPENCLAW_STATE_DIR ?? "")).toEqual([]);
  });

  it("rejects an intent for a different process", async () => {
    expectWrittenIntent({ targetPid: process.pid + 1 });

    expect(await consumeIntent()).toBeNull();
    expect(readIntentRow()).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath())).toBe(false);
  });

  it.each(["expired", "malformed"])("rejects %s intents before restart", async (kind) => {
    insertIntentRow(
      kind === "expired" ? { createdAt: Date.now() - 120_000 } : { kind: "bad-intent" },
    );
    expect(await consumeIntent()).toBeNull();
    expect(readIntentRow()).toBeUndefined();
  });

  it("round-trips restart options without persisting process-local successor identity", async () => {
    expectWrittenIntent({
      reason: "gateway.restart",
      intent: {
        force: true,
        waitMs: 12_345,
        successorOwner: {
          kind: "managed-update-handoff",
          handoffId: "private-handoff",
          installRoot: "/private/install",
        },
      },
    });

    expect(await consumeIntent()).toEqual({
      reason: "gateway.restart",
      force: true,
      waitMs: 12_345,
    });
    expect(readIntentRow()).toBeUndefined();
    expect(fs.existsSync(legacyIntentPath())).toBe(false);
  });

  it("backs off before an emoji that crosses the persisted reason limit", async () => {
    const env = createIntentEnv();
    insertIntentRow(env, { reason: "x".repeat(199) + "🧠tail" });

    expect(await consumeGatewayRestartIntentPayload(env)).toEqual({
      reason: "x".repeat(199),
    });
  });

  it("overwrites the previous pending intent row", async () => {
    expectWrittenIntent({
      targetPid: process.pid + 1,
      reason: "first",
    });
    expectWrittenIntent({ reason: "second" });

    expect(readIntentRow()).toMatchObject({
      intent_key: "gateway-restart",
      kind: "gateway-restart",
      pid: process.pid,
      reason: "second",
    });
    expect(await consumeIntent()).toEqual({ reason: "second" });
  });
});
