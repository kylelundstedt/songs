import type { SetListDocument } from "../bootstrap/types";
import { validateSetList, type SetList } from "./model";

/** Upgrade one reviewed immutable projection into the writable identity model. */
export function setListFromBootstrap(document: SetListDocument): SetList {
  const entries = new Map(document.projection.entries.map((entry) => [entry.id, entry]));
  return validateSetList({
    id: document.id,
    path: document.path,
    title: document.projection.title,
    date: document.projection.metadata.date,
    location: document.projection.metadata.location,
    band: document.projection.metadata.band ?? "",
    sections: document.projection.sections.map((section) => ({
      id: section.projectionKey,
      heading: section.heading ?? `Set ${section.ordinal}`,
      columnBreakBefore: section.columnBreakBefore,
      entries: section.entryIds.map((id) => {
        const entry = entries.get(id);
        if (entry === undefined) throw new Error(`Reviewed Set Entry ${id} is missing`);
        return {
          id: entry.id,
          leadSheetId: entry.targetLeadSheetId,
          targetPath: entry.targetPath,
          label: entry.label,
          singer: entry.singer ?? "",
          note: entry.note ?? "",
          columnBreakBefore: entry.columnBreakBefore,
        };
      }),
    })),
  });
}
