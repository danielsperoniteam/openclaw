import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core/expect";
import { asNonArrayRecord } from "@openclaw/normalization-core/record-coerce";
import { afterEach, describe, expect, it } from "vitest";
import { GATEWAY_CLIENT_CAPS } from "../../packages/gateway-protocol/src/client-info.js";
import { buildCommandExecApprovalDefaults } from "../auto-reply/reply/commands-private-route.js";
import { buildCommandTestParams } from "../auto-reply/reply/commands.test-harness.js";
import { clearConfigCache, clearRuntimeConfigSnapshot } from "../config/config.js";
import { clearSessionStoreCacheForTest } from "../config/sessions/store-writer-state.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { ADMIN_SCOPE, APPROVALS_SCOPE } from "../gateway/method-scopes.js";
import { startGatewayServer } from "../gateway/server.js";
import { connectGatewayClient, disconnectGatewayClient } from "../gateway/test-helpers.e2e.js";
import { GATEWAY_STARTUP_MUTATED_ENV_KEYS } from "../gateway/test-helpers.env.js";
import {
  acquireGatewayE2ePortBlock,
  startClaimedGateway,
} from "../gateway/test-helpers.listener.js";
import { loadOrCreateDeviceIdentity } from "../infra/device-identity.js";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { captureEnv, setTestEnvValue } from "../test-utils/env.js";
import { GATEWAY_CLIENT_MODES, GATEWAY_CLIENT_NAMES } from "../utils/message-channel.js";
import { withTimeout } from "../utils/with-timeout.js";
import { createOpenClawCodingTools } from "./agent-tools.js";
import { getFinishedSession } from "./bash-process-registry.js";
import { resetProcessRegistryForTests } from "./bash-process-registry.test-support.js";
import type { ExecApprovalFollowupOutcome } from "./bash-tools.exec-types.js";
import { createExecTool } from "./bash-tools.js";

const SKIP_ENV_KEYS = [
  "OPENCLAW_SKIP_CHANNELS",
  "OPENCLAW_SKIP_GMAIL_WATCHER",
  "OPENCLAW_SKIP_CRON",
  "OPENCLAW_SKIP_CANVAS_HOST",
  "OPENCLAW_SKIP_BROWSER_CONTROL_SERVER",
  "OPENCLAW_SKIP_PROVIDERS",
  "OPENCLAW_TEST_MINIMAL_GATEWAY",
];
const TEST_ENV_KEYS = [
  "HOME",
  ...GATEWAY_STARTUP_MUTATED_ENV_KEYS,
  "OPENCLAW_STATE_DIR",
  "OPENCLAW_CONFIG_PATH",
  "OPENCLAW_GATEWAY_TOKEN",
  ...SKIP_ENV_KEYS,
];
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

describe("gateway-hosted exec approvals", () => {
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
      const envSnapshot = captureEnv(TEST_ENV_KEYS);
      cleanup.push(() => envSnapshot.restore());

      const tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-exec-approval-e2e-"));
      cleanup.push(() => fs.rm(tempHome, { recursive: true, force: true, maxRetries: 5 }));

      const stateDir = path.join(tempHome, ".openclaw");
      const workspaceDir = path.join(tempHome, "workspace");
      await fs.mkdir(workspaceDir, { recursive: true });

      const token = "exec-approval-e2e-token";
      const configPath = path.join(stateDir, "openclaw.json");
      await fs.mkdir(stateDir, { recursive: true });
      const claim = await acquireGatewayE2ePortBlock();
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
        await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

        setTestEnvValue("HOME", tempHome);
        setTestEnvValue("OPENCLAW_STATE_DIR", stateDir);
        setTestEnvValue("OPENCLAW_CONFIG_PATH", configPath);
        setTestEnvValue("OPENCLAW_GATEWAY_TOKEN", token);
        setTestEnvValue("OPENCLAW_GATEWAY_PORT", String(claim.port));
        for (const key of SKIP_ENV_KEYS) {
          setTestEnvValue(key, "1");
        }
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
        clientDisplayName: string,
        scopes: string[],
        deviceIdentity?: ReturnType<typeof loadOrCreateDeviceIdentity>,
      ) => {
        const client = await connectGatewayClient({
          url: `ws://127.0.0.1:${claim.port}`,
          token,
          clientName: GATEWAY_CLIENT_NAMES.TEST,
          clientDisplayName,
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
      const operator = await connect("approval operator", [ADMIN_SCOPE]);
      const originReviewerIdentity = identity("origin");
      const originReviewer = await connect(
        "origin approval reviewer",
        [APPROVALS_SCOPE],
        originReviewerIdentity,
      );
      const otherReviewer = await connect(
        "other approval reviewer",
        [APPROVALS_SCOPE],
        identity("other"),
      );
      const resolveApproval = (
        client: typeof operator,
        id: string,
        decision: "deny" | "allow-once",
      ) => client.request("exec.approval.resolve", { id, decision }, { timeoutMs: 10_000 });

      let resolveOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
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
            resolveOutcome(outcome);
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

      const allowedOutcomePromise = new Promise<ExecApprovalFollowupOutcome>((resolve) => {
        resolveOutcome = resolve;
      });

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

      const outcome = await withTimeout(allowedOutcomePromise, 15_000, {
        message: "timed out waiting for approved exec outcome",
      });
      expect(outcome).toMatchObject({ status: "completed", exitCode: 0, aggregated: "smoke" });
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
      let resolveRoutedOutcome: (outcome: ExecApprovalFollowupOutcome) => void = () => {};
      const routedOutcomePromise = new Promise<ExecApprovalFollowupOutcome>((resolve) => {
        resolveRoutedOutcome = resolve;
      });
      const routedTool = createExecTool({
        host: "gateway",
        security: "allowlist",
        ask: "always",
        allowBackground: true,
        approvalRunningNoticeMs: 0,
        approvalFollowupMode: "direct",
        approvalFollowup: ({ outcome: routedOutcome }) => {
          resolveRoutedOutcome(routedOutcome);
          return undefined;
        },
        cwd: workspaceDir,
        agentId: "main",
        sessionKey: "agent:main:main",
        messageProvider: approvalDefaults.messageProvider,
        currentChannelId: approvalDefaults.currentChannelId,
        currentThreadTs: approvalDefaults.currentThreadTs,
        accountId: approvalDefaults.accountId,
        approvalReviewerDeviceId: approvalDefaults.approvalReviewerDeviceId,
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

      const routedOutcome = await withTimeout(routedOutcomePromise, 15_000, {
        message: "timed out waiting for device-bound exec outcome",
      });
      expect(routedOutcome).toMatchObject({
        status: "completed",
        exitCode: 0,
        aggregated: "device-bound-smoke",
      });
    },
    EXEC_APPROVAL_E2E_TIMEOUT_MS,
  );
});
