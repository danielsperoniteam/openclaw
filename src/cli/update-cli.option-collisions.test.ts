import { beforeEach, describe, expect, it, vi } from "vitest";
import { runRegisteredCli } from "../test-utils/command-runner.js";
import { registerUpdateCli } from "./update-cli.js";

const mocks = vi.hoisted(() => ({
  updateCleanupCommand: vi.fn(async (_opts: unknown) => {}),
  updateAdoptImmutableCommand: vi.fn(async (_opts: unknown) => {}),
  updateRecoverImmutableCommand: vi.fn(async (_opts: unknown) => {}),
  updateCommand: vi.fn(async (_opts: unknown) => {}),
  updateFinalizeCommand: vi.fn(async (_opts: unknown) => {}),
  updateStatusCommand: vi.fn(async (_opts: unknown) => {}),
  updateWizardCommand: vi.fn(async (_opts: unknown) => {}),
  defaultRuntime: {
    log: vi.fn(),
    error: vi.fn(),
    writeStdout: vi.fn(),
    writeJson: vi.fn(),
    exit: vi.fn(),
  },
}));

const {
  updateCommand,
  updateFinalizeCommand,
  updateStatusCommand,
  updateWizardCommand,
  defaultRuntime,
} = mocks;

vi.mock("./update-cli/update-command.js", () => ({ updateCommand: mocks.updateCommand }));
vi.mock("./update-cli/update-command-finalize.js", () => ({
  updateFinalizeCommand: mocks.updateFinalizeCommand,
}));

vi.mock("./update-cli/update-repair-command.js", () => ({
  updateRepairCommand: mocks.updateFinalizeCommand,
}));

vi.mock("./update-cli/cleanup.js", () => ({ updateCleanupCommand: mocks.updateCleanupCommand }));
vi.mock("./update-cli/update-command-immutable.js", () => ({
  updateAdoptImmutableCommand: mocks.updateAdoptImmutableCommand,
  updateRecoverImmutableCommand: mocks.updateRecoverImmutableCommand,
}));

vi.mock("./update-cli/status.js", () => ({ updateStatusCommand: mocks.updateStatusCommand }));
vi.mock("./update-cli/wizard.js", () => ({ updateWizardCommand: mocks.updateWizardCommand }));

vi.mock("../runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../runtime.js")>();
  return {
    ...actual,
    defaultRuntime: mocks.defaultRuntime,
  };
});

function run(argv: string[]) {
  return runRegisteredCli({ register: registerUpdateCli, argv });
}

function firstCallOptions(mock: { mock: { calls: unknown[][] } }) {
  return mock.mock.calls[0]?.[0];
}

function expectRejected(message: string, ...commands: Array<typeof updateCommand>) {
  expect(defaultRuntime.error).toHaveBeenCalledWith(expect.stringContaining(message));
  for (const command of commands) {
    expect(command).not.toHaveBeenCalled();
  }
}

