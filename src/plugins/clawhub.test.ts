/** Verifies ClawHub plugin spec parsing and install metadata handling. */
import fs from "node:fs/promises";
import path from "node:path";
import JSZip from "jszip";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withExtractedArchiveRoot } from "../infra/install-flow.js";
import { createZipCentralDirectoryArchive } from "../test-utils/zip-central-directory-fixture.js";
import { clawHubSecurityResponse, clawHubVersionMetadata } from "./clawhub.test-fixtures.js";
import {
  clawHubArchiveFile,
  clawHubPackageDetail,
  createClawHubArchiveFactory,
  createLoggerSpies,
  DEMO_ARCHIVE_INTEGRITY,
  DEMO_ARCHIVE_SHA256,
  DEMO_CLAWPACK_INTEGRITY,
  DEMO_CLAWPACK_SHA256,
  DEMO_PLUGIN_ARCHIVE_ENTRIES,
  expectInstallFailure,
  expectInstallFailureFields,
  expectInstallSuccess,
  expectSuccessfulClawHubInstall,
  mockCallArg,
  setClawHubArchiveEntryMode,
  sha256Hex,
  type ArchiveInstallCall,
  type ClawHubArchiveFile,
  type PackageLookupCall,
} from "./clawhub.test-support.js";
import type { PluginInstallArtifactConsentHandler } from "./install-types.js";

const mocks = vi.hoisted(() => ({
  parseSpec: vi.fn(),
  fetchDetail: vi.fn(),
  fetchArtifact: vi.fn(),
  fetchSecurity: vi.fn(),
  fetchVersion: vi.fn(),
  download: vi.fn(),
  cleanup: vi.fn(),
  latestVersion: vi.fn(),
  hostVersion: vi.fn(),
  installArchive: vi.fn(),
  installExtracted: vi.fn(),
}));

vi.mock("../infra/clawhub-spec.js", () => ({
  parseClawHubPluginSpec: mocks.parseSpec,
}));

vi.mock("../infra/clawhub-packages.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub-packages.js")>(
    "../infra/clawhub-packages.js",
  );
  return {
    ...actual,
    fetchClawHubPackageDetail: mocks.fetchDetail,
    fetchClawHubPackageArtifact: mocks.fetchArtifact,
    fetchClawHubPackageSecurity: mocks.fetchSecurity,
    fetchClawHubPackageVersion: mocks.fetchVersion,
    resolveLatestVersionFromPackage: mocks.latestVersion,
  };
});

vi.mock("../infra/clawhub-artifacts.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/clawhub-artifacts.js")>(
    "../infra/clawhub-artifacts.js",
  );
  return {
    ...actual,
    downloadClawHubPackageArchive: mocks.download,
  };
});

vi.mock("../version.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../version.js")>()),
  resolveCompatibilityHostVersion: mocks.hostVersion,
}));

vi.mock("./install.js", () => ({
  PLUGIN_INSTALL_ERROR_CODE: {
    PLUGIN_ID_MISMATCH: "plugin_id_mismatch",
  },
  installPluginFromArchive: mocks.installArchive,
}));

vi.mock("../infra/archive.js", async () => {
  const actual = await vi.importActual<typeof import("../infra/archive.js")>("../infra/archive.js");
  return {
    ...actual,
    DEFAULT_MAX_ENTRIES: 50_000,
    DEFAULT_MAX_EXTRACTED_BYTES: 512 * 1024 * 1024,
    DEFAULT_MAX_ENTRY_BYTES: 256 * 1024 * 1024,
  };
});

const { ClawHubRequestError } = await import("../infra/clawhub-client.js");
const { CLAWHUB_INSTALL_ERROR_CODE: errors, installPluginFromClawHub } =
  await import("./clawhub.js");

const createClawHubArchive = createClawHubArchiveFactory(afterEach);
const installDemo = (options: Partial<Parameters<typeof installPluginFromClawHub>[0]> = {}) =>
  installPluginFromClawHub({ spec: "clawhub:demo", ...options });
const npmArtifact = {
  kind: "npm-pack",
  format: "tgz",
  sha256: DEMO_CLAWPACK_SHA256,
};
const npmProvenance = { npmIntegrity: "sha512-clawpack", npmShasum: "1".repeat(40) };
const npmDownload = {
  archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
  integrity: DEMO_CLAWPACK_INTEGRITY,
  sha256Hex: DEMO_CLAWPACK_SHA256,
  artifact: "clawpack",
  clawpackHeaderSha256: DEMO_CLAWPACK_SHA256,
  ...npmProvenance,
};
const manifestFile = clawHubArchiveFile("openclaw.plugin.json", '{"id":"demo"}');

function expectUnused(...calls: ReturnType<typeof vi.fn>[]) {
  for (const call of calls) {
    expect(call).not.toHaveBeenCalled();
  }
}

function expectArchiveFailure(result: unknown, error: unknown) {
  expect(result).toMatchObject({ ok: false, code: errors.ARCHIVE_INTEGRITY_MISMATCH, error });
  expectUnused(mocks.installExtracted);
}

function mockVersion(overrides: Record<string, unknown> = {}) {
  mocks.fetchVersion.mockResolvedValueOnce(clawHubVersionMetadata(overrides));
}

