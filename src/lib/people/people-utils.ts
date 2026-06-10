// People utilities — pure logic for partitioning people lists and supporting
// person display (spec 0005, issue #22).
//
// RESPONSIBILITIES:
//   partitionPeople — split PersonMeta[] into declared + unmanaged groups
//   sortPeople      — stable sort for display: count desc, then name asc
//
// No DOM, no IPC — pure functions; testable without Svelte.

import type { PersonMeta } from "../ipc/types.js";

export interface PeoplePartition {
  /** Persons with an explicit declaration in _people.md (declared: true). */
  declared: PersonMeta[];
  /** Persons used in entries but lacking a declaration (declared: false/undefined). */
  unmanaged: PersonMeta[];
}

/**
 * Split a flat PersonMeta[] (from people_index) into declared + unmanaged.
 *
 * Within each group, items are sorted by count descending, then displayName
 * ascending (stable, case-insensitive).
 */
export function partitionPeople(people: PersonMeta[]): PeoplePartition {
  const declared: PersonMeta[] = [];
  const unmanaged: PersonMeta[] = [];

  for (const p of people) {
    if (p.declared) {
      declared.push(p);
    } else {
      unmanaged.push(p);
    }
  }

  declared.sort(comparePerson);
  unmanaged.sort(comparePerson);

  return { declared, unmanaged };
}

/**
 * Comparator: count desc, then displayName asc (case-insensitive).
 */
export function comparePerson(a: PersonMeta, b: PersonMeta): number {
  const countDiff = b.count - a.count;
  if (countDiff !== 0) return countDiff;
  return a.displayName.toLowerCase().localeCompare(b.displayName.toLowerCase());
}
