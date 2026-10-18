/* @vitest-environment jsdom */

import { expect, it, onTestFinished, vi } from "vitest";
import "../test-helpers/app-sidebar-suite.ts";
import { mountSolid } from "../test-helpers/mount-solid.ts";
import { waitForSolid } from "../test-helpers/solid-settle.ts";
import { SidebarSessionFilterPopover } from "./sidebar-session-filter-popover.tsx";
import { Picker } from "./solid/select-picker.tsx";

it.each([false, true])(
  "places initial focus without overriding a chosen control (%s)",
  async (chosen) => {
    const container = document.createElement("div");
    const anchor = document.createElement("button");
    document.body.append(container);
    container.append(anchor);
    onTestFinished(() => container.remove());
    if (chosen) {
      container.addEventListener(
        "toggle",
        () => {
          container
            .querySelector<HTMLButtonElement>(".sidebar-session-filter-panel button")
            ?.focus();
        },
        { once: true, capture: true },
      );
    }
    mountSolid(
      () => (
        <SidebarSessionFilterPopover
          anchor={anchor}
          label="Filter sessions"
          onClose={() => {}}
          content={
            <>
              <div id="sidebar-sessions-status">
                <input type="radio" checked />
              </div>
              <button>Sort</button>
            </>
          }
        />
      ),
      { container },
    );
    await waitForSolid(() => expect(container.querySelector("input")).not.toBeNull());
    const initial = container.querySelector("input")!;
    const control = container.querySelector<HTMLButtonElement>(
      "openclaw-sidebar-session-filter-popover button",
    )!;
    await waitForSolid(() => expect(document.activeElement).toBe(chosen ? control : initial));
    control.focus();
    container
      .querySelector(".sidebar-session-filter-panel")!
      .dispatchEvent(new CustomEvent("overlay-after-show"));
    expect(document.activeElement).toBe(control);
  },
);

it("wraps mobile filter focus through a nested picker sheet", async () => {
  const matchMedia = globalThis.matchMedia.bind(globalThis);
  vi.spyOn(globalThis, "matchMedia").mockImplementation((query) => {
    const media = matchMedia(query);
    Object.defineProperty(media, "matches", { configurable: true, value: true });
    return media;
  });
  const container = document.createElement("div");
  const anchor = document.createElement("button");
  document.body.append(container);
  container.append(anchor);
  onTestFinished(() => container.remove());
  let status!: HTMLInputElement;
  mountSolid(
    () => (
      <SidebarSessionFilterPopover
        anchor={anchor}
        label="Filter sessions"
        onClose={() => {}}
        content={
          <>
            <div id="sidebar-sessions-status">
              <input ref={(element) => (status = element)} type="radio" checked />
            </div>
            <Picker
              id="nested-filter-sort"
              label="Sort sessions"
              value="created"
              variant="submenu"
              sheet
              searchable="always"
              options={[
                { value: "created", label: "Created" },
                { value: "updated", label: "Updated" },
              ]}
              groupBy={(option) => ({ id: option.value, label: option.label })}
              onChange={() => {}}
            />
          </>
        }
      />
    ),
    { container },
  );
  await waitForSolid(() => expect(document.activeElement).toBe(status));
  container.querySelector<HTMLButtonElement>("#nested-filter-sort")!.click();
  await waitForSolid(() =>
    expect(container.querySelectorAll(".picker-select__group-toggle")).toHaveLength(2),
  );
  const last = container.querySelectorAll<HTMLButtonElement>(".picker-select__group-toggle")[1]!;
  last.focus();
  const forward = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
  });
  last.dispatchEvent(forward);
  expect(forward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(status);
  const backward = new KeyboardEvent("keydown", {
    key: "Tab",
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  status.dispatchEvent(backward);
  expect(backward.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(last);
});
