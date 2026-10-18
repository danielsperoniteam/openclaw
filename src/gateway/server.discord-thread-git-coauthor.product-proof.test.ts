// Real Discord ingress, registered host admission, native provider/tools, and Git metadata.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createServer } from "node:http";
import path from "node:path";
import { json } from "node:stream/consumers";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { GIT_COAUTHOR_PREFERENCE_KEY } from "../../packages/gateway-protocol/src/schema/user-profile-constants.js";
import { writeOpenAiResponsesText } from "../../test/helpers/openai-responses-sse.js";
import { createDeferred, withTestTimeout } from "../../test/helpers/promise.js";
import { runQaGatewayFixture } from "../../test/helpers/qa-gateway-cleanup.js";
import { shellQuoteArgs } from "../agents/harness/native-hook-relay-utils.js";
import { resolveCommandAuthorization } from "../auto-reply/command-auth.js";
import { getReplyFromConfig } from "../auto-reply/reply/get-reply.js";
import { getRequesterProfile } from "../auto-reply/requester-profile.js";
import { captureRuntimeConfigAsyncReader } from "../config/io.js";
import {
  loadSessionEntryReadOnly,
  upsertSessionEntryCore,
} from "../config/sessions/session-accessor.js";
import { recordSessionParticipant } from "../config/sessions/session-accessor.sqlite-participants.native.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { areHeartbeatsEnabled, setHeartbeatsEnabled } from "../infra/heartbeat-wake.js";
import { getPluginInstance } from "../plugins/plugin-instance-scope.js";
import { getActivePluginChannelRegistry } from "../plugins/runtime.js";
import { linkUserChannelIdentity } from "../state/user-channel-identities.js";
import { prepareUserChannelIdentityAuthority } from "../state/user-channel-identity-operations.js";
import { setUserPreferences } from "../state/user-preferences.test-support.js";
import { setUserProfileRole, syncGitHubIdentity } from "../state/user-profile-writes.worker.js";
import { ensureProfileForEmail } from "../state/user-profiles.js";
import { loadBundledPluginFacade } from "../test-utils/bundled-plugin-public-surface.js";
import { deleteTestEnvValue, setTestEnvValue } from "../test-utils/env.js";
import {
  closeProvider,
  listenProvider,
  writeToolCall,
} from "./gateway-provider-fixture.test-support.js";
import {
  createGatewayConfigPath,
  removeGatewayTempHome,
  resetGatewayTestState,
  setupGatewayTempHome,
} from "./gateway.test-support.js";
import { disconnectGatewayClient, startGatewayWithClient } from "./test-helpers.e2e.js";
import { gatewayReplyMock, dispatchInboundMessageMock } from "./test-helpers.runtime-state.js";
import { buildMockOpenAiResponsesProvider } from "./test-openai-responses-model.js";

const runFile = promisify(execFile);
const MAIN = "agent:main:main";
const THREAD = "100000000000000001";
const PARENT = "100000000000000002";
const GUILD = "100000000000000003";
const SENDER = "100000000000000004";
const WORKER = "DISCORD-CREDIT-WORKER";
const GRANDCHILD = "DISCORD-CREDIT-GRANDCHILD";
const expectedC = "Co-authored-by: requester-c <9101+requester-c@users.noreply.github.com>";
function strings(value: unknown): string[] {
  if (typeof value === "string") {
    return [value];
  }
  if (Array.isArray(value)) {
    return value.flatMap(strings);
  }
  if (value && typeof value === "object") {
    return Object.values(value).flatMap(strings);
  }
  return [];
}

type Receipt = { status: string; childSessionKey: string; runId: string };

