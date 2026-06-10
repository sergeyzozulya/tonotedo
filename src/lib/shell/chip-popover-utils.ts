// Chip popover display logic — pure functions for selecting content to show.
// Extracted for testability per spec scope.

import type { TagMeta, PersonMeta } from "../ipc/types.js";

export interface ChipDisplayData {
  displayName: string;
  description: string | undefined;
  count: number | undefined;
}

export function tagDisplayData(
  tagMeta: TagMeta | null | undefined,
  value: string,
): ChipDisplayData {
  const name = tagMeta?.name ?? value;
  const icon = tagMeta?.icon;
  return {
    displayName: icon ? `${icon} #${name}` : `#${name}`,
    description: tagMeta?.description,
    count: tagMeta?.count,
  };
}

export function personDisplayData(
  personMeta: PersonMeta | null | undefined,
  value: string,
): ChipDisplayData {
  return {
    displayName: personMeta?.displayName ?? `@${value}`,
    description: personMeta?.description,
    count: personMeta?.count,
  };
}
