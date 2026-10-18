import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { createDeferred } from "../../../../../test/helpers/promise.js";
import { createApplicationGateway } from "../../../test-helpers/application-context.ts";
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
const conflicting = "<h1>Conflicting draft</h1>";

function conflict(file: FileContent) {
  return vi
    .mocked(file.edit!.save)
    .mockResolvedValueOnce({ ok: false, code: "conflict" })
    .mockResolvedValue({ ok: true, hash: "saved" });
}

function button(panel: Panel, name: string) {
  return [...panel.querySelectorAll("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.trim() === name,
  );
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
  const { gateway } = createApplicationGateway();
  // No advertised methods or session: the sibling app catalog remains unavailable.
  Object.assign(gateway.snapshot, { client: { request }, phase: "connected" });
  gateway.connection.gatewayUrl = "ws://gateway.example:8443";
  panel.style.cssText = "width:100%;height:600px";
  panel.content = file;
  const container = createChatSidebarContainer(gateway);
  container.append(panel);
  document.body.append(container);
  await panel.updateComplete;
  await customElements.whenDefined("openclaw-chat-html-preview");
  await expect.poll(() => panel.querySelector("openclaw-chat-html-preview")).not.toBeNull();
  const preview = panel.querySelector("openclaw-chat-html-preview")!;
  preview.embedSandboxMode = "strict";
  await expect.poll(() => panel.querySelector("iframe")).not.toBeNull();
  expect(request.mock.lastCall?.[1]?.html).toBe(retained ?? source);
  expect(panel.querySelector(".cm-editor")).toBeNull();
  const query = (selector: string) => panel.querySelector<HTMLElement>(selector);
  return {
    panel,
    file,
    request,
    button: (label: string) => button(panel, label)!,
    click: (label: string) => userEvent.click(button(panel, label)!),
    input: () => query(".cm-content")!,
    editor: () => query(".cm-editor"),
    text: () => expect.poll(() => query(".cm-content")?.textContent),
    preview: () => expect.poll(() => request.mock.lastCall?.[1]?.html),
    draft: () => expect.poll(() => readFileDraft(file)),
    notice: () => expect.poll(() => query(".file-view__save-notice")?.textContent),
  };
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
    await mount("report", undefined, "Text/HTML; charset=utf-8");
  });

  it("opens rendered HTML before loading CodeMirror, then retains editor and undo through draft preview", async () => {
    const f = await mount();
    expect(f.panel.querySelector(".cm-editor, h1, .sidebar-file-view__wrap")).toBeNull();
    await f.click("Edit file");
    await page.getByRole("textbox", { name: f.file.name, exact: true }).click();
    await expect.poll(() => f.input()?.contentEditable).toBe("true");
    const initialEditor = f.editor();
    const editable = f.input();
    await f.click("Enable word wrap");
    expect(f.button("Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    await userEvent.fill(editable, "<h1>Unsaved draft</h1>");
    expect(readFileDraft(f.file)?.content).toBe("<h1>Unsaved draft</h1>");
    await f.click("Preview");
    await f.preview().toBe("<h1>Unsaved draft</h1>");
    expect(f.editor()).toBe(initialEditor);
    expect(editable.checkVisibility()).toBe(false);
    expect(f.panel.querySelector(".sidebar-file-view__wrap")).toBeNull();
    await f.click("Source");
    expect(f.editor()).toBe(initialEditor);
    expect(f.button("Disable word wrap").getAttribute("aria-pressed")).toBe("true");
    expect(f.button("Save").disabled).toBe(false);
    expect(editable.textContent).toContain("Unsaved draft");
    await userEvent.click(editable);
    await userEvent.keyboard(
      navigator.platform === "MacIntel" ? "{Meta>}z{/Meta}" : "{Control>}z{/Control}",
    );
    await expect.poll(() => editable.textContent).not.toContain("Unsaved draft");
  });

  it("keeps independent iframe instances and modes while two file panels are hidden and revealed", async () => {
    const first = await mount("first.html");
    const frame = first.panel.querySelector("iframe");
    first.panel.hidden = true;
    const second = await mount("second.htm");
    const otherFrame = second.panel.querySelector("iframe");
    await second.click("Source");
    second.panel.hidden = true;
    first.panel.hidden = false;
    await first.panel.updateComplete;
    expect(first.panel.querySelector("iframe")).toBe(frame);
    expect(second.panel.querySelector("iframe")).toBe(otherFrame);
    expect(first.button("Source")).toBeDefined();
    expect(second.button("Preview")).toBeDefined();
    expect(first.request).toHaveBeenCalledOnce();
    expect(second.request).toHaveBeenCalledOnce();
    first.panel.fileNavigation = { line: 2 };
    await expect
      .poll(() => first.panel.querySelector(".file-view__line--target")?.getAttribute("data-line"))
      .toBe("2");
    expect(first.button("Preview")).toBeDefined();
  });

  it.each(["Save", "Reload", "Overwrite", "Discard"])(
    "settles a restored draft with %s from Preview and keeps the correct conflict hash",
    async (action) => {
      const retained = { content: conflicting, expectedHash: "retained-hash" };
      const draft = retained.content;
      const latest = "<h1>Latest on disk</h1>";
      const f = await mount("conflict.html", draft, undefined, "retained-hash");
      const save = vi.mocked(f.file.edit!.save);
      save.mockResolvedValue({ ok: true, hash: "saved" });
      if (action === "Reload" || action === "Overwrite") {
        conflict(f.file);
        vi.mocked(f.file.edit!.fetchLatest).mockResolvedValue({
          content: latest,
          hash: "latest-hash",
          editable: true,
        });
      }
      expect(f.button("Save").disabled).toBe(false);
      if (action === "Discard") {
        await f.click("Source");
        await f.text().toBe(draft);
        expect(readFileDraft(f.file)?.content).toBe(draft);
        await f.click("Discard");
        await f.click("Preview");
        await f.preview().toBe(source);
      } else {
        await f.click("Save");
        if (action === "Save") {
          await expect.poll(() => save.mock.calls).toEqual([[retained]]);
        } else {
          await f.notice().toContain("Overwrite");
          expect(readFileDraft(f.file)).toEqual(retained);
          await f.click(action);
        }
        await f.draft().toBeUndefined();
        await expect.poll(() => f.button("Save").disabled).toBe(true);
        expect(f.editor()).toBeNull();
      }
      await f.draft().toBeUndefined();
      if (action === "Overwrite") {
        expect(save).toHaveBeenLastCalledWith({ content: draft, expectedHash: "latest-hash" });
      } else if (action !== "Discard") {
        expect(save).toHaveBeenCalledOnce();
        if (action === "Reload") {
          await f.preview().toBe(latest);
        }
      }
      await f.click("Source");
      await f.text().toBe(action === "Discard" ? source : action === "Reload" ? latest : draft);
    },
  );

  it.each([true, false])(
    "keeps Reload authoritative while Source language loading is pending (editable=%s)",
    async (editable) => {
      const latest = { content: "<h1>Reloaded from disk</h1>", hash: "reloaded-hash", editable };
      const reload = createDeferred<typeof latest>();
      const languageReady = createDeferred();
      const f = await mount("reload-race.html", conflicting, undefined, "draft-hash");
      const save = conflict(f.file);
      vi.mocked(f.file.edit!.fetchLatest).mockReturnValueOnce(reload.promise);
      await f.click("Save");
      await f.notice().toContain("Reload");
      await f.click("Reload");
      await expect.poll(() => vi.mocked(f.file.edit!.fetchLatest).mock.calls.length).toBe(1);
      const description = LanguageDescription.matchFilename(languages, f.file.name)!;
      const load = description.load.bind(description);
      const pendingLanguage = vi.spyOn(description, "load").mockImplementationOnce(async () => {
        await languageReady.promise;
        return load();
      });
      try {
        await f.click("Source");
        await expect.poll(() => pendingLanguage.mock.calls.length).toBe(1);
        expect(f.editor()).toBeNull();
        reload.resolve(latest);
        await f.draft().toBeUndefined();
        expect(f.editor()).toBeNull();
        languageReady.resolve();
        await f.text().toBe(latest.content);
        expect(f.input().getAttribute("contenteditable")).toBe(String(editable));
        if (editable) {
          expect(f.button("Save").disabled).toBe(true);
          const edited = latest.content + "<p>New edit</p>";
          await userEvent.fill(f.input(), edited);
          await f.click("Save");
          await expect
            .poll(() => save.mock.lastCall)
            .toEqual([{ content: edited, expectedHash: latest.hash }]);
          await f.draft().toBeUndefined();
        } else {
          expect(f.button("Save")).toBeUndefined();
        }
      } finally {
        languageReady.resolve();
        pendingLanguage.mockRestore();
      }
    },
  );
});