it.for(
  [
    { name: "linked nonadmin visible child" },
    { name: "linked nonadmin hidden child", visible: false },
    { name: "unlinked sender without main-roster fallback", linked: false },
    { name: "verified requester opting out", optedOut: true },
    { name: "authorized collaboration in a normal task session", collaborative: true },
    { name: "nested delegation retains only originating task credit", nested: true },
  ].map((scenario, index) => ({
    linked: true,
    collaborative: false,
    visible: true,
    optedOut: false,
    nested: false,
    ...scenario,
    eventId: (100000000000000010n + BigInt(index)).toString(),
  })),
)(
  "generates correct Discord task commit metadata: $name",
  async ({ linked, collaborative, visible, optedOut, nested, eventId }) => {
    const sourceKey = collaborative ? "agent:main:discord:channel:" + THREAD : MAIN;
    const expectedTrailers =
      linked && !optedOut
        ? [
            expectedC,
            ...(collaborative
              ? ["Co-authored-by: collaborator-d <9104+collaborator-d@users.noreply.github.com>"]
              : []),
          ]
        : [];
    resetGatewayTestState();
    const home = await setupGatewayTempHome({ prefix: "openclaw-discord-credit-" });
    // The shared Gateway fixture intentionally defaults this owner to a no-op.
    // Restore production resolution; this observer substitutes no decisions or results.
    const previousReply = gatewayReplyMock.getMockImplementation();
    const previousDispatch = dispatchInboundMessageMock.getMockImplementation();
    gatewayReplyMock.mockImplementation(getReplyFromConfig);
    dispatchInboundMessageMock.mockReset();
    const completed = createDeferred();
    const providerErrors: unknown[] = [];
    const captured: Array<{ child: boolean; grandchild: boolean; trailers: string[] }> = [];
    const commitDir = path.join(home.workspaceDir, "generated-commit");
    let receipt: Receipt | undefined;
    let nestedReceipt: Receipt | undefined;
    let nestedSpawned = false;
    let parentSpawned = false;
    let childExecuted = false;
    let gateway: Awaited<ReturnType<typeof startGatewayWithClient>> | undefined;
    let handler:
      | ReturnType<
          typeof import("../../extensions/discord/runtime-api.js").createDiscordMessageHandler
        >
      | undefined;
    const heartbeats = areHeartbeatsEnabled();
    const realFetch = globalThis.fetch;
    const transportGuard = vi.spyOn(globalThis, "fetch").mockImplementation((input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
        throw new Error("Unexpected non-fixture HTTP transport: " + url.hostname);
      }
      return realFetch(input, init);
    });
    const providerServer = createServer((request, response) => {
      void (async () => {
        const body = (await json(request)) as {
          input?: Array<{ type?: string; role?: string; output?: string }>;
        };
        const allText = strings(body).join("\n");
        const title = allText.includes("Generate a concise session title");
        const userText = strings((body.input ?? []).filter((item) => item.role === "user")).join(
          "\n",
        );
        const grandchild = !title && userText.includes(GRANDCHILD);
        const child = !title && (grandchild || userText.includes(WORKER));
        // The scripted provider consumes the actual product prompt; no expected identity is injected into its tool call.
        const trailers = [...new Set(allText.match(/Co-authored-by: [^\n<]+ <[^>\n]+>/g) ?? [])];
        if (!title) {
          captured.push({ child, grandchild, trailers });
        }
        for (const item of body.input ?? []) {
          if (item.type === "function_call_output" && item.output?.includes("childSessionKey")) {
            if (child) {
              nestedReceipt = JSON.parse(item.output) as Receipt;
            } else {
              receipt = JSON.parse(item.output) as Receipt;
            }
          }
        }
        if (title) {
          writeOpenAiResponsesText(response, {
            text: "Thread credit proof",
            messageId: "title-message",
            responseId: "title-response",
          });
        } else if (child && nested && !grandchild && !nestedSpawned) {
          nestedSpawned = true;
          writeToolCall(response, "sessions_spawn", {
            task: "Create the requested fixture commit. " + GRANDCHILD,
            expectsCompletionMessage: false,
          });
        } else if (child && (!nested || grandchild) && !childExecuted) {
          childExecuted = true;
          const message = [
            "test: generated Discord task commit",
            ...(trailers.length ? ["", ...trailers] : []),
          ].join("\n");
          writeToolCall(response, "exec", {
            command:
              "mkdir -p " +
              shellQuoteArgs([commitDir]) +
              " && git -C " +
              shellQuoteArgs([commitDir]) +
              " init -q && git -C " +
              shellQuoteArgs([commitDir]) +
              " -c user.name=Fixture -c user.email=fixture@example.test commit -q --allow-empty -m " +
              shellQuoteArgs([message]),
            yieldMs: 1000,
          });
        } else if (!child && !parentSpawned) {
          parentSpawned = true;
          writeToolCall(response, "sessions_spawn", {
            task: "Create the requested fixture commit. " + WORKER,
            visible,
            mode: "run",
            expectsCompletionMessage: false,
          });
        } else {
          writeOpenAiResponsesText(response, {
            text: child ? "Fixture commit created." : "NO_REPLY",
            messageId: "reply-message",
            responseId: "reply-response",
          });
          if (child && (!nested || grandchild)) {
            completed.resolve();
          }
        }
      })().catch((error: unknown) => {
        providerErrors.push(error);
        response.writeHead(500).end(String(error));
        completed.reject(error);
      });
    });
    await runQaGatewayFixture(
      async () => {
        setHeartbeatsEnabled(false);
        deleteTestEnvValue("OPENCLAW_DISABLE_BUNDLED_PLUGINS");
        setTestEnvValue("OPENCLAW_BUNDLED_PLUGINS_DIR", path.resolve("extensions"));
        await captureRuntimeConfigAsyncReader()();
        const profiles = [
          { login: "requester-c", id: 9101 },
          { login: "unrelated-a", id: 9102 },
          { login: "unrelated-b", id: 9103 },
          { login: "collaborator-d", id: 9104 },
        ].map(({ login, id }) => {
          const email = login + "@example.test";
          const profile = ensureProfileForEmail(email);
          syncGitHubIdentity({
            identity: { accountId: id, login },
            authenticationAlias: { kind: "email", email },
          });
          setUserProfileRole(profile.id, "member");
          return profile;
        });
        if (optedOut) {
          setUserPreferences(profiles[0]!.id, { [GIT_COAUTHOR_PREFERENCE_KEY]: false });
        }
        if (linked) {
          linkUserChannelIdentity(profiles[0]!.id, {
            channelId: "discord",
            accountId: "default",
            senderId: SENDER,
          });
        }
        await upsertSessionEntryCore(
          { agentId: "main", sessionKey: MAIN },
          { sessionId: "shared-main-credit", updatedAt: Date.now(), systemSent: true },
        );
        for (const profile of profiles.slice(1, 3)) {
          recordSessionParticipant(
            { agentId: "main", sessionKey: MAIN },
            {
              identity: { type: "profile", id: profile.id },
              promptedAt: 1,
              sessionAgentId: "main",
            },
          );
        }
        if (collaborative) {
          await upsertSessionEntryCore(
            { agentId: "main", sessionKey: sourceKey },
            {
              sessionId: "normal-task-source",
              updatedAt: Date.now(),
              systemSent: true,
              inheritedGitContributorProfileIds: [profiles[0]!.id],
            },
          );
          recordSessionParticipant(
            { agentId: "main", sessionKey: sourceKey },
            {
              identity: { type: "profile", id: profiles[3]!.id },
              promptedAt: 1,
              sessionAgentId: "main",
            },
          );
        }
        const provider = buildMockOpenAiResponsesProvider(
          await listenProvider(providerServer),
          "discord-credit",
        );
        const cfg: OpenClawConfig = {
          session: { groupScope: collaborative ? "per-group" : "main" },
          agents: {
            defaults: {
              workspace: home.workspaceDir,
              skipBootstrap: true,
              typingMode: "never",
              heartbeat: { every: "0m" },
              model: { primary: provider.modelRef },
              models: {
                [provider.modelRef]: {
                  agentRuntime: { id: "openclaw" },
                  params: { transport: "sse", openaiWsWarmup: false },
                },
              },
              subagents: { allowAgents: ["*"], maxConcurrent: 3, maxSpawnDepth: 3 },
            },
          },
          models: {
            mode: "replace",
            providers: {
              [provider.providerId]: { ...provider.config, request: { allowPrivateNetwork: true } },
            },
          },
          tools: {
            profile: "coding",
            toolSearch: false,
            exec: { host: "gateway", security: "full", ask: "off" },
          },
          plugins: {
            allow: ["discord"],
            entries: { discord: { enabled: true } },
            slots: { memory: "none" },
          },
          channels: {
            discord: {
              enabled: true,
              token: "synthetic-token",
              groupPolicy: "open",
              guilds: {
                [GUILD]: {
                  users: [SENDER],
                  requireMention: false,
                  channels: { [PARENT]: { includeThreadStarter: false } },
                },
              },
            },
          },
          messages: { ackReaction: "", inbound: { debounceMs: 0 } },
          commands: { ownerAllowFrom: ["discord:100000000000000099"] },
          gateway: {
            auth: { mode: "token", token: "credit-proof" },
            roles: {
              default: "member",
              definitions: {
                member: {
                  scopes: ["operator.read", "operator.write"],
                  agents: "*",
                  sessions: { others: "view" },
                },
              },
            },
          },
          hooks: { enabled: false },
        };
        gateway = await startGatewayWithClient({
          cfg,
          token: "credit-proof",
          configPath: await createGatewayConfigPath(home.tempHome),
        });
        await gateway.server.startupSettled;
        const discord = await loadBundledPluginFacade<
          typeof import("../../extensions/discord/runtime-api.js")
        >({ pluginId: "discord", artifactBasename: "runtime-api.js" });
        const fixture = await loadBundledPluginFacade<
          typeof import("../../extensions/discord/test-api.js")
        >({ pluginId: "discord", artifactBasename: "test-api.js" });
        const channelRegistry = getActivePluginChannelRegistry();
        const registration = channelRegistry?.channels.find(
          (channel) => channel.pluginId === "discord",
        );
        assert(
          registration?.resolveChannelRuntime,
          "Discord must publish its registered host channel runtime",
        );
        const record =
          registration.borrowedRuntimeRecord ??
          channelRegistry?.plugins.find((plugin) => plugin.id === "discord");
        assert(record, "Discord must be registered in the actual Gateway");
        const instance = getPluginInstance(record);
        assert(instance, "Discord registration must own a live plugin instance");
        await instance.run(async () => {
          const resolvedLink = await prepareUserChannelIdentityAuthority({
            channelId: "discord",
            accountId: "default",
            senderId: SENDER,
          });
          expect(resolvedLink?.linked.profileId).toBe(linked ? profiles[0]!.id : undefined);
          const channelRuntime = registration.resolveChannelRuntime();
          const originalBuild = channelRuntime.inbound.buildContext;
          const contextBuilt = createDeferred();
          const admitted: Array<{ key?: string; profile?: string; owner: boolean }> = [];
          const observe = vi
            .spyOn(channelRuntime.inbound, "buildContext")
            .mockImplementation((...args) => {
              const built = originalBuild(...args);
              const observeContext = (ctx: Awaited<typeof built>) => {
                admitted.push({
                  key: ctx.SessionKey,
                  profile: getRequesterProfile(ctx)?.id,
                  owner: resolveCommandAuthorization({ cfg, ctx, commandAuthorized: true })
                    .senderIsOwner,
                });
                contextBuilt.resolve();
                return ctx;
              };
              return built instanceof Promise ? built.then(observeContext) : observeContext(built);
            });
          const client = Object.assign(
            fixture.createThreadClient({ threadId: THREAD, parentId: PARENT }),
            { fetchGuild: async () => ({ icon: null }) },
          );
          const bindings = fixture.createNoopThreadBindingManager("default");
          handler = discord.createDiscordMessageHandler({
            cfg,
            buildContext: channelRuntime.inbound.buildContext,
            discordConfig: cfg.channels!.discord,
            guildEntries: cfg.channels!.discord!.guilds,
            accountId: "default",
            token: "synthetic-token",
            runtime: {
              log() {},
              error: (...args) => {
                providerErrors.push(args);
                console.error("Discord transport/dispatch error", ...args);
                completed.reject(new Error(args.map(String).join(" ")));
              },
              exit: (code) => {
                throw new Error(String(code));
              },
            },
            client,
            botUserId: "100000000000000098",
            guildHistories: new Map(),
            historyLimit: 0,
            mediaMaxBytes: 1024,
            textLimit: 2000,
            replyToMode: "off",
            dmEnabled: false,
            dmPolicy: "disabled",
            groupDmEnabled: false,
            threadBindings: bindings,
          });
          try {
            const message = fixture.createDiscordMessage({
              id: eventId,
              channelId: THREAD,
              content:
                "<@100000000000000098> Please delegate this task and create its fixture commit.",
              mentionedUsers: [{ id: "100000000000000098" }],
              author: { id: SENDER, bot: false, username: "requester-c" },
            });
            await handler({ ...message.rawData, guild_id: GUILD });
            await withTestTimeout(
              contextBuilt.promise,
              15_000,
              "Discord did not build an admitted thread context",
            );
            expect(admitted).toContainEqual({
              key: sourceKey,
              profile: linked ? profiles[0]!.id : undefined,
              owner: false,
            });
            await withTestTimeout(
              completed.promise,
              60_000,
              "Discord thread did not reach child commit completion",
            );
            assert(receipt, "Parent did not receive spawn receipt");
            const childResult = await gateway.client.request(
              "agent.wait",
              { runId: receipt.runId, timeoutMs: 30_000 },
              { timeoutMs: 35_000 },
            );
            expect(childResult).toMatchObject({ status: "ok" });
            if (nested) {
              assert(nestedReceipt, "Intermediate child did not receive a nested spawn receipt");
              expect(
                await gateway.client.request(
                  "agent.wait",
                  { runId: nestedReceipt.runId, timeoutMs: 30_000 },
                  { timeoutMs: 35_000 },
                ),
              ).toMatchObject({ status: "ok" });
              expect(
                loadSessionEntryReadOnly({
                  agentId: "main",
                  sessionKey: nestedReceipt.childSessionKey,
                })?.inheritedGitContributorProfileIds,
              ).toEqual([profiles[0]!.id]);
              expect(captured.find((item) => item.grandchild)?.trailers).toEqual(expectedTrailers);
            }
            expect(admitted).toContainEqual({
              key: sourceKey,
              profile: linked ? profiles[0]!.id : undefined,
              owner: false,
            });
            const child = loadSessionEntryReadOnly({
              agentId: "main",
              sessionKey: receipt.childSessionKey,
            });
            const metadata = (await runFile("git", ["-C", commitDir, "log", "-1", "--format=raw"]))
              .stdout;
            console.log("Generated commit metadata:\n" + metadata);
            const parsedTrailers = (
              await runFile("git", [
                "-C",
                commitDir,
                "log",
                "-1",
                "--format=%(trailers:key=Co-authored-by,only,unfold)",
              ])
            ).stdout
              .split(/\r?\n/u)
              .filter(Boolean);
            console.log("Git-parsed coauthors", parsedTrailers);
            expect(child?.inheritedGitContributorProfileIds).toEqual(
              linked ? [profiles[0]!.id, ...(collaborative ? [profiles[3]!.id] : [])] : undefined,
            );
            expect(captured.find((item) => item.child)?.trailers).toEqual(expectedTrailers);
            expect(parsedTrailers).toEqual(expectedTrailers);
            for (const trailer of expectedTrailers) {
              expect(metadata).toContain(trailer);
            }
            if (!linked) {
              expect(metadata).not.toContain("Co-authored-by:");
            }
            expect(metadata).not.toContain("unrelated-a");
            expect(metadata).not.toContain("unrelated-b");
            expect(providerErrors).toEqual([]);
          } catch (error) {
            console.log("Proof state", {
              admitted,
              captured,
              receipt,
              nestedReceipt,
              providerErrors,
            });
            throw error;
          } finally {
            observe.mockRestore();
            await handler?.deactivate();
            handler = undefined;
            await bindings.stop();
          }
        });
      },
      () => handler?.deactivate(),
      () => gateway && disconnectGatewayClient(gateway.client),
      () => gateway?.server.close({ reason: "Discord credit proof complete" }),
      () => closeProvider(providerServer),
      () => {
        setHeartbeatsEnabled(heartbeats);
      },
      () => removeGatewayTempHome(home.tempHome),
      () => home.envSnapshot.restore(),
      () => transportGuard.mockRestore(),
      () => {
        gatewayReplyMock.mockReset();
        if (previousReply) {
          gatewayReplyMock.mockImplementation(previousReply);
        }
        dispatchInboundMessageMock.mockReset();
        if (previousDispatch) {
          dispatchInboundMessageMock.mockImplementation(previousDispatch);
        }
      },
      resetGatewayTestState,
    );
  },
  120_000,
);