async function mockArchive(
  params: {
    entries?: Record<string, string>;
    files?: readonly ClawHubArchiveFile[];
    version?: Record<string, unknown>;
  } = {},
) {
  const entries = params.entries ?? { "openclaw.plugin.json": '{"id":"demo"}' };
  const archive = await createClawHubArchive(entries);
  mockVersion({
    files:
      params.files ??
      Object.entries(entries)
        .filter(([filePath]) => filePath !== "_meta.json")
        .map(([filePath, contents]) => clawHubArchiveFile(filePath, contents)),
    ...params.version,
  });
  mocks.download.mockResolvedValueOnce({
    ...archive,
    cleanup: mocks.cleanup,
  });
  return archive;
}

function communityPackage() {
  mocks.fetchDetail.mockResolvedValue(
    clawHubPackageDetail({ channel: "community", isOfficial: false }),
  );
}

function mockSecurity(
  trust: Record<string, unknown>,
  releaseVersion = "2026.3.22",
  overview = "The plugin can modify local OpenClaw state.",
) {
  mocks.fetchSecurity.mockResolvedValueOnce(
    clawHubSecurityResponse("demo", releaseVersion, trust, overview),
  );
}

function mockPackage(overrides: Record<string, unknown>): void {
  mocks.fetchDetail.mockResolvedValueOnce(clawHubPackageDetail(overrides));
}

function packageDetailCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(mocks.fetchDetail, callIndex) as PackageLookupCall;
}

function packageVersionCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(mocks.fetchVersion, callIndex) as PackageLookupCall;
}

function archiveDownloadCall(callIndex = 0): PackageLookupCall {
  return mockCallArg(mocks.download, callIndex) as PackageLookupCall;
}

function archiveInstallCall(callIndex = 0): ArchiveInstallCall {
  return mockCallArg(mocks.installArchive, callIndex) as ArchiveInstallCall;
}

