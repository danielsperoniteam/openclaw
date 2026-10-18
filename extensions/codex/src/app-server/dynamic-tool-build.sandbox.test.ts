import fs from "node:fs/promises";
import path from "node:path";
import "./dynamic-tool-build.test-support.js";
import { expectDefined } from "@openclaw/normalization-core";
import { resolveAgentHarnessBeforePromptBuildResult } from "openclaw/plugin-sdk/agent-harness-runtime";
import {
  createMockPluginRegistry,
  initializeGlobalHookRunner,
  resetGlobalHookRunner,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { createRemoteShellSandboxFsBridge } from "openclaw/plugin-sdk/sandbox";
import { createSandboxTestContext } from "openclaw/plugin-sdk/test-fixtures";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { shouldEnableCodexAppServerNativeToolSurface } from "./dynamic-tool-build.js";
import { createCodexDynamicToolBridge } from "./dynamic-tools.js";
import { setCodexTestToolFactory } from "./host-capability.test-support.js";
import { prepareTestNativeExecutionPolicy } from "./native-execution-policy.test-support.js";

const {
  bindProductionCodexHostCapabilities,
  buildDynamicToolsForTest,
  createCodexRuntimePlanFixture,
  createParams,
  createRuntimeDynamicTool,
  setupDynamicToolBuildFixture,
  cleanupDynamicToolBuildFixture,
} = await import("./dynamic-tool-build.test-support.js");

const hostCapabilityClosers: Array<() => void> = [];
let tempDir: string;
let workspaceDir: string;
let params: ReturnType<typeof createParams>;

beforeEach(async () => {
  tempDir = await setupDynamicToolBuildFixture();
  workspaceDir = path.join(tempDir, "workspace");
  params = createParams(path.join(tempDir, "session.jsonl"), workspaceDir, {
    disableTools: false,
    runtimePlan: createCodexRuntimePlanFixture(),
  });
});
afterEach(async () => {
  resetGlobalHookRunner();
  await cleanupDynamicToolBuildFixture(tempDir, hostCapabilityClosers);
});

function mockShellTools() {
  setCodexTestToolFactory(params, () =>
    ["exec", "process", "message"].map(createRuntimeDynamicTool),
  );
}
async function nativeSurface(
  sandbox?: Parameters<typeof shouldEnableCodexAppServerNativeToolSurface>[1],
  sandboxExecServerEnabled = false,
) {
  return shouldEnableCodexAppServerNativeToolSurface(params, sandbox, {
    sandboxExecServerEnabled,
    nativeExecutionPolicy: await prepareTestNativeExecutionPolicy(params, { sandbox }),
  });
}

it("keeps required-root Codex file tools confined without native or shell tools", async () => {
  await fs.mkdir(workspaceDir);
  const outside = path.join(tempDir, "outside.txt");
  await fs.writeFile(outside, "outside");
  await fs.symlink(outside, path.join(workspaceDir, "escape.txt"));

  params.requireWorkspaceOnly = true;
  params.sessionRoot = workspaceDir;

  params.config = { plugins: { enabled: false } };
  params.agentDir = path.join(tempDir, "agent");
  params.toolsAllow = ["read", "write", "edit", "exec", "process"];
  await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);

  expect(await nativeSurface()).toBe(false);
  const tools = await buildDynamicToolsForTest(params, workspaceDir, {
    nativeToolSurfaceEnabled: false,
  });
  expect(tools.map((tool) => tool.name)).toEqual(["read", "edit", "write"]);
  const write = expectDefined(
    tools.find((tool) => tool.name === "write"),
    "rooted write",
  );
  const read = expectDefined(
    tools.find((tool) => tool.name === "read"),
    "rooted read",
  );
  await write.execute("inside", { path: "inside.txt", content: "inside" });
  expect(await fs.readFile(path.join(workspaceDir, "inside.txt"), "utf8")).toBe("inside");
  for (const file of [outside, "../outside.txt", "escape.txt"]) {
    await expect(read.execute("outside-read", { path: file })).rejects.toThrow();
    await expect(
      write.execute("outside-write", { path: file, content: "changed" }),
    ).rejects.toThrow();
  }
  expect(await fs.readFile(outside, "utf8")).toBe("outside");
});

it.each([
  { allow: ["group:runtime"], expected: ["sandbox_exec", "sandbox_process"] },
  { allow: ["exec"], restrictWith: ["process"], expected: ["sandbox_process"] },
])(
  "keeps Docker shell projections pinned for runtime selectors $allow restricted by $restrictWith",
  async ({ allow, restrictWith, expected }) => {
    mockShellTools();
    params.toolsAllow = allow;
    if (restrictWith) {
      initializeGlobalHookRunner(
        createMockPluginRegistry([
          { hookName: "before_prompt_build", handler: () => ({ toolsAllow: allow }) },
          { hookName: "before_prompt_build", handler: () => ({ toolsAllow: restrictWith }) },
        ]),
      );
      const result = await resolveAgentHarnessBeforePromptBuildResult({
        prompt: params.prompt,
        developerInstructions: "",
        messages: [],
        ctx: { agentId: "main", sessionKey: params.sessionKey },
      });
      params.toolsAllow = result.toolsAllow;
    }
    const sandbox = {
      enabled: true,
      backendId: "docker",
      docker: { binds: ["/tmp/openclaw-data:/data:rw"] },
    } as never;
    const nativeToolSurfaceEnabled = await nativeSurface(sandbox);
    expect(nativeToolSurfaceEnabled).toBe(false);
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox,
      nativeToolSurfaceEnabled,
    });

    expect(tools.map((tool) => tool.name)).toEqual(expected);
    expect(tools.map((tool) => tool.catalogMode)).toEqual(
      expected.map((name) => (name === "message" ? undefined : "direct-only")),
    );
    if (expected.includes("sandbox_exec")) {
      expect(tools.find((tool) => tool.name === "sandbox_exec")?.description).toContain(
        "Docker container-path bind layout",
      );
    }
  },
);

