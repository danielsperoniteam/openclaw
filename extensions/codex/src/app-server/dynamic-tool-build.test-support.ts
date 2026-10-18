import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import type { EmbeddedRunAttemptParamsV2 as EmbeddedRunAttemptParams } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  clearRuntimeConfigSnapshot,
  setRuntimeConfigSnapshot,
} from "openclaw/plugin-sdk/runtime-config-snapshot";
import {
  closeOpenClawAgentDatabasesAsync,
  closeOpenClawStateDatabaseAsync,
} from "openclaw/plugin-sdk/sqlite-runtime-testing";
import { vi } from "vitest";
import { buildDynamicTools } from "./dynamic-tool-build.js";
import type { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { createCodexTestHostCapabilities } from "./host-capability.test-support.js";
import { createCodexTestModel } from "./test-support.js";

export { createCodexRuntimePlanFixture } from "./test-support.js";

export const hoisted = vi.hoisted(() => ({
  normalizeAgentRuntimeTools: vi.fn(),
  resolveWebSearchToolPolicy: vi.fn(),
  loadNodeExecAvailability: vi.fn(),
}));

vi.mock("openclaw/plugin-sdk/agent-harness", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness")>();

  return {
    ...actual,
    resolveWebSearchToolPolicy: (...args: Parameters<typeof actual.resolveWebSearchToolPolicy>) => {
      hoisted.resolveWebSearchToolPolicy(...args);
      return actual.resolveWebSearchToolPolicy(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/agent-harness-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("openclaw/plugin-sdk/agent-harness-runtime")>();
  return {
    ...actual,
    normalizeAgentRuntimeTools: (...args: Parameters<typeof actual.normalizeAgentRuntimeTools>) => {
      hoisted.normalizeAgentRuntimeTools(...args);
      return actual.normalizeAgentRuntimeTools(...args);
    },
  };
});

vi.mock("openclaw/plugin-sdk/node-selection-runtime", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("openclaw/plugin-sdk/node-selection-runtime")>();
  return { ...actual, loadNodeExecAvailability: hoisted.loadNodeExecAvailability };
});

export function createParams(
  sessionFile: string,
  workspaceDir: string,
  overrides: Partial<EmbeddedRunAttemptParams> = {},
): EmbeddedRunAttemptParams {
  return {
    hostCapabilities: createCodexTestHostCapabilities(),
    prompt: "hello",
    sessionId: "session-1",
    sessionKey: "agent:main:session-1",
    sessionFile,
    workspaceDir,
    runId: "run-1",
    provider: "codex",
    modelId: "gpt-5.4-codex",
    model: createCodexTestModel("codex"),
    disableTools: true,
    contextTokenBudget: 150_000,
    authProfileStore: { version: 1, profiles: {} },
    ...overrides,
  } as EmbeddedRunAttemptParams;
}

export async function buildDynamicToolsForTest(
  params: EmbeddedRunAttemptParams,
  workspaceDir: string,
  options: Partial<Parameters<typeof buildDynamicTools>[0]> = {},
) {
  const config = params.config ?? {};
  setRuntimeConfigSnapshot(config, config);
  const { permissionMode: mode, sessionRoot: root } = params;
  const execModes = {
    "read-only": "deny",
    guarded: "ask",
    workspace: "auto",
    full: "full",
  } as const;
  const sessionPermissionPolicy =
    mode && root ? { mode, root, execMode: execModes[mode] } : undefined;
  return buildDynamicTools({
    params,
    resolvedWorkspace: workspaceDir,
    effectiveWorkspace: workspaceDir,
    sandboxSessionKey: expectDefined(params.sessionKey, "Codex test session key"),
    sandbox: { enabled: false, backendId: "docker" } as never,
    sessionPermissionPolicy,
    nativeToolSurfaceEnabled: true,
    runAbortController: new AbortController(),
    sessionAgentId: "main",
    policyAgentId: params.sandboxAgentId ?? options.sessionAgentId ?? "main",
    pluginConfig: {},
    onYieldDetected: () => undefined,
    ...options,
  });
}

export async function bindProductionCodexHostCapabilities(
  params: EmbeddedRunAttemptParams,
  hostCapabilityClosers: Array<() => void>,
): Promise<void> {
  const { createAgentHarnessHostCapabilitiesForTest } =
    await import("openclaw/plugin-sdk/plugin-test-runtime");
  const { hostCapabilities: _hostCapabilities, ...attempt } = params;
  const host = await createAgentHarnessHostCapabilitiesForTest({ attempt, pluginId: "codex" });
  params.hostCapabilities = host.capabilities;
  hostCapabilityClosers.push(host.close);
}

export type RuntimeDynamicToolForTest = Parameters<
  typeof createCodexDynamicToolBridge
>[0]["tools"][number];

export function createRuntimeDynamicTool(name: string): RuntimeDynamicToolForTest {
  return {
    name,
    label: name,
    description: `${name} test tool`,
    parameters: { type: "object", properties: {}, additionalProperties: true },
    execute: vi.fn(async () => ({
      content: [{ type: "text" as const, text: `${name} done` }],
      details: {},
    })),
  };
}

export async function setupDynamicToolBuildFixture(): Promise<string> {
  hoisted.loadNodeExecAvailability.mockResolvedValue({
    cacheKey: "eligible",
    isAvailable: () => true,
  });
  hoisted.normalizeAgentRuntimeTools.mockClear();
  hoisted.resolveWebSearchToolPolicy.mockClear();
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-codex-tools-"));
  setRuntimeConfigSnapshot({});
  return tempDir;
}

export async function cleanupDynamicToolBuildFixture(
  tempDir: string,
  hostCapabilityClosers: Array<() => void>,
): Promise<void> {
  try {
    for (const close of hostCapabilityClosers.splice(0)) {
      close();
    }
    vi.restoreAllMocks();
    await closeOpenClawAgentDatabasesAsync();
    await closeOpenClawStateDatabaseAsync();
    vi.unstubAllEnvs();
    await fs.rm(tempDir, { recursive: true, force: true });
  } finally {
    clearRuntimeConfigSnapshot();
  }
}
