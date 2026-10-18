import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, StatementSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  observeHostDataSql,
  observeSqliteReadSql,
} from "../../test/helpers/sqlite-statement-execution-counter.js";
import { useAutoCleanupTempDirTracker } from "../../test/helpers/temp-dir.js";
import { openNodeSqliteDatabase } from "../infra/node-sqlite.js";
import type { EngineConnection } from "../infra/sql-connection.js";
import { classifySqliteMutation } from "../infra/sqlite-schema-mutation.js";
import { extractSqliteTableSchema } from "../infra/sqlite-schema-sql.js";
import * as maintenance from "../infra/state-database-maintenance.js";
import { closeOpenClawStateDatabaseByPathAsync as closePath } from "./openclaw-state-db-cache.js";
import { OPENCLAW_STATE_SCHEMA_VERSION as SCHEMA_VERSION } from "./openclaw-state-db-contract.js";
import {
  openExistingOpenClawStateWriter as openExistingWriter,
  runExistingOpenClawStateWriteTransaction as writeExisting,
} from "./openclaw-state-db-existing-write.js";
import { withExistingOpenClawStateSchema as withExistingSchema } from "./openclaw-state-db-schema-policy.js";
import { openOpenClawStateDatabase as openState } from "./openclaw-state-db.js";
import { OPENCLAW_STATE_SCHEMA_SQL as SCHEMA_SQL } from "./openclaw-state-schema.js";
import { ensureUserPreferencesSchema } from "./user-preferences.store.js";

const writers = new Set<ReturnType<typeof openExistingWriter>>();
const tempDirs = useAutoCleanupTempDirTracker((cleanup) =>
  afterEach(() => {
    vi.restoreAllMocks();
    for (const writer of writers) {
      writer.close();
    }
    writers.clear();
    cleanup();
  }),
);
const recordSchema = "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT;";
const contract = {
  schemaSql: extractSqliteTableSchema(SCHEMA_SQL, "config_machine_state"),
  operationLabel: "retained writer test",
};
const schemaInventorySql =
  /\b(?:sqlite_schema|sqlite_master|(?:pragma_)?(?:table|index)_(?:list|info|xinfo))\b/iu;