describe("update cli option collisions", () => {
  beforeEach(() => vi.clearAllMocks());

  it.each([
    { args: ["--full-integrity-check"], target: updateCommand },
    { args: ["repair", "--full-integrity-check"], target: updateFinalizeCommand },
    { args: ["--full-integrity-check", "wizard"], target: updateWizardCommand },
  ])("passes full migration integrity selection through $args", async ({ args, target }) => {
    await run(["update", ...args]);
    expect(firstCallOptions(target)).toMatchObject({ fullIntegrityCheck: true });
  });

  const adoptionArgs = [
    "update",
    "adopt-immutable",
    ...Object.entries({
      root: "/opt/example",
      service: "example.service",
      account: "openclaw",
      "state-dir": "/var/lib/example",
      config: "/etc/example/openclaw.json",
      runtime: "/usr/bin/node",
    }).flatMap(([key, value]) => [`--${key}`, value]),
  ];
  it("requires explicit prior-updater acknowledgement for immutable adoption", async () => {
    await run(adoptionArgs);
    expectRejected("--previous-updater-stopped", mocks.updateAdoptImmutableCommand);
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("requires explicit activation consent and binds native recovery to its root", async () => {
    await run([
      ...adoptionArgs,
      "--previous-updater-stopped",
      "--enable-activation",
      "--inspect-release-retention",
    ]);
    expect(mocks.updateAdoptImmutableCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        root: "/opt/example",
        service: {
          unit: "example.service",
          scope: "system",
          account: "openclaw",
          stateDir: "/var/lib/example",
          configPath: "/etc/example/openclaw.json",
          profile: null,
        },
        runtime: "/usr/bin/node",
        previousUpdaterStopped: true,
        enableActivation: true,
        inspectReleaseRetention: true,
      }),
    );
    await run(["update", "--timeout", "600", "--json", "recover", "--root", "/opt/example"]);
    expect(mocks.updateRecoverImmutableCommand).toHaveBeenCalledWith({
      root: "/opt/example",
      timeout: "600",
      drainTimeout: undefined,
      json: true,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it("passes exact immutable SHA selection only to the update action", async () => {
    const sha = "a".repeat(40);
    await run(["update", "--sha", sha]);
    expect(updateCommand).toHaveBeenCalledWith(expect.objectContaining({ sha }));
    await run(["update", "--sha", sha, "status"]);
    expectRejected("--sha is supported only", updateStatusCommand);
  });

  it("passes a distinct immutable drain budget and refuses it on unrelated leaves", async () => {
    await run(["update", "--drain-timeout", "30", "--timeout", "600"]);
    expect(updateCommand).toHaveBeenCalledWith(
      expect.objectContaining({ drainTimeout: "30", timeout: "600" }),
    );
    await run("update --drain-timeout 30 recover --root /opt/example --timeout 900".split(" "));
    expect(mocks.updateRecoverImmutableCommand).toHaveBeenCalledWith(
      expect.objectContaining({ drainTimeout: "30", timeout: "900" }),
    );
    await run(["update", "--drain-timeout", "30", "status"]);
    expectRejected("--drain-timeout is supported only", updateStatusCommand);
  });

  it("supports inherited cleanup options", async () => {
    await run(["update", "--dry-run", "--json", "--yes", "cleanup"]);
    expect(mocks.updateCleanupCommand).toHaveBeenCalledWith({
      dryRun: true,
      json: true,
      yes: true,
    });
    expect(updateCommand).not.toHaveBeenCalled();
  });

  it.each([["--channel", ""], ["--no-restart"], ["--accept-capabilities"]])(
    "rejects unrelated inherited cleanup option %s",
    async (...flags) => {
      await run(["update", ...flags, "cleanup"]);
      expectRejected("is not supported", mocks.updateCleanupCommand, updateCommand);
      expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
    },
  );

  it("rejects replay consent on update leaves", async () => {
    await run(["update", "--reapply-local-overrides", "status"]);
    expectRejected(
      "--reapply-local-overrides is not supported",
      updateCommand,
      updateFinalizeCommand,
      updateWizardCommand,
      updateStatusCommand,
    );
  });

  it("rejects parent --dry-run before running update repair", async () => {
    await run(["update", "--dry-run", "repair"]);
    expect(updateFinalizeCommand).not.toHaveBeenCalled();
    expect(updateCommand).not.toHaveBeenCalled();
    expect(defaultRuntime.error).toHaveBeenCalledWith(
      "--dry-run is not supported for `openclaw update repair`. Run `openclaw update --dry-run` instead.",
    );
    expect(defaultRuntime.exit).toHaveBeenCalledWith(1);
  });

  it("forwards all explicitly inherited options to update finalize", async () => {
    await run("update --json --timeout 31 --channel beta --yes finalize".split(" "));
    expect(updateFinalizeCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateFinalizeCommand)).toMatchObject({
      channel: "beta",
      json: true,
      timeout: "31",
      yes: true,
    });
  });

  it("preserves an explicitly empty status timeout over its inherited value", async () => {
    await run(["update", "--timeout", "9", "status", "--json", "--timeout", ""]);
    expect(updateStatusCommand).toHaveBeenCalledOnce();
    expect(firstCallOptions(updateStatusCommand)).toMatchObject({ json: true, timeout: "" });
  });
});
