import type { ElementHandle, Locator } from "playwright";
import { expect, it } from "vitest";
import { selectChatLayoutAction } from "../test-helpers/chat-layout-menu.ts";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { revealChatModelOption, selectChatModelOption } from "../test-helpers/select-picker-e2e.ts";
import {
  polledAttribute,
  polledCount,
  polledText,
  polledVisible,
} from "./chat-presentation.test-support.ts";
import {
  modelAuthStatus,
  modelPicker,
  modelSessionList,
} from "./chat-runtime-fixtures.test-support.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Control UI model and effort controls" });
const focused = (target: Locator | ElementHandle<HTMLElement | SVGElement>) =>
  target.evaluate((node) => node === document.activeElement);
const catalogModel = (
  id: string,
  provider: string,
  name: string,
  reasoning = false,
  thinkingLevels: { id: string; label: string }[] = [],
) => ({ id, provider, name, reasoning, thinkingLevels });
function sessionList(model: string, provider: string, defaults = {}, row = {}) {
  const selection = { model, modelProvider: provider };
  return modelSessionList(
    { key: "agent:main:main", kind: "direct", ...selection, updatedAt: 1, ...row },
    { ...selection, contextTokens: 200_000, ...defaults },
  );
}

suite.define(() => {
  it.each(["chat", "new"])("keeps a large pending model catalog usable in /%s", async (route) => {
    const contextOptions = { viewport: { width: 1280, height: 900 }, hasTouch: true };
    await suite.withPage(contextOptions, async ({ page }) => {
      const models = Array.from({ length: 1_000 }, (_, index) => ({
        id: `model-${index}`,
        name: `Model ${String(index).padStart(4, "0")}`,
        provider: "example",
        contextWindow: 128_000,
      }));
      const gateway = await installMockGateway(page, {
        agentModel: "example/model-0",
        models,
        methodResponses: { "models.list": { models, pendingProviders: ["example"] } },
        sessionInfo: { model: "model-0", modelProvider: "example" },
      });
      await page.goto(`${suite.server.baseUrl}${route}`);
      const { composer, picker, trigger } = modelPicker(page);
      await polledAttribute(trigger, "aria-disabled").toBe("false");
      expect(await picker.locator("[data-chat-model-option]").count()).toBe(0);
      const textarea = composer.locator("textarea").first();
      await textarea.pressSequentially("catalog proof");
      expect(await textarea.inputValue()).toBe("catalog proof");
      await trigger.click();
      await polledCount(picker.locator("[data-chat-model-option]")).toBe(models.length);
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      const refresh = picker.locator(".chat-controls__model-search-wrap [data-chat-model-refresh]");
      expect(await refresh.textContent()).toContain("Refreshing models for Example…");
      expect(await refresh.getAttribute("role")).toBe("status");
      expect(await refresh.locator(".btn__spinner").isVisible()).toBe(true);
      const requestsBeforeReopen = (await gateway.getRequests("models.list")).length;
      await trigger.click();
      await trigger.click();
      expect((await gateway.getRequests("models.list")).length).toBe(requestsBeforeReopen);
      const refreshDetails = refresh.getByRole("button");
      const openRefreshTooltip = refresh.locator("openclaw-tooltip[open]");
      await refreshDetails.waitFor({ state: "visible" });
      // The popup's opening scale animation can move this small target away
      // from a stationary pointer before the tooltip's hover delay completes.
      await picker.locator("[data-anchored-overlay]").evaluate(async (surface) => {
        await Promise.all(surface.getAnimations().map((animation) => animation.finished));
      });
      await refreshDetails.hover();
      await polledText(openRefreshTooltip.locator(".tooltip-content")).toBe(
        "Refreshing models for Example…",
      );
      const search = picker.locator("[data-chat-model-search]");
      await search.click();
      await search.press("Tab");
      expect(await focused(refreshDetails)).toBe(true);
      await refreshDetails.press("Enter");
      await polledCount(openRefreshTooltip).toBe(1);
      await refreshDetails.press("Escape");
      await polledCount(openRefreshTooltip).toBe(0);
      expect(await picker.getAttribute("open")).not.toBeNull();
      await search.click();
      await refreshDetails.tap();
      await polledCount(openRefreshTooltip).toBe(1);
      await search.click();
      await polledCount(openRefreshTooltip).toBe(0);
      expect(await focused(search)).toBe(true);
      await search.pressSequentially("Model 0999");
      expect(await search.inputValue()).toBe("Model 0999");
      const result = picker.locator('[data-chat-model-option="example/model-999"]');
      await polledVisible(result).toBe(true);
      expect(await picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
      expect(await result.isEnabled()).toBe(true);
      await search.clear();
      await trigger.focus();
      await page.emulateMedia({ reducedMotion: "reduce" });
      await search.pressSequentially("Model 0999");
      expect(await search.inputValue()).toBe("Model 0999");
      await polledVisible(result).toBe(true);
      expect(await picker.locator("[data-chat-model-option]:visible").count()).toBe(1);
      expect(
        await refresh
          .locator(".btn__spinner")
          .evaluate((node) => getComputedStyle(node).animationName),
      ).toBe("none");
      for (const request of await gateway.getRequests("models.list")) {
        expect(request.params).not.toHaveProperty("refresh", true);
      }
      await refreshDetails.focus();
      expect(await focused(refreshDetails)).toBe(true);
      await gateway.setMethodResponse("models.list", { models });
      await gateway.emitGatewayEvent("chat.metadata.changed", {});
      await polledCount(refresh).toBe(0);
      expect(await focused(search)).toBe(true);
      expect(await search.inputValue()).toBe("Model 0999");
      await search.press("ArrowDown");
      expect(await result.getAttribute("data-chat-model-highlighted")).not.toBeNull();
      expect(await picker.locator("[data-chat-model-catalog-state]").count()).toBe(0);
      expect(await picker.getAttribute("open")).not.toBeNull();
      await result.click();
      await polledText(trigger).toContain("Model 0999");
      if (route === "chat") {
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          expectedSessionId: "session:agent:main:main",
          model: "example/model-999",
        });
      }
    });
  });

  it.each(["pointer", "keyboard"])("changes only this chat's account (%s)", async (input) => {
    await suite.withPage(
      {
        viewport: { width: 393, height: 852 },
      },
      async ({ page }) => {
        const personal = {
          authProfileId: "openai:personal",
          provider: "openai",
          label: "Test Person · Personal workspace",
          authType: "oauth",
          selected: false,
        };
        const work = {
          ...personal,
          authProfileId: "openai:work",
          label: "Test Person · Work workspace",
          selected: true,
        };
        const models = [catalogModel("gpt-5.5", "openai", "GPT-5.5")];
        const sessionKey = "agent:main:main";
        const sessions = sessionList("gpt-5.5", "openai");
        const inventory = (accounts: (typeof personal)[], nextCursor?: string) => ({
          profileId: "test-person",
          accounts,
          ...(nextCursor ? { nextCursor } : {}),
          links: [{ provider: "openai", authProfileId: work.authProfileId, updatedAt: 1 }],
        });
        const catalog = ({ label, authProfileId }: typeof personal) => ({
          commands: [],
          models,
          accountSelection: { kind: "personal", label, authProfileId, source: "user" },
        });
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.5",
          models,
          deferredMethods: ["sessions.patch"],
          methodResponses: {
            "sessions.list": sessions,
            "models.authStatus": modelAuthStatus(
              [personal, work].map(({ authProfileId }) => ({
                profileId: authProfileId,
                type: "oauth",
                status: "ok",
                email: `${authProfileId.slice("openai:".length)}@example.com`,
              })),
              { usage: { providerId: "openai", windows: [], plan: "ChatGPT Pro" } },
            ),
            "models.list": catalog(personal),
            // Reopening retries an empty inventory; a populated one stays cached.
            "users.listModelAccounts": inventory(
              input === "keyboard" ? [] : [personal],
              "accounts-page-2",
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input").first();
        const model = composer.locator('[data-chat-model-select="true"]');
        await polledAttribute(model, "aria-busy").toBe("false");
        await model.click();
        const heading = composer.locator('[data-chat-model-provider="openai"]');
        await polledText(heading).toContain("Subscription · personal@example.com");
        const account = composer.locator("[data-chat-account-selection]");
        const picker = account;
        const trigger = picker.locator("[data-chat-account-group-toggle]");
        await polledText(trigger).toContain(personal.label);
        for (const width of [320, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          expect(await heading.getAttribute("title")).toBe("Subscription · personal@example.com");
          expect(
            await heading.locator(".chat-controls__auth-meta svg").evaluate((icon) => ({
              width: getComputedStyle(icon).width,
              height: getComputedStyle(icon).height,
            })),
          ).toEqual({ width: "13px", height: "13px" });
          await expect
            .poll(async () => {
              const box = await account.boundingBox();
              return Boolean(box && box.width > 0 && box.x >= 0 && box.x + box.width <= width + 1);
            })
            .toBe(true);
        }
        await trigger.click();
        const more = picker.locator('[data-chat-account-option="more"]');
        await polledVisible(more).toBe(true);
        expect(
          await picker.locator('[data-chat-account-option="current"]').textContent(),
        ).toContain("personal@example.com");
        await trigger.click();
        await polledVisible(more).toBe(false);
        await polledVisible(account).toBe(true);
        await polledAttribute(trigger, "aria-expanded").toBe("false");
        const refreshRequests = await gateway.getRequests("users.listModelAccounts");
        if (input === "keyboard") {
          await gateway.deferNext("users.listModelAccounts", {});
        }
        await trigger.press("Enter");
        await polledVisible(more).toBe(true);
        const pendingMoreTarget = await more.elementHandle();
        expect(pendingMoreTarget).not.toBeNull();
        if (input === "keyboard") {
          const refresh = await gateway.waitForRequest("users.listModelAccounts", {
            after: refreshRequests.length,
          });
          expect(refresh.params).toEqual({});
          const loading = picker.locator('[data-chat-account-option="loading"]');
          await polledVisible(loading).toBe(true);
          expect(await pendingMoreTarget!.isDisabled()).toBe(true);
          await pendingMoreTarget!.focus();
          await gateway.resolveDeferred(
            "users.listModelAccounts",
            inventory([personal], "accounts-page-2"),
          );
          await polledVisible(loading).toBe(false);
          await expect.poll(() => pendingMoreTarget!.isEnabled()).toBe(true);
          await expect.poll(() => focused(pendingMoreTarget!)).toBe(true);
        } else {
          expect(await gateway.getRequests("users.listModelAccounts")).toEqual(refreshRequests);
        }
        expect(
          await picker
            .locator('[data-chat-account-option="current"]')
            .getAttribute("aria-selected"),
        ).toBe("true");
        const loading = picker.locator('[data-chat-account-option="loading"]');
        async function requestPage(cursor: string, checkFocus = false) {
          const after = (await gateway.getRequests("users.listModelAccounts")).length;
          await gateway.deferNext("users.listModelAccounts", { cursor });
          const url = page.url();
          if (input === "keyboard") {
            if (checkFocus) {
              expect(await focused(pendingMoreTarget!)).toBe(true);
            }
            await page.keyboard.press("Enter");
          } else {
            await pendingMoreTarget!.click();
          }
          await expect
            .poll(
              async () =>
                (await gateway.getRequests("users.listModelAccounts")).length > after ||
                page.url() !== url,
            )
            .toBe(true);
          expect(page.url()).toBe(url);
          const request = await gateway.waitForRequest("users.listModelAccounts", { after });
          expect(request.params).toEqual({ cursor });
          await polledVisible(loading).toBe(true);
          expect(await pendingMoreTarget!.isDisabled()).toBe(true);
          if (input === "keyboard") {
            await page.keyboard.press("Enter");
          } else {
            await pendingMoreTarget!.hover();
            expect(await pendingMoreTarget!.evaluate((row) => row.matches(":hover"))).toBe(true);
            await page.mouse.down();
            await page.mouse.up();
          }
          expect(await gateway.getRequests("users.listModelAccounts")).toHaveLength(after + 1);
          expect(page.url()).toBe(url);
        }
        await requestPage("accounts-page-2");
        await polledAttribute(trigger, "aria-expanded").toBe("true");
        await gateway.resolveDeferred(
          "users.listModelAccounts",
          inventory([work], "accounts-page-3"),
        );
        await polledVisible(loading).toBe(false);
        await expect.poll(() => pendingMoreTarget!.isEnabled()).toBe(true);
        await requestPage("accounts-page-3", true);
        const manage = picker.locator('[data-chat-account-option="manage"]');
        if (input === "keyboard") {
          await manage.focus();
        }
        await gateway.resolveDeferred("users.listModelAccounts", inventory([]));
        await polledVisible(loading).toBe(false);
        await polledVisible(more).toBe(false);
        if (input === "keyboard") {
          expect(await focused(manage)).toBe(true);
        }
        const workOption = picker.locator(
          `[data-chat-account-option="account:${work.authProfileId}"]`,
        );
        await polledVisible(workOption).toBe(true);
        expect(await workOption.textContent()).toContain("work@example.com");
        await trigger.click();
        const search = composer.locator("[data-chat-model-search]");
        await search.fill("account");
        await polledVisible(workOption).toBe(true);
        await search.fill(work.label);
        await search.press("ArrowDown");
        await polledAttribute(workOption, "data-chat-model-highlighted").toBe("");
        await search.press("Enter");
        const patch = await gateway.waitForRequest("sessions.patch");
        expect(patch.params).toEqual({
          expectedSessionId: `session:${sessionKey}`,
          key: sessionKey,
          model: `openai/gpt-5.5@${work.authProfileId}`,
        });
        await polledText(trigger).toContain(personal.label);
        await gateway.resolveDeferred("sessions.patch", { ok: true });
        await gateway.setMethodResponse("sessions.list", sessions);
        await gateway.setMethodResponse("models.list", catalog(work));
        await gateway.emitGatewayEvent("chat.metadata.changed", {});
        await gateway.emitGatewayEvent("sessions.changed", {
          key: sessionKey,
          agentId: "main",
          reason: "patch",
        });
        await polledText(trigger).toContain(work.label);
        await polledText(heading).toContain("Subscription · work@example.com");
        expect(await gateway.getRequests("users.selectModelAccount")).toHaveLength(0);
        expect(await gateway.getRequests("users.unlinkAuthProfile")).toHaveLength(0);
      },
    );
  });

  it.each(
    ["chat", "new"].flatMap((route) =>
      [false, true].map((hoverEffort) => ({ route, hoverEffort })),
    ),
  )(
    "keeps independent model and effort controls within the $route composer (hover effort: $hoverEffort)",
    async ({ route, hoverEffort }) => {
      await suite.withPage({ viewport: { width: 393, height: 852 } }, async ({ page }) => {
        const longName =
          "Long catalog display name for a model with a very large context window and detailed reasoning capabilities";
        const thinkingLevels = [
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ];
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.6-luna",
          models: [
            catalogModel("gpt-5.6-luna", "openai", longName, true, thinkingLevels),
            catalogModel("speed-only", "openai", "Speed only"),
            catalogModel("basic", "example", "Basic"),
          ],
          methodResponses: {
            "sessions.list": sessionList(
              "gpt-5.6-luna",
              "openai",
              { thinkingDefault: "high", thinkingLevels },
              { contextTokens: 200_000, totalTokens: 46_000, totalTokensFresh: true },
            ),
          },
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const composer = page.locator(".agent-chat__input").first();
        const model = composer.locator('[data-chat-model-select="true"]');
        const effort = composer.locator('[data-chat-thinking-select="true"]');
        await polledAttribute(model, "aria-label").toContain(longName);
        await polledVisible(effort).toBe(true);
        for (const width of [320, 375, 393, 430, 560, 768, 1280]) {
          await page.setViewportSize({ width, height: 900 });
          await expect
            .poll(
              async () => {
                const [modelBox, effortBox, actionsBox, composerBox] = await Promise.all([
                  model.boundingBox(),
                  effort.boundingBox(),
                  composer.locator(".agent-chat__composer-actions").boundingBox(),
                  composer.boundingBox(),
                ]);
                return Boolean(
                  modelBox &&
                  effortBox &&
                  actionsBox &&
                  composerBox &&
                  modelBox.width > 0 &&
                  effortBox.width >= 44 &&
                  modelBox.x >= composerBox.x &&
                  modelBox.x + modelBox.width <= effortBox.x + 1 &&
                  effortBox.x + effortBox.width <= actionsBox.x + 1 &&
                  actionsBox.x + actionsBox.width <= composerBox.x + composerBox.width + 1,
                );
              },
              { message: `nonoverlapping ${route} controls at ${width}px` },
            )
            .toBe(true);
          const label = await model
            .locator(".chat-controls__inline-select-label")
            .evaluate((node) => ({
              content: node.textContent?.trim(),
              clipped: node.scrollWidth > node.clientWidth,
              overflow: getComputedStyle(node).overflow,
              textOverflow: getComputedStyle(node).textOverflow,
            }));
          expect(label).toEqual({
            content: longName,
            clipped: true,
            overflow: "hidden",
            textOverflow: "ellipsis",
          });
          expect(await model.getAttribute("aria-label")).toContain(longName);
          await model.click();
          const menu = composer.locator(".chat-controls__model-menu");
          await polledVisible(menu).toBe(true);
          expect(await menu.getByText(/^(?:Effort|Speed)$/).count()).toBe(0);
          expect(
            await menu.locator("[data-chat-thinking-slider], [data-chat-speed-option]").count(),
          ).toBe(0);
          await revealChatModelOption(
            menu.locator('[data-chat-model-option="openai/gpt-5.6-luna"]'),
          );
          await expect
            .poll(() => menu.getByRole("option", { name: new RegExp(longName) }).count())
            .toBe(1);
          await page.keyboard.press("Escape");
          await expect.poll(() => focused(model)).toBe(true);
        }
        await page.setViewportSize({ width: 393, height: 852 });
        await page.emulateMedia({ reducedMotion: "no-preference" });
        const needle = effort.locator(".chat-controls__effort-gauge-needle");
        const needleAngle = () =>
          needle.evaluate((node) => {
            const matrix = new DOMMatrixReadOnly(getComputedStyle(node).transform);
            return Math.round((Math.atan2(matrix.b, matrix.a) * 180) / Math.PI);
          });
        await expect.poll(needleAngle).toBe(120);
        expect(
          await needle.evaluate((node) =>
            Number.parseFloat(getComputedStyle(node).transitionDuration),
          ),
        ).toBeGreaterThan(0);
        expect(await needle.evaluate((node) => node.namespaceURI)).toBe(
          "http://www.w3.org/2000/svg",
        );
        await effort.click();
        const slider = composer.locator('[data-chat-thinking-slider="true"]');
        await polledVisible(slider).toBe(true);
        await slider.press("Home");
        await polledAttribute(effort, "data-chat-thinking-value").toBe("low");
        await expect.poll(needleAngle).toBe(-120);
        if (route === "chat") {
          expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
            key: "agent:main:main",
            thinkingLevel: "low",
          });
        }
        await page.emulateMedia({ reducedMotion: "reduce" });
        expect(await needle.evaluate((node) => getComputedStyle(node).transitionProperty)).toBe(
          "none",
        );
        await slider.press("End");
        await polledAttribute(effort, "data-chat-thinking-value").toBe("high");
        expect(await needleAngle()).toBe(120);
        // The expanded picker suppresses its trigger hint while owning Escape.
        await slider.hover();
        const openTooltips = page.locator("openclaw-tooltip[open]");
        await polledCount(openTooltips).toBe(0);
        expect(await focused(slider)).toBe(true);
        if (hoverEffort) {
          await effort.hover();
          await polledCount(openTooltips).toBe(0);
          expect(await slider.isVisible()).toBe(true);
          expect(await slider.inputValue()).toBe("1");
          expect(await effort.getAttribute("data-chat-thinking-value")).toBe("high");
          expect(await focused(slider)).toBe(true);
        }
        await page.keyboard.press("Escape");
        await polledVisible(slider).toBe(false);
        await expect.poll(() => focused(effort)).toBe(true);
        if (route === "chat") {
          await page.setViewportSize({ width: 1180, height: 900 });
          await selectChatLayoutAction(page, "Open split view");
          const panes = page.locator(".chat-split-view__pane .agent-chat__input");
          await polledCount(panes).toBe(2);
          await expect
            .poll(() =>
              panes.evaluateAll((inputs) =>
                inputs.every((input) => {
                  const paneModel = input.querySelector<HTMLElement>(
                    '[data-chat-model-select="true"]',
                  );
                  const paneEffort = input.querySelector<HTMLElement>(
                    '[data-chat-thinking-select="true"]',
                  );
                  const actions = input.querySelector<HTMLElement>(".agent-chat__composer-actions");
                  if (!paneModel || !paneEffort || !actions) {
                    return false;
                  }
                  const modelBox = paneModel.getBoundingClientRect();
                  const effortBox = paneEffort.getBoundingClientRect();
                  return (
                    input.getBoundingClientRect().width <= 480 &&
                    modelBox.width > 0 &&
                    effortBox.width > 0 &&
                    modelBox.right <= effortBox.left + 1 &&
                    effortBox.right <= actions.getBoundingClientRect().left + 1
                  );
                }),
              ),
            )
            .toBe(true);
        }
        await model.click();
        await composer.locator("[data-chat-model-search]").fill("Speed only");
        await composer.locator('[data-chat-model-option="openai/speed-only"]').click();
        if (route === "chat") {
          await expect
            .poll(async () =>
              (await gateway.getRequests("sessions.patch")).map(({ params }) => params),
            )
            .toContainEqual({
              expectedSessionId: "session:agent:main:main",
              key: "agent:main:main",
              model: "openai/speed-only",
            });
        } else {
          await polledCount(effort).toBe(1);
          await polledAttribute(effort, "aria-label").toBe("Speed: Standard");
          await effort.click();
          await expect
            .poll(() =>
              composer.locator('[data-chat-speed-option="on"]').getAttribute("aria-checked"),
            )
            .toBe("false");
          await model.click();
          await selectChatModelOption(composer.locator('[data-chat-model-option="example/basic"]'));
          await polledCount(effort).toBe(0);
        }
      });
    },
  );
  it.each([
    { provider: "openai", reasoning: false, capability: "non-reasoning" },
    { provider: "example", reasoning: false, capability: "non-reasoning" },
    { provider: "metadata-fixture", reasoning: true, capability: "no-effort" },
  ])(
    "keeps $provider $capability capabilities reachable without a model-menu bridge",
    async ({ provider, reasoning }) => {
      await suite.withPage({ viewport: { width: 320, height: 852 } }, async ({ page }) => {
        const thinking = { thinkingLevels: [], thinkingDefault: "off" };
        const gateway = await installMockGateway(page, {
          agentModel: `${provider}/basic`,
          models: [{ ...catalogModel("basic", provider, "Basic", reasoning), ...thinking }],
          methodResponses: {
            "sessions.list": sessionList("basic", provider, thinking, {
              ...thinking,
              contextTokens: 200_000,
              totalTokens: 46_000,
              totalTokensFresh: true,
            }),
          },
        });
        await page.goto(`${suite.server.baseUrl}chat`);
        const composer = page.locator(".agent-chat__input");
        const model = composer.locator('[data-chat-model-select="true"]');
        await polledAttribute(model, "aria-busy").toBe("false");
        const effort = composer.locator('[data-chat-thinking-select="true"]');
        if (provider !== "openai") {
          await polledCount(effort).toBe(0);
          expect(
            (await gateway.getRequests("sessions.patch")).some(
              ({ params }) => params && Object.hasOwn(params, "thinkingLevel"),
            ),
          ).toBe(false);
          return;
        }
        await polledAttribute(effort, "aria-label").toBe("Speed: Standard");
        const [modelBox, effortBox, actionsBox] = await Promise.all([
          model.boundingBox(),
          effort.boundingBox(),
          composer.locator(".agent-chat__composer-actions").boundingBox(),
        ]);
        expect(modelBox).not.toBeNull();
        expect(effortBox).not.toBeNull();
        expect(actionsBox).not.toBeNull();
        expect(modelBox!.x + modelBox!.width).toBeLessThanOrEqual(effortBox!.x + 1);
        expect(effortBox!.x + effortBox!.width).toBeLessThanOrEqual(actionsBox!.x + 1);
        expect(effortBox!.width).toBeGreaterThanOrEqual(44);
        await effort.click();
        expect(await composer.locator("[data-chat-thinking-slider]").count()).toBe(0);
        await composer.getByRole("radio", { name: "Fast", exact: true }).click();
        expect((await gateway.waitForRequest("sessions.patch")).params).toMatchObject({
          key: "agent:main:main",
          fastMode: true,
        });
        await polledAttribute(effort, "aria-label").toBe("Speed: Fast");
        await page.keyboard.press("Escape");
        await expect.poll(() => focused(effort)).toBe(true);
      });
    },
  );

  it.each(["chat", "new"])(
    "clears %s model search before Escape dismisses the picker",
    async (route) => {
      await suite.withPage({ viewport: { width: 1280, height: 900 } }, async ({ page }) => {
        const gateway = await installMockGateway(page, {
          agentModel: "openai/gpt-5.5",
          models: [
            { id: "gpt-5.5", name: "GPT-5.5", provider: "openai" },
            { id: "claude-sonnet-4-6", name: "Claude Sonnet 4.6", provider: "anthropic" },
          ],
        });
        await page.goto(`${suite.server.baseUrl}${route}`);
        const { picker, trigger, search } = modelPicker(page);
        await polledAttribute(trigger, "aria-disabled").toBe("false");
        await trigger.click();
        await polledCount(picker.locator("[data-chat-model-option]")).toBe(2);
        await revealChatModelOption(picker.locator('[data-chat-model-option="openai/gpt-5.5"]'));
        await revealChatModelOption(
          picker.locator('[data-chat-model-option="anthropic/claude-sonnet-4-6"]'),
        );
        // Enter search with the pointer so row tooltips do not own Escape.
        await search.click();
        await polledCount(page.locator("openclaw-tooltip[open]")).toBe(0);
        await search.fill("anthropic");
        await polledCount(picker.locator("[data-chat-model-option]:visible")).toBe(1);
        await search.press("Escape");
        await polledAttribute(picker, "open").toBe("");
        expect(await search.inputValue()).toBe("");
        expect(await focused(search)).toBe(true);
        await polledCount(picker.locator("[data-chat-model-option]:visible")).toBe(2);
        expect(await gateway.getRequests("sessions.patch")).toEqual([]);

        await search.press("Escape");
        await polledAttribute(picker, "open").toBe(null);
        expect(await focused(trigger)).toBe(true);
      });
    },
  );
});
