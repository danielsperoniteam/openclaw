import type { JSX } from "@solidjs/web";
import { createMemo, onCleanup } from "solid-js";
import { writeSidebarSectionDragData } from "../lib/sessions/drag.ts";
import { renderSidebarReorderMenu } from "./sidebar-reorder.tsx";
export function renderSidebarSessionSectionHeader(params: {
  sectionId: string;
  sectionHeaders: Map<string, HTMLElement>;
  content: JSX.Element;
  status?: {
    content: JSX.Element;
    label: string;
    expanded: boolean;
    title?: string;
    onToggle: () => void;
  };
  draggable?: boolean;
  disabledReason?: string;
  onStartDrag: (sectionId: string) => void;
  onFinishDrag: () => void;
  onContextMenu?: JSX.EventHandler<HTMLDivElement, MouseEvent>;
  reorder?: {
    label: string;
    onMove: (target: string, position: "before" | "after") => void | Promise<void>;
  };
}) {
  const draggable = createMemo(() => params.draggable !== false && !params.disabledReason);
  const sectionId = params.sectionId;
  let header: HTMLElement | undefined;
  onCleanup(() => {
    if (params.sectionHeaders.get(sectionId) === header) {
      params.sectionHeaders.delete(sectionId);
    }
  });
  return (
    <div
      ref={(element) => {
        header = element;
        params.sectionHeaders.set(sectionId, element);
      }}
      class={[
        "sidebar-recent-sessions__head",
        draggable() && "sidebar-recent-sessions__head--draggable",
      ]}
      draggable={draggable() ? "true" : "false"}
      title={params.disabledReason}
      onMouseDown={(event) => {
        const header = event.currentTarget;
        header.toggleAttribute(
          "data-section-drag-blocked",
          Boolean(event.target.closest("button, a")),
        );
      }}
      onMouseUp={(event) => {
        event.currentTarget.removeAttribute("data-section-drag-blocked");
      }}
      onDragStart={(event) => {
        if (!draggable()) {
          event.preventDefault();
          return;
        }
        const header = event.currentTarget;
        const startedFromControl =
          Boolean(event.target.closest("button, a")) ||
          header.hasAttribute("data-section-drag-blocked");
        header.removeAttribute("data-section-drag-blocked");
        if (startedFromControl) {
          event.preventDefault();
          return;
        }
        if (event.dataTransfer) {
          writeSidebarSectionDragData(event.dataTransfer, params.sectionId);
          params.onStartDrag(params.sectionId);
        }
      }}
      onDragEnd={(event) => {
        event.currentTarget.removeAttribute("data-section-drag-blocked");
        params.onFinishDrag();
      }}
      onContextMenu={params.onContextMenu}
    >
      <span class="sidebar-session-group-drag-handle" aria-hidden="true" />
      {params.content}
      {draggable() && params.reorder
        ? renderSidebarReorderMenu({
            ...params.reorder,
            sectionId,
            sections: params.sectionHeaders,
          })
        : undefined}
      {params.status ? (
        <button
          type="button"
          class="sidebar-session-group-status"
          tabindex="-1"
          aria-label={params.status.label}
          aria-expanded={params.status.expanded ? "true" : "false"}
          title={params.status.title}
          onClick={params.status.onToggle}
        >
          {params.status.content}
        </button>
      ) : undefined}
    </div>
  );
}
