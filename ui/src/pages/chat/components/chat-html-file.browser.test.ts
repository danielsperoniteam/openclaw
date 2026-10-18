import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import {
  applicationContext,
  type ApplicationContext,
  type ApplicationContextRequest,
} from "../../../app/context.ts";
import { readFileDraft, setFileDraft } from "./chat-file-drafts.ts";
import type { SidebarContent } from "./chat-sidebar-content-types.ts";
import { createChatSidebarContainer } from "./chat-sidebar.test-support.ts";
import "../../../styles.css";
import "../../../styles/chat.ts";
import "./chat-detail-panel.tsx";

const browserMode = "__vitest_browser__" in globalThis;
let userEvent: (typeof import("vitest/browser"))["userEvent"];
let page: (typeof import("vitest/browser"))["page"];
beforeAll(async () => {
  if (browserMode) {
    ({ userEvent, page } = await import("vitest/browser"));
  }
});

type FileContent = Extract<SidebarContent, { kind: "file" }>;
type Panel = HTMLElementTagNameMap["openclaw-chat-detail-panel"];
const source = "<!doctype html>\n<h1>Original HTML</h1>\n<input aria-label=note>";
const opened: FileContent[] = [];
const editor = (panel: Panel) => panel.querySelector(".cm-editor");
const input = (panel: Panel) => panel.querySelector<HTMLElement>(".cm-content")!;
const click = (panel: Panel, name: string) => userEvent.click(button(panel, name));
const sourceText = (panel: Panel) => expect.poll(() => input(panel)?.textContent);
const notice = (panel: Panel) =>
  expect.poll(() => panel.querySelector(".file-view__save-notice")?.textContent);
const conflicting = "<h1>Conflicting draft</h1>";

function conflict(file: FileContent) {
  return vi
    .mocked(file.edit!.save)
    .mockResolvedValueOnce({ ok: false, code: "conflict" })
    .mockResolvedValue({ ok: true, hash: "saved" });
}

