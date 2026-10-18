import { expect, it, vi, type Mock } from "vitest";
import type { SessionEntry } from "../../config/sessions.js";
import { buildCliMcpGrantContext } from "../cli-runner/mcp-grant-context.js";
import type { RunCliAgentParams } from "../cli-runner/types.js";
import { createAgentAttemptLifecycleCallbacks } from "./attempt-callbacks.js";
import {
  makeCliResult,
  makeSessionEntry,
  type RunAgentAttemptOverrides,
  type RunAgentAttemptParams,
} from "./attempt-execution.cli.test-support.js";
import type { runAgentAttempt } from "./attempt-execution.js";

export function registerCommandCliAdmissionTests({
  runStoredAttempt,
  seedSessionStore,
  runCliAgentMock,
  createCliSession,
  firstRunCliAgentArg,
}: {
  runStoredAttempt: (
    overrides: Omit<RunAgentAttemptOverrides, "agentDir" | "storePath" | "workspaceDir">,
  ) => ReturnType<typeof runAgentAttempt>;
  seedSessionStore: (key: string, entry: SessionEntry) => Promise<Record<string, SessionEntry>>;
  runCliAgentMock: Mock<(params: RunCliAgentParams) => ReturnType<typeof runAgentAttempt>>;
  createCliSession: (
    key: string,
    entry: SessionEntry,
  ) => Promise<{
    runCli: (params: {
      onExecutionStarted?: () => void;
      onAgentEvent?: RunAgentAttemptParams["onAgentEvent"];
    }) => ReturnType<typeof runAgentAttempt>;
  }>;
  firstRunCliAgentArg: () => Record<string, unknown>;
}) {
  it("carries command-origin Git credit into a nonowner CLI grant", async () => {
    const sessionKey = "agent:main:main";
    const sessionEntry = makeSessionEntry("command-cli-git-credit");
    const sessionStore = await seedSessionStore(sessionKey, sessionEntry);
    runCliAgentMock.mockImplementationOnce(async (run: RunCliAgentParams) => {
      const context = buildCliMcpGrantContext({
        run,
        config: {},
        requireExplicitMessageTarget: false,
        agentId: "main",
        modelProvider: "anthropic",
        modelId: "opus",
      });
      expect(context.gitContributorProfileId).toBe("verified-command-requester");
      expect(context.senderIsOwner).toBe(false);
      return makeCliResult("Command completed");
    });

    await runStoredAttempt({
      providerOverride: "claude-cli",
      modelOverride: "opus",
      sessionEntry,
      sessionKey,
      sessionStore,
      opts: { gitContributorProfileId: "verified-command-requester", senderIsOwner: false },
    });
    expect(runCliAgentMock).toHaveBeenCalledOnce();
  });

  it.each(["assistant_output_started"] as const)(
    "keeps CLI admission separate from observed %s",
    async (phase) => {
      const sessionKey = "agent:main:direct:cli-execution-started";
      const sessionEntry = makeSessionEntry("session-cli-execution-started");
      const { runCli } = await createCliSession(sessionKey, sessionEntry);
      const onExecutionStarted = vi.fn();
      const onRuntimeTurnStarted = vi.fn();
      const callbacks = createAgentAttemptLifecycleCallbacks(
        {
          currentTurnUserMessagePersisted: false,
          lifecycleFinishing: false,
          lifecycleEnded: false,
        },
        onRuntimeTurnStarted,
      );
      runCliAgentMock.mockResolvedValueOnce(makeCliResult("started"));

      await runCli({
        onExecutionStarted,
        onAgentEvent: callbacks.onAgentEvent,
      });

      expect(firstRunCliAgentArg().onExecutionStarted).toBe(onExecutionStarted);
      const observePhase = firstRunCliAgentArg().onExecutionPhase;
      if (typeof observePhase !== "function") {
        throw new Error("CLI execution phase observer is missing");
      }
      observePhase({ phase: "process_spawned" });
      expect(onRuntimeTurnStarted).not.toHaveBeenCalled();
      observePhase({ phase });
      expect(onRuntimeTurnStarted).toHaveBeenCalledOnce();
    },
  );
}
