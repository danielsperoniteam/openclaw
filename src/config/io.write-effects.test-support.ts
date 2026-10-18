import fs from "node:fs";
import path from "node:path";
import { prepareConfigFileWrite } from "./backup-rotation.js";
import { hashConfigRaw } from "./io.read-helpers.js";
import {
  captureConfigFileWritePathProof,
  createConfigFileWriteGuard,
  rollbackConfigFileWriteIfUnchanged,
} from "./io.write-safety.js";

export const original = '{"channel":"stable"}\n';
export const content = '{"channel":"beta"}\n';

export function createWriteEffectsFixture(dir: string) {
  const target = path.join(dir, "channel.json");
  fs.writeFileSync(target, original);
  const proof = captureConfigFileWritePathProof(target, target, fs);
  const refusal = new Error("original executor revoked");
  let current = true;
  const assertCurrent = () => {
    if (!current) {
      throw refusal;
    }
    proof.assertCurrent();
  };
  const options = {
    snapshot: { path: target, exists: true, raw: original },
    includeGraph: { hashes: {}, targets: {} },
    targetPathProof: proof,
    preserveDirectoryMode: true,
  };
  const backups = () =>
    ["", ".1", ".2", ".3", ".4"].map((suffix) => {
      try {
        return fs.readFileSync(`${target}.bak${suffix}`, "utf8");
      } catch {
        return null;
      }
    });
  const rollback = (
    io: typeof fs,
    rollbackProof: ReturnType<
      ReturnType<typeof createConfigFileWriteGuard>["captureRollbackProof"]
    >,
    overrides: Partial<Parameters<typeof rollbackConfigFileWriteIfUnchanged>[0]> = {},
  ) =>
    rollbackConfigFileWriteIfUnchanged({
      configPath: target,
      previousSnapshot: options.snapshot,
      committedHash: hashConfigRaw(content),
      fsModule: io,
      ...rollbackProof,
      ...overrides,
    });
  return {
    dir,
    target,
    assertCurrent,
    refusal,
    options,
    backups,
    rollback,
    revoke: () => (current = false),
  };
}

export async function prepareWriteEffects(
  f: ReturnType<typeof createWriteEffectsFixture>,
  io: typeof fs = fs,
  options: Parameters<typeof createConfigFileWriteGuard>[3] = f.options,
) {
  const guarded = createConfigFileWriteGuard(f.target, io, f.assertCurrent, options);
  const prepared = await prepareConfigFileWrite({
    configPath: f.target,
    previousRaw: original,
    content,
    fsModule: guarded.fileSystem,
    assertCurrent: guarded.assertCurrent,
    assertBeforeMutation: guarded.assertBeforeMutation,
    onDestinationState: guarded.onDestinationState,
    destinationHardlinks: "reject",
    durable: true,
  });
  return { guarded, prepared };
}