function button(panel: Panel, name: string) {
  const found = [...panel.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
  if (!found) {
    throw new Error("Missing button: " + name);
  }
  return found;
}

async function mount(
  name = "page.html",
  retained?: string,
  mimeType?: string,
  retainedHash = "initial",
) {
  const file: FileContent = {
    kind: "file",
    name,
    path: name,
    mimeType,
    content: source,
    draftKey: crypto.randomUUID(),
    edit: { hash: "initial", save: vi.fn(), fetchLatest: vi.fn() },
  };
  opened.push(file);
  if (retained) {
    setFileDraft(file, { content: retained, expectedHash: retainedHash });
  }
  const panel = document.createElement("openclaw-chat-detail-panel");
  const request = vi.fn(async (_method: string, params: { html: string }) => ({
    html: params.html,
    sandboxUrl: "/mcp-app-sandbox",
    sandboxPort: 8444,
  }));
  const previewContext = {
    gateway: {
      snapshot: { client: { request }, phase: "connected" },
      connection: { gatewayUrl: "ws://gateway.example:8443" },
      subscribe: () => () => {},
    },
  } as unknown as ApplicationContext;
  // Only the preview consumes this Gateway-only fixture; sibling catalogs need a full app.
  panel.addEventListener("context-request", (event) => {
    // SAFETY: This listener handles the native application context protocol.
    const contextRequest = event as ApplicationContextRequest;
    if (
      contextRequest.context === applicationContext &&
      contextRequest.contextTarget.localName === "openclaw-chat-html-preview"
    ) {
      event.stopPropagation();
      contextRequest.callback(previewContext);
    }
  });
  panel.style.cssText = "width:100%;height:600px";
  panel.content = file;
  const container = createChatSidebarContainer();
  container.append(panel);
  document.body.append(container);
  await panel.updateComplete;
  await customElements.whenDefined("openclaw-chat-html-preview");
  await expect.poll(() => panel.querySelector("openclaw-chat-html-preview")).not.toBeNull();
  const preview = panel.querySelector("openclaw-chat-html-preview")!;
  preview.embedSandboxMode = "strict";
  await expect.poll(() => panel.querySelector("iframe")).not.toBeNull();
  return { panel, file, request };
}

afterEach(() => {
  document.body.replaceChildren();
  localStorage.removeItem("openclaw.control.fileView.wrap.v1");
  for (const file of opened.splice(0)) {
    setFileDraft(file, null);
  }
});

describe.runIf(browserMode)("HTML file presentation", () => {
  it("renders normalized HTML MIME without a filename extension", async () => {
    const { panel, request } = await mount("report", undefined, "Text/HTML; charset=utf-8");
    expect(request.mock.lastCall?.[1]?.html).toBe(source);
    expect(panel.querySelector(".cm-editor")).toBeNull();
  });

  it("opens rendered HTML before loading CodeMirror, then retains editor and undo through draft preview", async () => {
    const { panel, file, request } = await mount();
    expect(request.mock.lastCall?.[1]?.html).toBe(source);
    expect(panel.querySelector(".cm-editor, h1, .sidebar-file-view__wrap")).toBeNull();
    await click(panel, "Edit file");
    await page.getByRole("textbox", { name: file.name, exact: true }).click();
    await expect
      .poll(() => panel.querySelector('.cm-content[contenteditable="true"]'))
      .not.toBeNull();
    const initialEditor = editor(panel);
    const editable = input(panel);
    await click(panel, "Enable word wrap");
    expect(button(panel, "Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    await userEvent.fill(editable, "<h1>Unsaved draft</h1>");
    expect(readFileDraft(file)?.content).toBe("<h1>Unsaved draft</h1>");
    await click(panel, "Preview");
    await expect.poll(() => request.mock.lastCall?.[1]?.html).toBe("<h1>Unsaved draft</h1>");
    expect(editor(panel)).toBe(initialEditor);
    expect(editable.checkVisibility()).toBe(false);
    expect(panel.querySelector(".sidebar-file-view__wrap")).toBeNull();
    await click(panel, "Source");
    expect(button(panel, "Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    expect(editor(panel)).toBe(initialEditor);
    expect(editable.textContent).toContain("Unsaved draft");
    expect(button(panel, "Save").disabled).toBe(false);
    await userEvent.click(editable);
    await userEvent.keyboard(
      navigator.platform === "MacIntel" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await sourceText(panel).not.toContain("Unsaved draft");
  });

  it("keeps independent iframe instances and modes while two file panels are hidden and revealed", async () => {
    const first = await mount("first.html");
    const frame = first.panel.querySelector("iframe");
    first.panel.hidden = true;
    const second = await mount("second.htm");
    const otherFrame = second.panel.querySelector("iframe");
    await click(second.panel, "Source");
    second.panel.hidden = true;
    first.panel.hidden = false;
    await first.panel.updateComplete;
    expect(first.panel.querySelector("iframe")).toBe(frame);
    expect(second.panel.querySelector("iframe")).toBe(otherFrame);
    expect(button(first.panel, "Source")).toBeDefined();
    expect(button(second.panel, "Preview")).toBeDefined();
    expect(first.request).toHaveBeenCalledOnce();
    expect(second.request).toHaveBeenCalledOnce();
    first.panel.fileNavigation = { line: 2 };
    await expect
      .poll(() => first.panel.querySelector(".file-view__line--target")?.getAttribute("data-line"))
      .toBe("2");
    expect(button(first.panel, "Preview")).toBeDefined();
  });

  it.each(["Save", "Reload", "Overwrite"])(
    "settles a restored draft with %s from Preview and keeps the correct conflict hash",
    async (action) => {
      const draft = conflicting;
      const latest = "<h1>Latest on disk</h1>";
      const { panel, file, request } = await mount(
        "conflict.html",
        draft,
        undefined,
        "retained-hash",
      );
      const save = vi.mocked(file.edit!.save);
      save.mockResolvedValue({ ok: true, hash: "saved" });
      if (action !== "Save") {
        conflict(file);
        vi.mocked(file.edit!.fetchLatest).mockResolvedValue({
          content: latest,
          hash: "latest-hash",
          editable: true,
        });
      }
      expect(editor(panel)).toBeNull();
      expect(button(panel, "Save").disabled).toBe(false);
      await click(panel, "Save");
      if (action === "Save") {
        await expect
          .poll(() => save.mock.calls)
          .toEqual([[{ content: draft, expectedHash: "retained-hash" }]]);
      } else {
        await notice(panel).toContain("Overwrite");
        expect(readFileDraft(file)).toEqual({ content: draft, expectedHash: "retained-hash" });
        await click(panel, action);
      }
      await expect.poll(() => readFileDraft(file)).toBeUndefined();
      await expect.poll(() => button(panel, "Save").disabled).toBe(true);
      expect(editor(panel)).toBeNull();
      if (action === "Overwrite") {
        expect(save).toHaveBeenLastCalledWith({ content: draft, expectedHash: "latest-hash" });
      } else {
        expect(save).toHaveBeenCalledOnce();
        if (action === "Reload") {
          await expect.poll(() => request.mock.lastCall?.[1]?.html).toBe(latest);
        }
      }
      await click(panel, "Source");
      await sourceText(panel).toBe(action === "Reload" ? latest : draft);
    },
  );

  it.each([true, false])(
    "keeps Reload authoritative while Source language loading is pending (editable=%s)",
    async (editable) => {
      const latest = { content: "<h1>Reloaded from disk</h1>", hash: "reloaded-hash", editable };
      const reload = createDeferred<typeof latest>();
      const languageReady = createDeferred();
      const { panel, file } = await mount("reload-race.html", conflicting, undefined, "draft-hash");
      const save = conflict(file);
      vi.mocked(file.edit!.fetchLatest).mockReturnValueOnce(reload.promise);
      await click(panel, "Save");
      await notice(panel).toContain("Reload");
      await click(panel, "Reload");
      await expect.poll(() => vi.mocked(file.edit!.fetchLatest).mock.calls.length).toBe(1);
      const description = LanguageDescription.matchFilename(languages, file.name);
      if (!description) {
        throw new Error("Missing HTML language loader");
      }
      const load = description.load.bind(description);
      const pendingLanguage = vi.spyOn(description, "load").mockImplementationOnce(async () => {
        await languageReady.promise;
        return load();
      });
      try {
        await click(panel, "Source");
        await expect.poll(() => pendingLanguage.mock.calls.length).toBe(1);
        expect(editor(panel)).toBeNull();
        reload.resolve(latest);
        await expect.poll(() => readFileDraft(file)).toBeUndefined();
        expect(editor(panel)).toBeNull();
        languageReady.resolve();
        await sourceText(panel).toBe(latest.content);
        expect(input(panel).getAttribute("contenteditable")).toBe(String(editable));
        if (editable) {
          expect(button(panel, "Save").disabled).toBe(true);
          const edited = latest.content + "<p>New edit</p>";
          await userEvent.fill(input(panel), edited);
          await click(panel, "Save");
          await expect
            .poll(() => save.mock.lastCall)
            .toEqual([{ content: edited, expectedHash: latest.hash }]);
          await expect.poll(() => readFileDraft(file)).toBeUndefined();
        } else {
          expect(
            [...panel.querySelectorAll("button")].some(
              (element) => element.textContent?.trim() === "Save",
            ),
          ).toBe(false);
        }
      } finally {
        languageReady.resolve();
        pendingLanguage.mockRestore();
      }
    },
  );

  it("previews a retained unsaved draft without initializing or discarding its editor", async () => {
    const { panel, file, request } = await mount("draft.html", "<h1>Retained draft</h1>");
    expect(request.mock.lastCall?.[1]?.html).toBe("<h1>Retained draft</h1>");
    expect(editor(panel)).toBeNull();
    await click(panel, "Source");
    await sourceText(panel).toBe("<h1>Retained draft</h1>");
    expect(readFileDraft(file)?.content).toBe("<h1>Retained draft</h1>");
    await click(panel, "Discard");
    await click(panel, "Preview");
    await expect.poll(() => request.mock.lastCall?.[1]?.html).toBe(source);
    expect(readFileDraft(file)).toBeUndefined();
  });
});