function fixture(fullSchema = false) {
  const root = tempDirs.make("openclaw-existing-writer-");
  const options = { path: path.join(root, "state.sqlite"), env: { OPENCLAW_STATE_DIR: root } };
  using database = new DatabaseSync(options.path);
  database.exec(
    fullSchema
      ? SCHEMA_SQL
      : `
      CREATE TABLE schema_meta (
        meta_key TEXT PRIMARY KEY, role TEXT, schema_version INTEGER,
        created_at INTEGER, updated_at INTEGER
      );
      ${contract.schemaSql}
    `,
  );
  database.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA user_version = ${SCHEMA_VERSION};
      INSERT INTO schema_meta (meta_key, role, schema_version, created_at, updated_at)
        VALUES ('primary', 'global', ${SCHEMA_VERSION}, 1, 1);
      ${recordSchema}
    `);
  return options;
}

function readValues(pathname: string) {
  using database = new DatabaseSync(pathname, { readOnly: true });
  return database
    .prepare("SELECT value FROM records ORDER BY id")
    .all()
    .map((row) => row.value);
}

function readSchemaMarkers(database: DatabaseSync) {
  return {
    userVersion: database.prepare("PRAGMA user_version").get()?.user_version,
    schemaVersion: database.prepare("PRAGMA schema_version").get()?.schema_version,
  };
}

function openWriter(options: ReturnType<typeof fixture>) {
  const writer = openExistingWriter(options, contract);
  writers.add(writer);
  return writer;
}

function sidecarIdentities(pathname: string) {
  return ["-wal", "-shm"].map((suffix) => {
    const { dev, ino } = fs.statSync(`${pathname}${suffix}`);
    return { dev, ino };
  });
}
describe("retained existing-state writer", () => {
  it("admits maintenance with QUICK without lending that receipt to a FULL writer", () => {
    const options = fixture();
    const reads = observeSqliteReadSql(StatementSync.prototype);
    writeExisting(({ db }) => db.exec("INSERT INTO records VALUES (1, 'quick write')"), options, {
      ...contract,
      integrityCheck: "quick",
    });
    expect(reads.queries).toContain("PRAGMA quick_check;");
    expect(reads.queries).toContain("PRAGMA integrity_check('config_machine_state');");
    expect(reads.queries).not.toContain("PRAGMA integrity_check;");
    writeExisting(
      ({ db }) => {
        expect(db.prepare("SELECT value FROM records WHERE id = 1").get()?.value).toBe(
          "quick write",
        );
        db.exec("INSERT INTO records VALUES (2, 'full write')");
      },
      options,
      contract,
    );
    expect(reads.queries.filter((query) => query === "PRAGMA integrity_check;")).toHaveLength(1);
    expect(readValues(options.path)).toEqual(["quick write", "full write"]);
  });

  it("initializes an existing additive subset without repeating DDL on its warm table", () => {
    const options = fixture(true);
    const queries: Array<{ query: string; database?: DatabaseSync }> = [];
    observeHostDataSql((query, database) => queries.push({ query, database }));
    let writer: EngineConnection | undefined;
    writeExisting(
      ({ db }) => {
        writer = db;
        db.prepare("INSERT INTO records VALUES (?, ?)").run(1, "warm subset");
      },
      options,
      { ...contract, initializeAdditiveSchema: true },
    );
    expect(readValues(options.path)).toEqual(["warm subset"]);
    expect(
      queries.filter(
        ({ query, database }) =>
          database === writer && classifySqliteMutation(query, "batch").mainSchemaChange,
      ),
    ).toEqual([]);
  });

  it("refuses invalid and restricted repair admission before acquiring schema maintenance", () => {
    const options = fixture();
    const repairContract = { ...contract, recoverTaskDeliveryOrphans: true as const };
    const lease = vi.spyOn(maintenance, "withStateDatabaseSchemaMaintenance");
    const mutate = vi.fn();
    expect(() => writeExisting(mutate, { ...options, readOnly: true }, repairContract)).toThrow(
      /own tracked writable connection/iu,
    );
    expect(() =>
      withExistingSchema(options, () => writeExisting(mutate, options, repairContract)),
    ).toThrow(/schema repair is owned/iu);
    expect(lease).not.toHaveBeenCalled();
    expect(mutate).not.toHaveBeenCalled();
  });

  it("preserves a replacement appearing during schema lease acquisition", () => {
    const options = fixture();
    const replacement = fixture();
    {
      using replacementDatabase = new DatabaseSync(replacement.path);
      replacementDatabase.exec("INSERT INTO records VALUES (99, 'replacement preserved')");
    }
    const replacementBytes = fs.readFileSync(replacement.path);
    const withMaintenance = maintenance.withStateDatabaseSchemaMaintenance;
    const lease = vi
      .spyOn(maintenance, "withStateDatabaseSchemaMaintenance")
      .mockImplementation((leaseOptions, operation) =>
        withMaintenance(leaseOptions, () => {
          fs.renameSync(options.path, `${options.path}.retired`);
          fs.copyFileSync(replacement.path, options.path);
          return operation();
        }),
      );
    const mutate = vi.fn(({ db }: { db: EngineConnection }) => {
      db.exec("INSERT INTO records VALUES (1, 'wrong generation')");
    });
    expect(() =>
      writeExisting(mutate, options, { ...contract, recoverTaskDeliveryOrphans: true }),
    ).toThrow(/generation/iu);
    expect(lease).toHaveBeenCalledOnce();
    expect(mutate).not.toHaveBeenCalled();
    expect(fs.readFileSync(options.path).equals(replacementBytes)).toBe(true);
    expect(readValues(options.path)).toEqual(["replacement preserved"]);
  });

  it("retains WAL files and one integrity admission through ordinary local and sibling writes", () => {
    const options = fixture();
    const reads = observeSqliteReadSql(StatementSync.prototype);
    const writer = openWriter(options);
    let retained: EngineConnection | undefined;
    writer.run(({ db }) => {
      retained = db;
      db.prepare("INSERT INTO records VALUES (?, ?)").run(1, "first");
    }, options);
    const sidecars = sidecarIdentities(options.path);
    {
      using external = openNodeSqliteDatabase(options.path);
      external.prepare("INSERT INTO records VALUES (?, ?)").run(2, "foreign");
    }
    writer.run(({ db }) => {
      expect(db).toBe(retained);
      db.prepare("INSERT INTO records VALUES (?, ?)").run(3, "last");
    }, options);
    const warmQueryCount = reads.queries.length;
    writer.run(({ db }) => db.prepare("INSERT INTO records VALUES (?, ?)").run(4, "warm"), options);
    expect(
      reads.queries.slice(warmQueryCount).filter((sql) => schemaInventorySql.test(sql)),
    ).toEqual([]);
    writer.assertSettled();
    expect(readValues(options.path)).toEqual(["first", "foreign", "last", "warm"]);
    expect(sidecarIdentities(options.path)).toEqual(sidecars);
    expect(reads.queries.filter((sql) => /^PRAGMA integrity_check\s*;?$/iu.test(sql))).toHaveLength(
      1,
    );
    expect(
      reads.queries.filter((sql) => /^PRAGMA foreign_key_check\s*;?$/iu.test(sql)),
    ).toHaveLength(1);
    writer.close();
    expect(retained?.isOpen).toBe(false);
    expect(fs.existsSync(`${options.path}-wal`)).toBe(false);
    expect(fs.existsSync(`${options.path}-shm`)).toBe(false);
  });

  it("readmits canonical same-version lazy DDL once before resuming warm subset writes", async () => {
    const options = fixture(true);
    const peer = openState(options);
    peer.db.exec("DROP TABLE user_preferences");
    const version = peer.db.prepare("PRAGMA user_version").get();
    const writer = openWriter(options);
    const reads = observeSqliteReadSql(StatementSync.prototype);
    try {
      writer.run(({ db }) => {
        expect(db).not.toBe(peer.db);
        db.exec("INSERT INTO records VALUES (1, 'before addition')");
      }, options);
      ensureUserPreferencesSchema({ ...options, database: peer });
      expect(peer.db.prepare("SELECT COUNT(*) AS total FROM user_preferences").get()).toEqual({
        total: 0,
      });
      expect(peer.db.prepare("PRAGMA user_version").get()).toEqual(version);
      writer.run(({ db }) => db.exec("INSERT INTO records VALUES (2, 'after addition')"), options);
      const readmittedQueryCount = reads.queries.length;
      writer.run(({ db }) => db.exec("INSERT INTO records VALUES (3, 'warm again')"), options);
      expect(
        reads.queries
          .slice(readmittedQueryCount)
          .filter(
            (sql) =>
              schemaInventorySql.test(sql) ||
              /\b(?:integrity_check|quick_check|foreign_key_check)\b/iu.test(sql),
          ),
      ).toEqual([]);
      expect(readValues(options.path)).toEqual(["before addition", "after addition", "warm again"]);
    } finally {
      reads.restore();
      writer.close();
      await closePath(options.path);
    }
  });

  it("retains a failed close for cleanup while refusing further writes", () => {
    const options = fixture();
    const writer = openWriter(options);
    const retained = writer.run(({ db }) => {
      db.exec("INSERT INTO records VALUES (1, 'preserved')");
      return db;
    }, options);
    const failure = new Error("synthetic native close failure");
    vi.spyOn(retained, "close").mockImplementationOnce(() => {
      throw failure;
    });
    expect(() => writer.close()).toThrow(failure);
    expect(retained?.isOpen).toBe(true);
    expect(fs.existsSync(`${options.path}-wal`)).toBe(true);
    const mutate = vi.fn();
    expect(() => writer.run(mutate, options)).toThrow(/closed/iu);
    expect(mutate).not.toHaveBeenCalled();
    writer.close();
    expect(retained?.isOpen).toBe(false);
    expect(fs.existsSync(`${options.path}-wal`)).toBe(false);
    expect(fs.existsSync(`${options.path}-shm`)).toBe(false);
    expect(readValues(options.path)).toEqual(["preserved"]);
  });

  it.skipIf(process.platform === "win32")(
    "rejects replacement before a retained write callback",
    () => {
      const options = fixture();
      const writer = openWriter(options);
      writer.run(() => undefined, options);
      const replacement = fixture();
      fs.renameSync(options.path, `${options.path}.retired`);
      fs.copyFileSync(replacement.path, options.path);
      const mutate = vi.fn();
      expect(() => writer.run(mutate, options)).toThrow(/generation/iu);
      expect(mutate).not.toHaveBeenCalled();
      expect(readValues(options.path)).toEqual([]);
      writer.close();
    },
  );
  it.each([
    [`PRAGMA user_version = ${SCHEMA_VERSION + 1}`, /newer schema version/iu, true],
    [
      "DELETE FROM config_machine_state WHERE state_key = 'state.schema.contentVersion'",
      /requires schema migration by its owning installation/iu,
      false,
      true,
    ],
    ["UPDATE schema_meta SET role = 'agent' WHERE meta_key = 'primary'", /schema role agent/iu],
    [
      `UPDATE schema_meta SET schema_version = ${SCHEMA_VERSION - 1} WHERE meta_key = 'primary'`,
      /schema metadata is inconsistent/iu,
    ],
    ["DELETE FROM schema_meta WHERE meta_key = 'primary'", /schema role missing/iu],
    [
      `INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '${SCHEMA_VERSION + 1}', 1)`,
      /newer schema version/iu,
    ],
    [
      "INSERT INTO config_machine_state VALUES ('state.schema.contentVersion', '{', 1)",
      /invalid shared state schema content version/iu,
    ],
  ] as const)(
    "rejects metadata mutation %s",
    (sql, error, markersChange = false, deferred = false) => {
      const options = fixture(deferred);
      if (deferred) {
        using setup = new DatabaseSync(options.path);
        setup.exec(`
          PRAGMA user_version = ${SCHEMA_VERSION - 1};
          UPDATE schema_meta SET schema_version = ${SCHEMA_VERSION - 1}
            WHERE meta_key = 'primary';
          INSERT INTO config_machine_state VALUES
            ('state.schema.contentVersion', '${SCHEMA_VERSION}', 1);
        `);
      }
      const run = () => {
        // Raw fixture connections leave this physical file unadmitted until the writer opens it.
        {
          using external = new DatabaseSync(options.path);
          const before = readSchemaMarkers(external);
          external.exec(sql);
          if (!markersChange) {
            expect(readSchemaMarkers(external)).toEqual(before);
          }
        }
        const writer = openWriter(options);
        const mutate = vi.fn(({ db }: { db: EngineConnection }) => {
          db.exec("INSERT INTO records VALUES (2, 'refused')");
        });
        expect(() => writer.run(mutate, options)).toThrow(error);
        expect(mutate).not.toHaveBeenCalled();
        expect(readValues(options.path)).toEqual([]);
        writer.close();
      };
      if (deferred) {
        withExistingSchema(options, run);
      } else {
        run();
      }
    },
  );

  it("rechecks current environment for each retained write", () => {
    const options = fixture(true);
    const externalOptions = {
      ...options,
      env: { ...options.env, OPENCLAW_SUPERVISOR_MODE: "external" },
    };
    {
      using setup = new DatabaseSync(options.path);
      setup.prepare("INSERT INTO config_machine_state VALUES (?, ?, ?)").run(
        "gateway.supervision",
        JSON.stringify({
          version: 1,
          mode: "external",
          managerId: "fixture-owner",
          claimedAt: 1,
        }),
        1,
      );
    }
    const writer = withExistingSchema(options, () => {
      const result = openWriter(externalOptions);
      result.run(
        ({ db }) => db.exec("INSERT INTO records VALUES (1, 'authorized')"),
        externalOptions,
      );
      const refused = vi.fn();
      expect(() => result.run(refused, options)).toThrow(/external|managed/iu);
      expect(refused).not.toHaveBeenCalled();
      return result;
    });
    withExistingSchema(options, () => {
      writer.run(
        ({ db }) => db.exec("INSERT INTO records VALUES (2, 'readmitted')"),
        externalOptions,
      );
    });
    expect(readValues(options.path)).toEqual(["authorized", "readmitted"]);
    writer.close();
  });
});