it("exposes node shell but not sandbox shell tools when sandbox routing is disabled", async () => {
  mockShellTools();

  const disabledSandboxTools = await buildDynamicToolsForTest(params, workspaceDir, {
    sandbox: { enabled: false, backendId: "ssh" } as never,
    nativeToolSurfaceEnabled: false,
  });

  expect(disabledSandboxTools.map((tool) => tool.name)).toEqual([
    "exec",
    "process",
    "message",
    "node_exec",
  ]);
});

it("preserves completion-only sandbox exec when policy denies process", async () => {
  const backendId = "ssh";

  await fs.mkdir(workspaceDir, { recursive: true });

  params.config = { plugins: { enabled: false } };
  params.agentDir = path.join(tempDir, "agent");
  const buildExecSpec = vi.fn(async () => ({
    // A synthetic backend transport proves dispatch without Docker or SSH access.
    argv: [
      process.execPath,
      "-e",
      'setTimeout(() => process.stdout.write("sandbox execution completed\\n"), 25)',
    ],
    env: {},
    cwd: workspaceDir,
    stdinMode: "pipe-closed" as const,
  }));
  const runShellCommand = vi.fn(async () => {
    throw new Error("Unexpected sandbox filesystem command");
  });
  const sandbox = createSandboxTestContext({
    overrides: {
      backendId,
      workspaceDir,
      agentWorkspaceDir: workspaceDir,
      workspaceAccess: "ro",
      tools: { allow: ["read", "exec"], deny: ["process", "code_execution"] },
      backend: {
        id: backendId,
        runtimeId: "sandbox-exec-only",
        runtimeLabel: "sandbox-exec-only",
        workdir: "/workspace",
        buildExecSpec,
        runShellCommand,
      },
    },
  });
  sandbox.fsBridge = createRemoteShellSandboxFsBridge({
    sandbox,
    runtime: {
      remoteWorkspaceDir: "/workspace",
      remoteAgentWorkspaceDir: "/workspace",
      runRemoteShellScript: runShellCommand,
    },
  });
  await bindProductionCodexHostCapabilities(params, hostCapabilityClosers);
  const nativeToolSurfaceEnabled = await nativeSurface(sandbox, true);
  const tools = await buildDynamicToolsForTest(params, workspaceDir, {
    sandbox,
    nativeToolSurfaceEnabled,
  });

  expect(nativeToolSurfaceEnabled).toBe(false);
  expect(tools.map((tool) => tool.name)).toEqual(["read", "sandbox_exec"]);
  const execTool = expectDefined(
    tools.find((tool) => tool.name === "sandbox_exec"),
    "completion-only sandbox exec",
  );
  expect(execTool.catalogMode).toBe("direct-only");
  expect(execTool.parameters).not.toHaveProperty("properties.background");
  expect(execTool.parameters).not.toHaveProperty("properties.yieldMs");
  const bridge = createCodexDynamicToolBridge({ tools, signal: new AbortController().signal });
  const onAgentToolResult = vi.fn();
  const response = await bridge.handleToolCall(
    {
      threadId: "sandbox-thread",
      turnId: "sandbox-turn",
      callId: "sandbox-exec-only",
      tool: "sandbox_exec",
      arguments: { command: "echo sandbox request", background: true, yieldMs: 1 },
    },
    { onAgentToolResult },
  );

  expect(response).toMatchObject({
    success: true,
    contentItems: [
      { type: "inputText", text: expect.stringContaining("sandbox execution completed") },
    ],
  });
  expect(onAgentToolResult.mock.calls[0]?.[0]).toMatchObject({
    toolName: "sandbox_exec",
    result: { details: { status: "completed" } },
  });
  expect(buildExecSpec).toHaveBeenCalledExactlyOnceWith(
    expect.objectContaining({ command: "echo sandbox request", workdir: "/workspace" }),
  );
});
it("honors Codex dynamic tool excludes for sandbox shell exposure", async () => {
  mockShellTools();

  for (const excludedToolName of ["sandbox_exec", "process"]) {
    const tools = await buildDynamicToolsForTest(params, workspaceDir, {
      sandbox: { enabled: true, backendId: "ssh" } as never,
      nativeToolSurfaceEnabled: false,
      pluginConfig: { codexDynamicToolsExclude: [excludedToolName] },
    });

    expect(tools.map((tool) => tool.name)).toEqual(["message"]);
  }
});