describe("installPluginFromClawHub", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) {
      mock.mockReset();
    }
    mocks.parseSpec.mockReturnValue({ name: "demo" });
    mocks.fetchDetail.mockResolvedValue(clawHubPackageDetail());
    mocks.latestVersion.mockReturnValue("2026.3.22");
    mocks.fetchVersion.mockResolvedValue(
      clawHubVersionMetadata({
        sha256hash: DEMO_ARCHIVE_SHA256,
        compatibility: { pluginApiRange: ">=2026.3.22", minGatewayVersion: "2026.3.0" },
      }),
    );
    mocks.fetchArtifact.mockImplementation((params) => mocks.fetchVersion(params));
    mocks.fetchSecurity.mockImplementation((params: { name?: string; version?: string }) =>
      Promise.resolve(clawHubSecurityResponse(params.name, params.version)),
    );
    mocks.download.mockResolvedValue({
      archivePath: "/tmp/clawhub-demo/archive.zip",
      integrity: DEMO_ARCHIVE_INTEGRITY,
      cleanup: mocks.cleanup,
    });
    mocks.cleanup.mockResolvedValue(undefined);
    mocks.hostVersion.mockReturnValue("2026.3.22");
    mocks.installExtracted.mockResolvedValue({
      ok: true,
      pluginId: "demo",
      targetDir: "/tmp/openclaw/plugins/demo",
      version: "2026.3.22",
    });
    mocks.installArchive.mockImplementation(
      async (
        params: Parameters<typeof import("./install-package.js").installPluginFromArchive>[0],
      ) => {
        if (!params.verification) {
          return await mocks.installExtracted();
        }
        return await withExtractedArchiveRoot({
          archivePath: params.archivePath,
          tempDirPrefix: "openclaw-clawhub-test-",
          timeoutMs: 10_000,
          verification: params.verification,
          rootMarkers: ["openclaw.plugin.json", "SKILL.md"],
          onExtracted: mocks.installExtracted,
        });
      },
    );
  });

  it("does not publish a ClawHub plugin after authority closes during artifact review", async () => {
    const archive = await mockArchive({
      entries: DEMO_PLUGIN_ARCHIVE_ENTRIES,
    });
    const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
    const { installPluginFromArchive } = await import("./install-package.js");
    mocks.installArchive.mockImplementationOnce(installPluginFromArchive);
    const archiveApi = await import("../infra/archive.js");
    const extraction = vi.spyOn(archiveApi, "extractArchive");
    let authorityActive = true;
    let result;
    try {
      result = await installDemo({
        extensionsDir,
        onBeforePluginArtifactCommit: async () => {
          authorityActive = false;
        },
        beforePersistentApply: () => {
          if (!authorityActive) {
            throw new Error("plugin installation authority closed");
          }
        },
      });
      expect(extraction).toHaveBeenCalledOnce();
    } finally {
      extraction.mockRestore();
    }
    expect(authorityActive).toBe(false);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("plugin installation authority closed"),
    });
    await expect(fs.stat(path.join(extensionsDir, "demo"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["package runtimeId", { runtimeId: "demo-runtime" }],
    ["capabilities.runtimeId", { capabilities: { runtimeId: "demo-runtime" } }],
  ])("pins archive installation to the advertised %s", async (_label, overrides) => {
    mockPackage(overrides);
    mocks.installArchive.mockResolvedValueOnce({
      ok: true,
      pluginId: "demo-runtime",
      targetDir: "/tmp/openclaw/plugins/demo-runtime",
      version: "2026.3.22",
    });
    const result = await installDemo();
    expect(expectInstallSuccess(result).pluginId).toBe("demo-runtime");
    expect(archiveInstallCall().expectedPluginId).toBe("demo-runtime");
  });

  it.each([
    {
      detail: { runtimeId: "advertised-runtime" },
      expectedPluginId: "expected-runtime",
      error:
        'ClawHub package runtime id mismatch: expected "expected-runtime", got "advertised-runtime".',
    },
    {
      detail: {
        runtimeId: "package-runtime",
        capabilities: { runtimeId: "capabilities-runtime" },
      },
      expectedPluginId: undefined,
      error:
        'ClawHub package runtime id mismatch: package advertises "package-runtime" but capabilities advertise "capabilities-runtime".',
    },
  ])(
    "rejects runtime id mismatch before download: $error",
    async ({ detail, expectedPluginId, error }) => {
      mockPackage(detail);
      const result = await installPluginFromClawHub({ spec: "clawhub:demo", expectedPluginId });
      const failure = expectInstallFailure(result);
      expect(failure).toMatchObject({ code: "plugin_id_mismatch", error });
      expectUnused(mocks.download, mocks.installArchive);
    },
  );

  it("passes custom-registry provenance and authority to consent", async () => {
    const baseUrl = "https://plugins.example.test";
    const onBeforePluginArtifactCommit = vi.fn();
    mocks.installArchive.mockImplementationOnce(
      async (params: { onBeforePluginArtifactCommit: PluginInstallArtifactConsentHandler }) => {
        await params.onBeforePluginArtifactCommit({
          pluginId: "demo",
          stagedArtifactDir: "/tmp/openclaw/plugins/demo",
          mode: "install",
        });
        return { ok: true, pluginId: "demo", targetDir: "/tmp/openclaw/plugins/demo" };
      },
    );
    const result = await installDemo({
      baseUrl,
      onBeforePluginArtifactCommit,
    });
    expect(result.ok).toBe(true);
    expect(onBeforePluginArtifactCommit).toHaveBeenCalledWith({
      pluginId: "demo",
      stagedArtifactDir: "/tmp/openclaw/plugins/demo",
      mode: "install",
      sourceRecord: {
        source: "clawhub",
        spec: "clawhub:demo",
        clawhubUrl: baseUrl,
        clawhubPackage: "demo",
        clawhubChannel: "official",
        integrity: DEMO_ARCHIVE_INTEGRITY,
      },
    });
    expect(archiveInstallCall().installPolicyRequest?.source).toEqual({
      kind: "clawhub",
      authority: "third-party",
      mutable: false,
      network: true,
    });
  });

  it.each(["catalog", "version metadata"])(
    "rejects a %s archive integrity mismatch before extraction",
    async (source) => {
      const expectedIntegrity = `sha256-${Buffer.from("1".repeat(64), "hex").toString("base64")}`;
      if (source === "version metadata") {
        mockVersion({ sha256hash: "1".repeat(64) });
      }
      const onBeforePluginArtifactCommit = vi.fn();
      const result = await installDemo({
        ...(source === "catalog" ? { expectedIntegrity } : {}),
        onBeforePluginArtifactCommit,
      });
      expectArchiveFailure(
        result,
        `ClawHub archive integrity mismatch for "demo@2026.3.22": expected ${expectedIntegrity}, got ${DEMO_ARCHIVE_INTEGRITY}.`,
      );
      expectUnused(mocks.installArchive, onBeforePluginArtifactCommit);
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("sanitizes the ClawHub package summary link before logging", async () => {
    const logger = createLoggerSpies();
    await installDemo({
      baseUrl: "https://clawhub.ai/\u001b]8;;https://evil.example\u0007\ninjected",
      logger,
    });
    const summary = logger.info.mock.calls.map(([message]) => message).join("\n");
    expect(summary).toContain("ClawHub");
    expect(summary).not.toContain("\u001b");
    expect(summary).not.toContain("\u0007");
    expect(summary).not.toContain("https://clawhub.ai/\ninjected");
    expect(summary).toContain("https://clawhub.ai/\\ninjected/plugins/demo");
  });

  it("blocks malicious ClawHub releases before missing-artifact fallback", async () => {
    communityPackage();
    mockVersion();
    mockSecurity({
      scanStatus: "malicious",
      moderationState: "quarantined",
      blockedFromDownload: true,
      reasons: ["manual_moderation"],
    });
    const logger = { ...createLoggerSpies(), terminalLinks: true };
    const result = await installDemo({
      baseUrl: "https://clawhub.ai",
      logger,
    });
    const failure = expectInstallFailure(result);
    expect(failure).toMatchObject({
      code: errors.CLAWHUB_DOWNLOAD_BLOCKED,
      error: "ClawHub blocked this release; install was not started.",
    });
    expect(failure.warning).toContain("Outcome: Blocked");
    expect(failure.warning).not.toContain("\u001b");
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Blocked"));
    const warning = logger.warn.mock.calls[0]?.[0] ?? "";
    expect(warning).toContain("Overview:");
    expect(warning).toContain("https://clawhub.ai/plugins/demo/security-audit?version=2026.3.22");
    expect(warning).not.toContain('replying "Install"');
    expectUnused(mocks.download, mocks.installArchive);
  });

  it.each([
    { mode: "install", confirmOnUpdate: false, scanStatus: "not-run", reasons: [] },
    {
      mode: "update",
      confirmOnUpdate: true,
      scanStatus: "suspicious",
      reasons: ["payload_strings"],
    },
  ] as const)(
    "cancels $mode before download when confirmation is declined",
    async ({ mode, confirmOnUpdate, scanStatus, reasons }) => {
      communityPackage();
      mockSecurity({ scanStatus, reasons });
      const confirmInstall = vi.fn(async () => false);
      const logger = createLoggerSpies();

      const result = await installDemo({
        baseUrl: "https://clawhub.ai",
        logger,
        confirmInstall,
        mode,
        confirmOnUpdate,
      });

      const failure = expectInstallFailure(result);
      expect(failure.error).toBe("Install cancelled.");
      expect(confirmInstall).toHaveBeenCalledOnce();
      expect(confirmInstall).toHaveBeenCalledWith(expect.stringContaining("Outcome: Review"));
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Outcome: Review"));
      expect(mocks.download).not.toHaveBeenCalled();
    },
  );

  it("sanitizes ClawHub security identity mismatch labels before returning errors", async () => {
    communityPackage();
    mockSecurity({}, "2026.3.21\nrewritten\u001b[2K");
    const result = await installDemo({ baseUrl: "https://clawhub.ai" });
    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(errors.CLAWHUB_SECURITY_UNAVAILABLE);
    expect(failure.error).toContain('returned version "2026.3.21\\nrewritten"');
    expect(failure.error).not.toContain("\n");
    expect(failure.error).not.toContain("\u001b");
    expectUnused(mocks.download, mocks.installArchive);
  });

  it("continues after printing a risky ClawHub release as Review", async () => {
    communityPackage();
    const logger = { ...createLoggerSpies(), terminalLinks: true };
    const confirmInstall = vi.fn(async () => false);
    mockSecurity(
      { scanStatus: "suspicious", reasons: ["payload_strings"] },
      "2026.3.22",
      "Audit summary\u001b[2K\nReview this line.",
    );
    const result = await installDemo({
      baseUrl: "https://clawhub.ai",
      logger,
      mode: "update",
      confirmInstall,
    });

    expectSuccessfulClawHubInstall(result, { clawhubChannel: "community" });
    expect(confirmInstall).not.toHaveBeenCalled();
    const success = expectInstallSuccess(result);
    expect(success.clawhub).toMatchObject({
      clawhubTrustDisposition: "review-required",
      clawhubTrustScanStatus: "suspicious",
      clawhubTrustCheckedAt: expect.stringMatching(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u,
      ),
    });
    expect(success.warning).toContain("Outcome: Review");
    expect(success.warning).toContain("Audit summary");
    expect(success.warning).toContain("Review this line.");
    expect(success.warning).not.toContain("\u001b");
    expect(success.clawhub?.clawhubTrustReasons).toEqual(["payload_strings"]);
    expect(logger.warn.mock.calls.map(([message]) => message).join("\n")).toContain(
      "https://clawhub.ai/plugins/demo/security-audit?version=2026.3.22",
    );
    expect(mocks.download).toHaveBeenCalled();
  });

  it.each([
    {
      kind: "npm-pack",
      artifact: { kind: "npm-pack", sha256: DEMO_CLAWPACK_SHA256, ...npmProvenance, size: 4096 },
      download: npmDownload,
      expected: {
        artifactKind: "npm-pack",
        artifactFormat: "tgz",
        ...npmProvenance,
        clawpackSha256: DEMO_CLAWPACK_SHA256,
        clawpackSize: 4096,
      },
      downloadKind: "clawpack",
    },
    {
      kind: "legacy-zip",
      artifact: { kind: "legacy-zip", sha256: DEMO_ARCHIVE_SHA256 },
      download: { archivePath: "/tmp/clawhub-demo/archive.zip", integrity: DEMO_ARCHIVE_INTEGRITY },
      expected: {
        artifactKind: "legacy-zip",
        artifactFormat: "zip",
        integrity: DEMO_ARCHIVE_INTEGRITY,
      },
      downloadKind: "archive",
    },
  ])(
    "accepts the live ClawHub $kind resolver shape",
    async ({ artifact, download, expected, downloadKind }) => {
      mocks.fetchArtifact.mockResolvedValueOnce({
        package: { name: "demo", displayName: "Demo", family: "code-plugin" },
        version: "2026.3.22",
        artifact,
      });
      mocks.download.mockResolvedValueOnce({
        ...download,
        cleanup: mocks.cleanup,
      });
      const result = await installDemo({ baseUrl: "https://clawhub.ai" });
      const success = expectInstallSuccess(result);
      expect(success.pluginId).toBe("demo");
      expect(success.clawhub).toMatchObject(expected);
      expect(mocks.fetchVersion).not.toHaveBeenCalled();
      expect(archiveDownloadCall()).toMatchObject({
        artifact: downloadKind,
        name: "demo",
        version: "2026.3.22",
      });
    },
  );

  it("falls back to version metadata when the ClawHub artifact resolver route is missing", async () => {
    mocks.fetchArtifact.mockRejectedValueOnce(
      new ClawHubRequestError({
        path: "/api/v1/packages/demo/versions/2026.3.22/artifact",
        status: 404,
        body: "Not Found",
      }),
    );
    mockVersion({
      artifact: {
        ...npmArtifact,
        ...npmProvenance,
        size: 4096,
        npmTarballName: "demo-2026.3.22.tgz",
      },
    });
    mocks.download.mockResolvedValueOnce({
      ...npmDownload,
      cleanup: mocks.cleanup,
    });
    const result = await installDemo({ baseUrl: "https://clawhub.ai" });
    const success = expectInstallSuccess(result);
    expect(success.clawhub).toMatchObject({
      npmTarballName: "demo-2026.3.22.tgz",
      artifactKind: "npm-pack",
      npmIntegrity: "sha512-clawpack",
      clawpackSha256: DEMO_CLAWPACK_SHA256,
    });
    expect(packageVersionCall()).toMatchObject({ name: "demo", version: "2026.3.22" });
    expect(archiveDownloadCall()).toMatchObject({
      artifact: "clawpack",
      name: "demo",
      version: "2026.3.22",
    });
  });

  it("rejects ClawPack artifacts when the download digest does not match version metadata", async () => {
    const mismatchedSha256 = "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    mockVersion({ artifact: npmArtifact });
    mocks.download.mockResolvedValueOnce({
      archivePath: "/tmp/clawhub-demo/demo-2026.3.22.tgz",
      integrity: `sha256-${Buffer.from(mismatchedSha256, "hex").toString("base64")}`,
      sha256Hex: mismatchedSha256,
      artifact: "clawpack",
      clawpackHeaderSha256: mismatchedSha256,
      cleanup: mocks.cleanup,
    });
    const result = await installDemo({ baseUrl: "https://clawhub.ai" });
    const failure = expectInstallFailure(result);
    expect(failure.code).toBe(errors.ARCHIVE_INTEGRITY_MISMATCH);
    expect(failure.error).toBe(
      `ClawHub ClawPack integrity mismatch for "demo@2026.3.22": expected ${DEMO_CLAWPACK_SHA256}, got ${mismatchedSha256}.`,
    );
    expect(mocks.installArchive).not.toHaveBeenCalled();
    expect(mocks.cleanup).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      status: 404,
      body: "Not Found",
      code: errors.ARTIFACT_DOWNLOAD_UNAVAILABLE,
      version: undefined,
      error:
        'ClawHub artifact download for "demo@2026.3.22" is not available yet (ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (404): Not Found). Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    },
    {
      status: 403,
      body: "Blocked: this package release has been flagged as malicious and cannot be downloaded.",
      code: errors.CLAWHUB_DOWNLOAD_BLOCKED,
      version: "2026.3.22",
      error:
        'ClawHub blocked artifact download for "demo@2026.3.22"; install was not started. ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (403): Blocked: this package release has been flagged as malicious and cannot be downloaded.',
    },
    {
      status: 403,
      body: "Forbidden.",
      code: errors.ARTIFACT_UNAVAILABLE,
      version: undefined,
      error:
        'ClawHub artifact download for "demo@2026.3.22" is not available yet (ClawHub /api/v1/packages/demo/versions/2026.3.22/artifact/download failed (403): Forbidden.). Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    },
  ])(
    "maps artifact download $status/$body to $code",
    async ({ status, body, code, version, error }) => {
      mockVersion({ artifact: npmArtifact });
      mocks.download.mockRejectedValueOnce(
        new ClawHubRequestError({
          path: "/api/v1/packages/demo/versions/2026.3.22/artifact/download",
          status,
          body,
        }),
      );
      const result = await installDemo({ baseUrl: "https://clawhub.ai" });
      expectInstallFailureFields(result, code, error);
      expect(expectInstallFailure(result).version).toBe(version);
      expect(archiveDownloadCall().artifact).toBe("clawpack");
      expect(mocks.installArchive).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["pinned older", "2026.6.8", "2026.6.8", "absent", undefined],
    ["pinned recovery", "2026.6.8", "2026.6.5", "present", "2026.6.8"],
    ["recovery failure", "2026.6.8", "2026.6.8", "error", "500 Internal Server Error"],
    [
      "latest compatibility",
      "2026.6.10",
      "2026.6.8",
      "absent",
      "Upgrade OpenClaw or choose an explicit compatible plugin version.",
    ],
  ] as const)("compatibility: %s", async (_name, version, host, recovery, error) => {
    const pinned = version === "2026.6.8";
    const spec = pinned ? `clawhub:demo@${version}` : "clawhub:demo";
    mocks.parseSpec.mockReturnValueOnce({
      name: "demo",
      version: pinned ? version : undefined,
    });
    mocks.latestVersion.mockReturnValue("2026.6.10");
    mockPackage({
      latestVersion: "2026.6.10",
      compatibility: { pluginApiRange: ">=2026.6.10", minGatewayVersion: "2026.6.10" },
      artifact: { ...npmArtifact, size: 4096 },
    });
    mocks.hostVersion.mockReturnValue(host);
    mocks.fetchArtifact.mockResolvedValueOnce({
      version: { version, sha256hash: DEMO_ARCHIVE_SHA256 },
    });
    if (recovery === "error") {
      mocks.fetchVersion.mockRejectedValueOnce(new Error("500 Internal Server Error"));
    } else {
      mockVersion({
        version,
        sha256hash: DEMO_ARCHIVE_SHA256,
        compatibility:
          recovery === "present"
            ? { pluginApiRange: ">=2026.6.8", minGatewayVersion: "2026.6.8" }
            : undefined,
      });
    }
    const result = await installPluginFromClawHub({ spec, baseUrl: "https://clawhub.ai" });
    if (error) {
      expect(expectInstallFailure(result).error).toContain(error);
      expect(mocks.download).not.toHaveBeenCalled();
    } else {
      expectSuccessfulClawHubInstall(result);
      const success = expectInstallSuccess(result);
      expect(success.clawhub?.clawpackSha256).toBeUndefined();
      expect(success.clawhub?.clawpackSpecVersion).toBeUndefined();
      expect(success.clawhub?.clawpackManifestSha256).toBeUndefined();
      expect(success.clawhub?.clawpackSize).toBeUndefined();
    }
  });

  it.each([
    ["beta API floor", "2026.5.27-beta.1", "2026.5.27", ">=2026.5.27", "2026.3.0"],
    ["prerelease minimum", "2026.8.1", "1.0.0-beta.3", ">=2026.7.2-beta.2", "2026.7.2-beta.2"],
  ] as const)(
    "installs with %s",
    async (_name, host, version, pluginApiRange, minGatewayVersion) => {
      mocks.hostVersion.mockReturnValueOnce(host);
      mockVersion({
        version,
        sha256hash: DEMO_ARCHIVE_SHA256,
        compatibility: { pluginApiRange, minGatewayVersion },
      });
      const result = await installDemo({ baseUrl: "https://clawhub.ai" });

      expectSuccessfulClawHubInstall(result);
      expect(mocks.download).toHaveBeenCalledTimes(1);
      expect(mocks.installArchive).toHaveBeenCalledTimes(1);
      expect(archiveInstallCall().archivePath).toBe("/tmp/clawhub-demo/archive.zip");
      expect(mocks.cleanup).toHaveBeenCalledTimes(1);
    },
  );

  it("validates _meta.json against canonical package and resolved version metadata", async () => {
    mocks.parseSpec.mockReturnValueOnce({ name: "DemoAlias", version: "latest" });
    mockPackage({ tags: { latest: "2026.3.22" } });
    await mockArchive({
      entries: {
        "openclaw.plugin.json": '{"id":"demo"}',
        "_meta.json": '{"slug":"demo","version":"2026.3.22"}',
      },
      version: { sha256hash: null },
    });
    const logger = createLoggerSpies();
    const result = await installPluginFromClawHub({
      spec: "clawhub:DemoAlias@latest",
      logger,
    });
    const success = expectInstallSuccess(result);
    expect(success).toMatchObject({ pluginId: "demo", version: "2026.3.22" });
    expect(packageDetailCall().name).toBe("DemoAlias");
    expect(packageVersionCall()).toMatchObject({ name: "demo", version: "2026.3.22" });
    expect(mocks.fetchSecurity).not.toHaveBeenCalled();
    expect(archiveInstallCall().trustedSourceLinkedOfficialInstall).toBe(true);
    expect(archiveInstallCall().installPolicyRequest?.source?.authority).toBe("official");
    expect(archiveDownloadCall().name).toBe("demo");
    expect(success).toMatchObject({ packageName: "demo", clawhub: { clawhubPackage: "demo" } });
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: openclaw.plugin.json. Validated generated metadata files present in archive: _meta.json (JSON parse plus slug/version match only).',
    );
  });

  it.each([
    [
      "unrecognized sha256hash",
      { sha256hash: "definitely-not-a-sha256", files: [manifestFile] },
      'has an invalid sha256hash (unrecognized value "definitely-not-a-sha256").',
    ],
    [
      "non-string sha256hash",
      { sha256hash: 123 },
      "has an invalid sha256hash (non-string value of type number).",
    ],
    [
      "malformed files entry",
      { files: [null] },
      "has an invalid files[0] entry (expected an object, got null).",
    ],
    [
      "invalid file digest",
      { files: [{ path: "openclaw.plugin.json", size: 13, sha256: "not-a-digest" }] },
      'has an invalid files[0].sha256 (value "not-a-digest" is not a 64-character hexadecimal SHA-256 digest).',
    ],
    [
      "unsafe file path",
      { files: [{ path: "../evil.txt", size: 4, sha256: "1".repeat(64) }] },
      'has an invalid files[0].path (path "../evil.txt" contains dot segments).',
    ],
    [
      "path whitespace",
      { files: [{ ...manifestFile, path: "openclaw.plugin.json " }] },
      'has an invalid files[0].path (path "openclaw.plugin.json " has leading or trailing whitespace).',
    ],
    [
      "duplicate file path",
      { files: [manifestFile, manifestFile] },
      'has duplicate files[] path "openclaw.plugin.json".',
    ],
    [
      "generated metadata in file list",
      {
        files: [
          {
            ...clawHubArchiveFile("_meta.json", '{"slug":"demo","version":"2026.3.22"}'),
            size: 64,
          },
        ],
      },
      'must not include generated file "_meta.json" in files[].',
    ],
  ] as const)("rejects metadata: %s", async (_name, metadata, issue) => {
    mockVersion(metadata);
    const result = await installDemo();
    expectInstallFailureFields(
      result,
      errors.MISSING_ARCHIVE_INTEGRITY,
      `ClawHub version metadata for "demo@2026.3.22" ${issue}`,
    );
    expect(mocks.download).not.toHaveBeenCalled();
  });

  it("keeps extraction failures typed and prevents install work after a corrupt ZIP payload", async () => {
    const archive = await mockArchive();
    const bytes = await fs.readFile(archive.archivePath);
    const payloadOffset = 30 + bytes.readUInt16LE(26) + bytes.readUInt16LE(28);
    bytes[payloadOffset] = bytes[payloadOffset]! ^ 1;
    await fs.writeFile(archive.archivePath, bytes);
    const archiveApi = await import("../infra/archive.js");
    const extraction = vi.spyOn(archiveApi, "extractArchive");
    try {
      const result = await installDemo();
      expectArchiveFailure(
        result,
        "ClawHub archive fallback verification failed while reading the downloaded archive.",
      );
      expect(extraction).toHaveBeenCalledOnce();
      expect(mocks.cleanup).toHaveBeenCalledOnce();
    } finally {
      extraction.mockRestore();
    }
  });

  it.each([
    {
      kind: "symlink",
      names: ["extra.txt"],
      mode: 0o120777,
      error:
        "ClawHub archive fallback verification rejected the downloaded archive: zip entry is a link: extra.txt",
    },
    {
      kind: "other",
      names: ["extra.txt"],
      mode: 0o160644,
      error:
        'ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": unexpected file "extra.txt".',
    },
    {
      kind: "case collision",
      names: ["README.md", "readme.md"],
      mode: undefined,
      error: expect.stringContaining(
        "ClawHub archive fallback verification rejected the downloaded archive: archive entries collide at output path",
      ),
    },
    {
      kind: "Unicode normalization collision",
      names: ["caf\u00e9.md", "cafe\u0301.md"],
      mode: undefined,
      error: expect.stringContaining(
        "ClawHub archive fallback verification rejected the downloaded archive: archive entries collide at output path",
      ),
    },
  ])(
    "explains portable ZIP $kind rejection before install work",
    async ({ names, mode, error }) => {
      const archive = await mockArchive({
        entries: {
          "openclaw.plugin.json": '{"id":"demo"}',
          ...Object.fromEntries(names.map((name) => [name, "unsupported"])),
        },
        files: [manifestFile],
      });
      if (mode !== undefined) {
        await setClawHubArchiveEntryMode(archive.archivePath, "extra.txt", mode);
      }
      const { configureFsSafeNative, getFsSafeNativeConfig } =
        await import("@openclaw/fs-safe/config");
      const previous = getFsSafeNativeConfig();
      configureFsSafeNative({ mode: "off" });
      try {
        const result = await installDemo();
        expectArchiveFailure(result, error);
        expect(mocks.cleanup).toHaveBeenCalledOnce();
      } finally {
        configureFsSafeNative(previous);
      }
    },
  );

  it.each<[string, Record<string, string>, readonly ClawHubArchiveFile[], string]>([
    [
      "invalid generated JSON",
      { "_meta.json": "{not-json" },
      [manifestFile],
      "_meta.json is not valid JSON.",
    ],
    [
      "generated slug mismatch",
      { "_meta.json": '{"slug":"wrong","version":"2026.3.22"}' },
      [manifestFile],
      "_meta.json slug does not match the package name.",
    ],
    [
      "missing expected file",
      {},
      [manifestFile, clawHubArchiveFile("dist/index.js", 'export const demo = "ok";')],
      'missing "dist/index.js".',
    ],
    [
      "undeclared canonical extracted name",
      { "nested\\extra.txt": "unexpected" },
      [manifestFile],
      'unexpected file "nested/extra.txt".',
    ],
  ])("rejects fallback inventory: %s", async (_name, entries, files, error) => {
    await mockArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}', ...entries },
      files,
    });
    const result = await installDemo();
    expectArchiveFailure(
      result,
      `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": ${error}`,
    );
  });

  it.each([
    ["per-file", false, "ClawHub archive fallback verification exceeded the per-file size limit."],
    [
      "entry count",
      true,
      "ClawHub archive fallback verification exceeded the archive entry limit.",
    ],
    [
      "ZIP size",
      false,
      "ClawHub archive fallback verification rejected the downloaded archive because it exceeds the ZIP archive size limit.",
    ],
  ] as const)(
    "rejects fallback archives exceeding the %s limit",
    async (limit, beforeParse, error) => {
      const { archivePath } = await mockArchive({
        entries: {
          ...(limit === "per-file"
            ? { "_meta.json": '{"slug":"demo","version":"2026.3.22"}' }
            : {}),
          "openclaw.plugin.json": '{"id":"demo"}',
        },
      });
      if (limit === "per-file") {
        const archiveBytes = await fs.readFile(archivePath);
        const centralDirectoryOffset = archiveBytes.readUInt32LE(archiveBytes.length - 6);
        // Keep _meta.json's size declarations consistent to reach admission without allocating 256 MiB.
        const oversizedBytes = 256 * 1024 * 1024 + 1;
        archiveBytes.writeUInt32LE(oversizedBytes, 22);
        archiveBytes.writeUInt32LE(oversizedBytes, centralDirectoryOffset + 24);
        await fs.writeFile(archivePath, archiveBytes);
      } else if (beforeParse) {
        await fs.writeFile(
          archivePath,
          createZipCentralDirectoryArchive({
            actualEntryCount: 50_001,
            declaredEntryCount: 1,
            entryType: "directory",
          }),
        );
      } else {
        await fs.truncate(archivePath, 256 * 1024 * 1024 + 1);
      }
      const loadAsyncSpy = beforeParse ? vi.spyOn(JSZip.prototype, "loadAsync") : undefined;
      try {
        const result = await installDemo();
        expectArchiveFailure(result, error);
        if (loadAsyncSpy) {
          expect(loadAsyncSpy).not.toHaveBeenCalled();
        }
      } finally {
        loadAsyncSpy?.mockRestore();
      }
    },
  );

  it("rejects fallback verification when a file hash drifts from files[] metadata", async () => {
    const archive = await mockArchive({
      files: [{ path: "openclaw.plugin.json", size: 13, sha256: "1".repeat(64) }],
    });
    const { installPluginFromArchive } = await import("./install-package.js");
    mocks.installArchive.mockImplementationOnce(installPluginFromArchive);
    const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
    const beforePersistentApply = vi.fn();
    const onBeforePluginArtifactCommit = vi.fn();
    const result = await installDemo({
      extensionsDir,
      beforePersistentApply,
      onBeforePluginArtifactCommit,
    });

    expectArchiveFailure(
      result,
      `ClawHub archive contents do not match files[] metadata for "demo@2026.3.22": expected openclaw.plugin.json to hash to ${"1".repeat(64)}, got ${sha256Hex('{"id":"demo"}')}.`,
    );
    expectUnused(beforePersistentApply, onBeforePluginArtifactCommit);
    await expect(fs.stat(extensionsDir)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects archive path traversal before install work", async () => {
    await mockArchive({
      entries: { "openclaw.plugin.json": '{"id":"demo"}', "../extra.txt": "unsafe" },
      files: [manifestFile],
    });
    const result = await installDemo();
    expectArchiveFailure(
      result,
      expect.stringMatching(
        /^ClawHub archive fallback verification rejected the downloaded archive: archive entry /,
      ),
    );
  });

  it("verifies the canonical installed inventory and ignores inert root records", async () => {
    const entries = { ...DEMO_PLUGIN_ARCHIVE_ENTRIES, "nested\\extra.txt": "verified" };
    const archive = await mockArchive({
      entries: { ...entries, ".": "ignored" },
      files: Object.entries(entries).map(([name, contents]) =>
        clawHubArchiveFile(name.replaceAll("\\", "/"), contents),
      ),
    });
    await setClawHubArchiveEntryMode(archive.archivePath, ".", 0o120777);
    const { installPluginFromArchive } = await import("./install-package.js");
    mocks.installArchive.mockImplementationOnce(installPluginFromArchive);
    const extensionsDir = path.join(path.dirname(archive.archivePath), "extensions");
    const logger = createLoggerSpies();
    const result = await installDemo({
      extensionsDir,
      expectedIntegrity: archive.integrity,
      logger,
    });
    expect(result, JSON.stringify(result)).toMatchObject({ ok: true });
    expect(await fs.readFile(path.join(extensionsDir, "demo", "nested/extra.txt"), "utf8")).toBe(
      "verified",
    );
    expect(await fs.readFile(path.join(extensionsDir, "demo", "index.js"), "utf8")).toBe(
      DEMO_PLUGIN_ARCHIVE_ENTRIES["index.js"],
    );
    expect(logger.warn).toHaveBeenCalledWith(
      'ClawHub package "demo@2026.3.22" is missing sha256hash; falling back to files[] verification. Validated files: index.js, nested/extra.txt, openclaw.plugin.json, package.json.',
    );
  });

  it.each<{
    metadata?: Record<string, unknown>;
    detail?: Record<string, unknown>;
    host?: string;
    missing?: "package" | "version";
    version?: string;
    spec?: string;
    code: (typeof errors)[keyof typeof errors];
    error: string;
  }>([
    {
      metadata: {
        compatibility: { pluginApiRange: ">=2026.3.22", minGatewayVersion: "not-semver" },
      },
      code: errors.INVALID_GATEWAY_VERSION,
      error:
        'ClawHub package "demo" declares invalid minGatewayVersion metadata "not-semver"; report the package metadata to its publisher.',
    },
    {
      host: "invalid",
      metadata: {
        sha256hash: DEMO_ARCHIVE_SHA256,
        compatibility: { pluginApiRange: "*", minGatewayVersion: "2026.3.0" },
      },
      code: errors.INCOMPATIBLE_PLUGIN_API,
      error:
        'Plugin "demo" requires plugin API *, but this OpenClaw runtime exposes invalid. Upgrade OpenClaw or choose an explicit compatible plugin version.',
    },
    {
      metadata: { sha256hash: null },
      code: errors.ARTIFACT_UNAVAILABLE,
      error:
        'ClawHub package "demo@2026.3.22" does not expose a downloadable plugin artifact yet. Use "npm:demo@2026.3.22" for launch installs while ClawHub artifact routing is being rolled out.',
    },
    {
      host: "unknown",
      metadata: { compatibility: { minGatewayVersion: "2026.3.22" } },
      code: errors.UNKNOWN_GATEWAY_VERSION,
      error:
        'Plugin "demo" requires OpenClaw >=2026.3.22, but this host version could not be determined. Re-run from a released build or set OPENCLAW_VERSION and retry.',
    },
    {
      spec: "clawhub:calendar",
      detail: {
        name: "calendar",
        displayName: "Calendar",
        family: "skill",
        ownerHandle: "openclaw",
        compatibility: undefined,
      },
      metadata: { compatibility: undefined },
      code: errors.SKILL_PACKAGE,
      error: '"calendar" is a skill. Use "openclaw skills install @openclaw/calendar" instead.',
    },
    { missing: "package", code: errors.PACKAGE_NOT_FOUND, error: "Package not found on ClawHub." },
    {
      missing: "version",
      version: "9.9.9",
      spec: "clawhub:demo@9.9.9",
      code: errors.VERSION_NOT_FOUND,
      error: "Version not found on ClawHub: demo@9.9.9.",
    },
  ])(
    "returns $code: $error",
    async ({ metadata, detail, host, missing, version, spec = "clawhub:demo", code, error }) => {
      if (metadata) {
        mockVersion(metadata);
      }
      if (detail) {
        mockPackage(detail);
      }
      if (host) {
        mocks.hostVersion.mockReturnValueOnce(host);
      }
      if (version) {
        mocks.parseSpec.mockReturnValueOnce({ name: "demo", version });
      }
      if (missing) {
        const versionMissing = missing === "version";
        const failure = new ClawHubRequestError({
          path: "/api/v1/packages/demo" + (versionMissing ? "/versions/" + version : ""),
          status: 404,
          body: versionMissing ? "Version not found" : "Package not found",
        });
        (versionMissing ? mocks.fetchVersion : mocks.fetchDetail).mockRejectedValueOnce(failure);
      }
      const result = await installDemo({ spec });
      expectInstallFailureFields(result, code, error);
      expectUnused(mocks.download, mocks.installArchive, mocks.cleanup);
    },
  );
});
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
