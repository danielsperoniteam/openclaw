import path from "node:path";
import type { Page } from "playwright";
import { expect, it } from "vitest";
import { installMockGateway } from "../test-helpers/control-ui-e2e.ts";
import { createControlUiE2eSuite } from "./control-ui-e2e-suite.test-support.ts";

const suite = createControlUiE2eSuite({ name: "Omitted history image placeholder" });
const RETAINED_IMAGE_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAEAAAABACAYAAACqaXHeAAAAmElEQVR4nO3QMREAIBDAsHeERQyjAWRkoEP2Xmftc382OkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAK0BOkBrgA7QGqADtAboAO0B06OyaOxP7RwAAAAASUVORK5CYII=";

const omittedImage = { type: "image", omitted: true, bytes: 149255 };
const computerCall = { name: "computer", toolCallId: "capture" };
const screenshotArgs = { action: "screenshot" };
const omittedCard = (page: Page) =>
  page.locator(".chat-assistant-attachment-card", { hasText: "Omitted from history" });

async function openHistoricalImage(page: Page, url?: string) {
  await installMockGateway(page, {
    historyMessages: [
      {
        role: "user",
        timestamp: 1,
        content: [{ type: "image", omitted: true, bytes: 12 * 1024, ...(url ? { url } : {}) }],
      },
    ],
  });
  await page.goto(`${suite.server.baseUrl}chat`);
}

suite.define(() => {
  it.each(["history", "result-first", "receipt-first"] as const)(
    "loads retained computer screenshots (%s)",
    async (delivery) => {
      await suite.withPage(
        { locale: "en-US", serviceWorkers: "block", viewport: { width: 1280, height: 900 } },
        async ({ page }) => {
          const dataUrl = await page.evaluate(() => {
            const canvas = document.createElement("canvas");
            canvas.width = 1200;
            canvas.height = 500;
            const context = canvas.getContext("2d")!;
            context.fillStyle = "#173b4b";
            context.fillRect(0, 0, 1200, 500);
            context.fillStyle = "#285b6b";
            context.fillRect(70, 60, 1060, 380);
            context.fillStyle = "#fff";
            context.font = "bold 52px sans-serif";
            context.fillText("Synthetic desktop screenshot", 120, 220);
            context.font = "32px sans-serif";
            context.fillText("1200 × 500 · retained in the transcript", 120, 290);
            return canvas.toDataURL("image/png");
          });
          const artifactId = "artifact_transcript_image_fixture";
          const runId = "screenshot-run";
          const sessionKey = "agent:main:main";
          const sessionId = "screenshot-session";
          const persistedImage = {
            role: "toolResult",
            toolName: "computer",
            toolCallId: "capture",
            content: [{ ...omittedImage, mimeType: "image/png", artifactId }],
            details: { media: { outbound: false } },
            __openclaw: {
              id: "saved-screenshot",
              seq: 3,
              runId,
              transcriptPosition: { source: "screenshot-transcript", rawSeq: 3 },
            },
            timestamp: 3,
          };
          const running = delivery !== "history";
          const sessionInfo = {
            key: sessionKey,
            sessionId,
            hasActiveRun: running,
            activeRunIds: running ? [runId] : [],
            status: running ? "running" : "idle",
          };
          const gateway = await installMockGateway(page, {
            sessionKey,
            sessionInfo,
            sessions: [sessionInfo],
            inFlightRun: running ? { runId, text: "", startedAt: Date.now() } : null,
            historyMessages: [
              { role: "user", content: "Take a screenshot of the desktop.", timestamp: 1 },
              {
                role: "assistant",
                content: [
                  { type: "text", text: "Here is the desktop screenshot." },
                  {
                    type: "toolCall",
                    name: computerCall.name,
                    id: "capture",
                    arguments: screenshotArgs,
                  },
                ],
                __openclaw: { id: "capture-call", seq: 2, runId },
                timestamp: 2,
              },
              ...(running ? [] : [persistedImage]),
            ],
            methodResponses: {
              "artifacts.download": {
                artifact: {
                  id: artifactId,
                  type: "image",
                  title: "Screenshot",
                  mimeType: "image/png",
                  download: { mode: "bytes" },
                },
                encoding: "base64",
                data: dataUrl.split(",")[1],
              },
            },
          });
          await page.goto(`${suite.server.baseUrl}chat`);
          await page.getByText("Here is the desktop screenshot.", { exact: true }).waitFor();
          if (running) {
            await page.getByRole("button", { name: "Stop generating" }).waitFor();
            const toolEvent = (seq: number, data: Record<string, unknown>) =>
              gateway.emitGatewayEvent("agent", {
                sessionKey,
                runId,
                seq,
                ts: Date.now(),
                stream: "tool",
                data: { ...computerCall, ...data },
              });
            await toolEvent(1, { phase: "start", args: screenshotArgs });
            const result = () =>
              toolEvent(2, {
                phase: "result",
                result: { content: [omittedImage] },
              });
            if (delivery === "result-first") {
              await result();
            }
            await gateway.emitGatewayEvent("session.message", {
              sessionKey,
              sessionId,
              runId,
              hasActiveRun: true,
              activeRunIds: [runId],
              status: "running",
              messageId: "saved-screenshot",
              messageSeq: 3,
              message: persistedImage,
            });
            if (delivery === "receipt-first") {
              await result();
            }
          }
          if (await page.getByText("Omitted from history · 146 KB", { exact: true }).count()) {
            await page.screenshot({ path: path.join(suite.artifactDir, "screenshot-before.png") });
          }
          const screenshot = page.locator("img.chat-message-image");
          await screenshot.waitFor({ state: "visible" });
          expect(
            await screenshot.evaluate((element) => (element as HTMLImageElement).naturalWidth),
          ).toBe(1200);
          const request = await gateway.waitForRequest("artifacts.download");
          expect(request.params).toMatchObject({ sessionKey: "agent:main:main", artifactId });
          await expect
            .poll(() => page.getByText("Omitted from history", { exact: false }).count())
            .toBe(0);
          expect(await screenshot.count()).toBe(1);
          await page.screenshot({ path: path.join(suite.artifactDir, "screenshot-after.png") });
          await screenshot.click();
          await page.locator("openclaw-image-lightbox .image").waitFor({ state: "visible" });
          if (running) {
            await page.getByRole("button", { name: "Close image preview" }).click();
            expect(await page.getByRole("button", { name: "Stop generating" }).isVisible()).toBe(
              true,
            );
          } else {
            await page.reload();
            await page.locator("img.chat-message-image").waitFor({ state: "visible" });
            expect(await page.getByText("Omitted from history", { exact: false }).count()).toBe(0);
          }
        },
      );
    },
  );

  it("keeps sanitized historical images visible without fake recovery actions", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await openHistoricalImage(page);
      const placeholder = omittedCard(page);
      await placeholder.waitFor({ state: "visible" });

      expect(await placeholder.textContent()).toContain("Image");
      expect(await placeholder.textContent()).toContain("History");
      expect(await placeholder.textContent()).toContain("12 KB");
      expect(await placeholder.locator("a, button, img, audio, video").count()).toBe(0);
    });
  });

  it("renders a retained image URL without an omitted-media placeholder", async () => {
    await suite.withPage({ locale: "en-US", serviceWorkers: "block" }, async ({ page }) => {
      await openHistoricalImage(page, RETAINED_IMAGE_DATA_URL);
      await page
        .locator(`img.chat-message-image[src="${RETAINED_IMAGE_DATA_URL}"]`)
        .waitFor({ state: "visible" });
      expect(await omittedCard(page).count()).toBe(0);
    });
  });
});
