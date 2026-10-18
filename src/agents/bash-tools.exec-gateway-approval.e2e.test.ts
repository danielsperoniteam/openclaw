import fs from "node:fs/promises";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { createDeferred } from "../../test/helpers/promise.js";
import { buildCommandExecApprovalDefaults } from "../auto-reply/reply/commands-private-route.js";
import { buildCommandTestParams } from "../auto-reply/reply/commands.test-harness.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../gateway/test-helpers.e2e.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../gateway/test-helpers.listener.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { createOpenClawTestState } from "../test-utils/openclaw-test-state.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withTimeout } from "../utils/with-timeout.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { getFinishedSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { ExecApprovalFollowupOutcome } from "./bash-tools.exec-types.js";
import { createExecTool } from "./bash-tools.js";
import { expectCompleted } from "./bash-tools.lifecycle.test-support.js";

const GATEWAY_CONNECT_TIMEOUT_MS = 120_000;
const EXEC_APPROVAL_E2E_TIMEOUT_MS = 180_000;

type Cleanup = () => Promise<void> | void;

function requireApprovalId(details: unknown): string {
  const record = asNonArrayRecord(details);
  if (record?.status !== "approval-pending" || typeof record.approvalId !== "string") {
    throw new Error("expected approval-pending exec result");
  }
  return record.approvalId;
}

const cleanup: Cleanup[] = [];

afterEach(async () => {
  for (const step of cleanup.splice(0).toReversed()) {
    await step();
  }
  clearRuntimeConfigSnapshot();
  clearConfigCache();
  clearSessionStoreCacheForTest();
  resetProcessRegistryForTests();
});

it(
  "keeps a scheduled approval floor in a reused full-permission session",
  async () => {
    const token = "exec-approval-e2e-token";
    const state = await createOpenClawTestState({
      label: "exec-approval-e2e",
      applyEnv: false,
      env: {
        OPENCLAW_GATEWAY_TOKEN: token,
        OPENCLAW_SKIP_CHANNELS: "1",
        OPENCLAW_SKIP_GMAIL_WATCHER: "1",
        OPENCLAW_SKIP_CRON: "1",
        OPENCLAW_SKIP_CANVAS_HOST: "1",
        OPENCLAW_SKIP_BROWSER_CONTROL_SERVER: "1",
        OPENCLAW_SKIP_PROVIDERS: "1",
        OPENCLAW_TEST_MINIMAL_GATEWAY: "1",
      },
    });
    cleanup.push(() => state.cleanup());
    const { stateDir, workspaceDir } = state;
    const claim = await acquireGatewayE2ePortBlock();
    state.envVars.OPENCLAW_GATEWAY_PORT = String(claim.port);
    const config = {
      agents: {
        ownership: "explicit",
        defaults: { workspace: workspaceDir },
        entries: {
          main: { tools: { exec: { cleanupMs: 180_000 } } },
          helper: {},
        },
      },
      gateway: {
        port: claim.port,
        auth: { mode: "token", token },
      },
      tools: { exec: { host: "gateway", security: "full", ask: "off", cleanupMs: 60_000 } },
    } satisfies OpenClawConfig;
    const server = await startClaimedGateway(claim, async () => {
      await state.writeConfig(config);
      state.applyEnv();
      clearRuntimeConfigSnapshot();
      clearConfigCache();
      clearSessionStoreCacheForTest();

      // Shared channel stubs make post-connect health checks load unrelated channel runtimes.
      setActivePluginRegistry(createEmptyPluginRegistry());
      return await startGatewayServer(claim.port, {
        bind: "loopback",
        auth: { mode: "token", token },
        controlUiEnabled: false,
        sidecarStartup: "defer",
      });
    });
    cleanup.push(() => server.close());

    const connect = async (
      scopes: string[],
      deviceIdentity?: ReturnType<typeof loadOrCreateDeviceIdentity>,
    ) => {
      const client = await connectGatewayClient({
        url: `ws://127.0.0.1:${claim.port}`,
        token,
        clientName: GATEWAY_CLIENT_NAMES.TEST,
        mode: GATEWAY_CLIENT_MODES.TEST,
        scopes,
        deviceIdentity,
        caps: [GATEWAY_CLIENT_CAPS.EXEC_APPROVALS],
        requestTimeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
        timeoutMs: GATEWAY_CONNECT_TIMEOUT_MS,
      });
      cleanup.push(() => disconnectGatewayClient(client));
      return client;
    };
    const identity = (name: string) =>
      loadOrCreateDeviceIdentity({
        path: path.join(stateDir, "test-device-identities", `${name}-reviewer.sqlite`),
      });
    const operator = await connect([ADMIN_SCOPE]);
    const originReviewerIdentity = identity("origin");
    const originReviewer = await connect([APPROVALS_SCOPE], originReviewerIdentity);
    const otherReviewer = await connect([APPROVALS_SCOPE], identity("other"));
    const resolveApproval = (
      client: typeof operator,
      id: string,
      decision: "deny" | "allow-once",
    ) => client.request("exec.approval.resolve", { id, decision }, { timeoutMs: 10_000 });

    let completion = createDeferred<ExecApprovalFollowupOutcome>();
    let approvedProcessId: string | undefined;

    const tools = createOpenClawCodingTools({
      agentId: "main",
      workspaceDir,
      cwd: workspaceDir,
      config,
      sessionPermissionPolicy: { root: workspaceDir, mode: "full" },
      scheduledToolPolicy: {
        version: 1,
        mode: "trusted",
        execTarget: { host: "gateway", ask: "always" },
      },
      exec: {
        approvalRunningNoticeMs: 0,
        approvalFollowupMode: "direct",
        approvalFollowup: ({ outcome, sessionId }) => {
          approvedProcessId = sessionId;
          completion.resolve(outcome);
          return undefined;
        },
      },
    });
    const tool = expectDefined(
      tools.find((candidate) => candidate.name === "exec"),
      "scheduled exec tool",
    );

    const markerPath = path.join(workspaceDir, "denied-marker");
    const deniedPending = await tool.execute("exec-approval-e2e-denied", {
      command: `touch ${JSON.stringify(markerPath)}`,
      workdir: workspaceDir,
      timeoutSeconds: 5,
    });
    const deniedApprovalId = requireApprovalId(deniedPending.details);
    await resolveApproval(operator, deniedApprovalId, "deny");
    await expect(fs.stat(markerPath)).rejects.toMatchObject({ code: "ENOENT" });

    completion = createDeferred<ExecApprovalFollowupOutcome>();

    const pending = await tool.execute("exec-approval-e2e", {
      command: "printf 'smoke\\n'",
      workdir: workspaceDir,
      timeoutSeconds: 5,
    });
    const approvalId = requireApprovalId(pending.details);

    const helperTools = createOpenClawCodingTools({ agentId: "helper", config, workspaceDir });
    const helperProcess = expectDefined(
      helperTools.find((candidate) => candidate.name === "process"),
      "helper process tool",
    );
    await helperProcess.execute("helper-process-during-approval", { action: "list" });

    await resolveApproval(operator, approvalId, "allow-once");

    const outcome = await withTimeout(completion.promise, 15_000, {
      message: "timed out waiting for approved exec outcome",
    });
    expectCompleted(outcome, "smoke");
    const finished = expectDefined(
      getFinishedSession(expectDefined(approvedProcessId, "approved process identity")),
      "retained approved process output",
    );
    expect(finished.expiresAt - finished.endedAt).toBe(180_000);

    const approvalDefaults = buildCommandExecApprovalDefaults(
      buildCommandTestParams(
        "/diagnostics",
        config,
        {
          Provider: "webchat",
          Surface: "webchat",
          From: "owner",
          To: "owner",
          ApprovalReviewerDeviceId: originReviewerIdentity.deviceId,
          OriginatingTo: "owner",
        },
        { workspaceDir },
      ),
    );
    const routedCompletion = createDeferred<ExecApprovalFollowupOutcome>();
    const routedTool = createExecTool({
      ...approvalDefaults,
      approvalRunningNoticeMs: 0,
      approvalFollowupMode: "direct",
      approvalFollowup: ({ outcome: routedOutcome }) => routedCompletion.resolve(routedOutcome),
      agentId: "main",
    });
    const routedPending = await routedTool.execute("exec-approval-device-custody", {
      command: "printf 'device-bound-smoke\\n'",
      workdir: workspaceDir,
      background: true,
      timeoutSeconds: 5,
    });
    const routedApprovalId = requireApprovalId(routedPending.details);

    await expect(resolveApproval(otherReviewer, routedApprovalId, "allow-once")).rejects.toThrow(
      "unknown or expired approval id",
    );
    await resolveApproval(originReviewer, routedApprovalId, "allow-once");

    const routedOutcome = await withTimeout(routedCompletion.promise, 15_000, {
      message: "timed out waiting for device-bound exec outcome",
    });
    expectCompleted(routedOutcome, "device-bound-smoke");
  },
  EXEC_APPROVAL_E2E_TIMEOUT_MS,
);
