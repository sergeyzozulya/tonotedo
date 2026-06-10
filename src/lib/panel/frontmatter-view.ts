// Properties panel — frontmatter parse, view model, and line-granular write-back
// (spec 0002, 0006, design-0003 §panel edits write through).
//
// RESPONSIBILITIES:
//   • parseFrontmatter  — doc text → FmModel (typed property display model)
//   • applyPanelEdit    — FmEdit → ChangeSpec (targeted doc edits, never full reserialise)
//
// KEY CONSTRAINTS (from spec):
//   • Type inference (0002): ISO date → date; ISO datetime → datetime; range → range;
//     YAML bool/number → boolean/number; everything else → string.
//     Schema-declared types are NOT handled here (no schema at panel layer).
//   • Builtins: hide id (advanced); created/updated → read-only; title → never shown.
//   • tags/mentions → editable chip arrays (inline flow form: `key: [a, b, c]`).
//   • Unknown/complex shapes → read-only raw display; never rewritten by panel.
//   • WRITE-BACK: line-granular only. Scalar change → replace value on its line.
//     Add → insert `key: value\n` before closing ---. Remove → delete the line(s).
//     Array (simple) → rewrite that key's single line in inline form.
//     Complex/unknown → never rewritten.
//   • Whole-frontmatter raw replacement → replaceRawBlock (power-user path).
//   • No-frontmatter entry → createFrontmatterBlock inserts the full `---\nkey: value\n---\n`.

import { parseDocument, stringify } from "yaml";

// ── Public types ──────────────────────────────────────────────────────────────

/** The inferred or declared type of a property value as shown in the panel. */
export type PropType =
  | "string"
  | "number"
  | "boolean"
  | "date"
  | "datetime"
  | "range"
  | "tags"
  | "mentions"
  | "complex"; // unknown/object/nested → read-only raw display

/** A single property row in the display model. */
export interface PropRow {
  /** YAML key. */
  key: string;
  /** Parsed JS value for typed inputs. null = YAML null. */
  value: unknown;
  /** Inferred type — drives widget choice. */
  type: PropType;
  /**
   * 1-based line numbers of the key's occupancy in the original doc text.
   * For a scalar: [keyLine] (single line `key: value`).
   * For a flow array: [keyLine].
   * For a block sequence: [firstLine, …, lastLine].
   * Never empty.
   */
  lines: number[];
  /** True when the value must not be edited via the panel (complex/builtin-ro). */
  readOnly: boolean;
  /** Raw string as it appears after `key: ` in the YAML source (for raw display). */
  rawValue: string;
}

/** The full display model derived from a doc's frontmatter. */
export interface FmModel {
  /** True when the document has a valid `--- … ---` frontmatter block. */
  hasFrontmatter: boolean;
  /** 1-based line number of the opening `---` fence. Always 1 when present. */
  openFenceLine: number;
  /** 1-based line number of the closing `---` fence. */
  closeFenceLine: number;
  /** Properties to show in the "normal" section (excluding built-in hidden ones). */
  rows: PropRow[];
  /** Built-in read-only properties (created, updated) — shown separately. */
  builtinRows: PropRow[];
  /** Advanced section: id property (shown only when expanded). */
  advancedRows: PropRow[];
}

/** An edit operation from the panel. */
export type FmEdit =
  | { kind: "set-scalar"; key: string; value: string | number | boolean }
  | { kind: "set-array"; key: string; values: string[] }
  | { kind: "remove"; key: string }
  | { kind: "add"; key: string; value: string | number | boolean | string[] }
  | { kind: "replace-raw"; rawBlock: string };

/**
 * A CM6-style change spec: replace `[from, to)` in the doc with `insert`.
 * When insert is "" it's a pure deletion.
 */
export interface ChangeSpec {
  from: number;
  to: number;
  insert: string;
}

// ── Type inference ────────────────────────────────────────────────────────────

// ISO 8601 date (YYYY-MM-DD), no time component.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// ISO 8601 datetime with timezone offset: 2026-05-20T14:00+02:00 or Z suffix.
const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)$/;
// Range: <start>..<end> where each side is a date or datetime.
const RANGE_RE =
  /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?\.\.\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?([+-]\d{2}:\d{2}|Z)?)?$/;

/** Infer the display type from a parsed YAML value. */
export function inferType(value: unknown, key: string): PropType {
  // tags / mentions arrays — special-cased by key name.
  if (key === "tags" || key === "mentions") {
    if (Array.isArray(value) && value.every((v) => typeof v === "string")) {
      return "tags"; // same widget shape for both; caller knows the key
    }
  }

  if (typeof value === "boolean") return "boolean";
  if (typeof value === "number") return "number";

  if (typeof value === "string") {
    if (RANGE_RE.test(value)) return "range";
    if (ISO_DATETIME_RE.test(value)) return "datetime";
    if (ISO_DATE_RE.test(value)) return "date";
    return "string";
  }

  // Simple arrays of strings → tags-style widget only if it's the right key.
  // Otherwise treat as complex.
  if (Array.isArray(value)) {
    if (value.every((v) => typeof v === "string")) return "tags";
    return "complex";
  }

  // null, object, undefined → complex.
  return "complex";
}

// ── Builtin property classification ──────────────────────────────────────────

const HIDDEN_BUILTINS = new Set(["title"]);
const READONLY_BUILTINS = new Set(["created", "updated"]);
const ADVANCED_BUILTINS = new Set(["id"]);

// ── Parse helpers ─────────────────────────────────────────────────────────────

/** Extract the raw string after `key: ` on a line. Returns "" if not found. */
function rawValueOnLine(line: string, key: string): string {
  const prefix = `${key}:`;
  const idx = line.indexOf(prefix);
  if (idx === -1) return "";
  return line.slice(idx + prefix.length).trim();
}

/**
 * Given the source lines of a frontmatter block (between the fences, 0-indexed
 * within that slice), find the 1-based document line numbers for `key`.
 *
 * Returns the lines that belong to this key (for block sequences, multiple lines).
 * The `bodyStartLine` is the 1-based doc line number of the first content line
 * inside the block (line after opening `---`).
 */
function findKeyLines(
  docLines: string[],
  key: string,
  bodyStartLine: number,
  closeFenceLine: number,
): number[] {
  const result: number[] = [];
  const keyPrefix = `${key}:`;
  for (let i = bodyStartLine - 1; i < closeFenceLine - 1; i++) {
    const line = docLines[i];
    if (line.trimStart().startsWith(keyPrefix)) {
      result.push(i + 1); // 1-based
      // Check for block sequence continuation (lines starting with `  - `)
      let j = i + 1;
      while (j < closeFenceLine - 1) {
        const next = docLines[j];
        if (/^\s+-\s/.test(next) || /^\s+/.test(next)) {
          result.push(j + 1);
          j++;
        } else {
          break;
        }
      }
      break;
    }
  }
  return result;
}

// ── parseFrontmatter ──────────────────────────────────────────────────────────

const FENCE_RE = /^---\s*$/;

/** Parse the document text into a FmModel. Pure, no side-effects. */
export function parseFrontmatter(docText: string): FmModel {
  const docLines = docText.split("\n");
  const empty: FmModel = {
    hasFrontmatter: false,
    openFenceLine: 0,
    closeFenceLine: 0,
    rows: [],
    builtinRows: [],
    advancedRows: [],
  };

  if (docLines.length < 2 || !FENCE_RE.test(docLines[0])) return empty;

  let closeLine = -1;
  for (let i = 1; i < docLines.length; i++) {
    if (FENCE_RE.test(docLines[i])) {
      closeLine = i + 1; // 1-based
      break;
    }
  }
  if (closeLine === -1) return empty;

  // Extract YAML content between fences.
  const yamlLines = docLines.slice(1, closeLine - 1);
  const yamlText = yamlLines.join("\n");

  let parsed: Record<string, unknown>;
  try {
    const doc = parseDocument(yamlText);
    const obj = doc.toJS();
    if (obj === null || typeof obj !== "object" || Array.isArray(obj)) {
      parsed = {};
    } else {
      parsed = obj as Record<string, unknown>;
    }
  } catch {
    parsed = {};
  }

  const rows: PropRow[] = [];
  const builtinRows: PropRow[] = [];
  const advancedRows: PropRow[] = [];

  // Iterate keys in the order they appear in the YAML source.
  for (const key of Object.keys(parsed)) {
    if (HIDDEN_BUILTINS.has(key)) continue;

    const value = parsed[key];
    const type = inferType(value, key);
    const lines = findKeyLines(docLines, key, 2, closeLine);
    if (lines.length === 0) continue; // key not found in source (shouldn't happen)

    const rawLine = docLines[lines[0] - 1] ?? "";
    const rawValue = rawValueOnLine(rawLine, key);

    const row: PropRow = {
      key,
      value,
      type,
      lines,
      readOnly:
        type === "complex" || READONLY_BUILTINS.has(key) || (type === "range" ? false : false), // range IS editable
      rawValue,
    };

    // Correct: complex is always read-only, readonly builtins are read-only.
    const resolvedReadOnly = type === "complex" || READONLY_BUILTINS.has(key);
    const rowFinal: PropRow = { ...row, readOnly: resolvedReadOnly };

    if (ADVANCED_BUILTINS.has(key)) {
      advancedRows.push(rowFinal);
    } else if (READONLY_BUILTINS.has(key)) {
      builtinRows.push(rowFinal);
    } else {
      rows.push(rowFinal);
    }
  }

  return {
    hasFrontmatter: true,
    openFenceLine: 1,
    closeFenceLine: closeLine,
    rows,
    builtinRows,
    advancedRows,
  };
}

// ── applyPanelEdit ────────────────────────────────────────────────────────────

/** Convert a 1-based line number to the `{from, to}` byte offset in `docText`. */
function lineOffsets(
  docText: string,
  lineNo: number,
): { lineFrom: number; lineTo: number; newlineIncluded: boolean } {
  const lines = docText.split("\n");
  let offset = 0;
  for (let i = 0; i < lineNo - 1; i++) {
    offset += lines[i].length + 1; // +1 for the '\n'
  }
  const lineText = lines[lineNo - 1] ?? "";
  const hasNewline = lineNo <= lines.length && lineNo < lines.length;
  return {
    lineFrom: offset,
    lineTo: offset + lineText.length + (hasNewline ? 1 : 0),
    newlineIncluded: hasNewline,
  };
}

/**
 * Given a prop row's key line, replace just the value portion (after `key: `).
 * Returns the new full line string (without trailing newline).
 */
function replaceScalarOnLine(originalLine: string, key: string, newValue: string): string {
  const prefix = `${key}: `;
  const idx = originalLine.indexOf(prefix);
  if (idx === -1) return originalLine; // shouldn't happen
  return originalLine.slice(0, idx + prefix.length) + newValue;
}

/**
 * Serialise a value to a YAML scalar string suitable for inline use.
 * Strings: quoted if they look ambiguous (could be mis-parsed by YAML), else bare.
 * Numbers/booleans: their literal form.
 */
function scalarToYaml(value: string | number | boolean): string {
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // Use yaml's stringify for the value only (wrap in a dummy key and extract).
  // This handles quoting automatically.
  const serialised = stringify({ _: value });
  // stringify gives "_: value\n", extract after ": "
  const colonIdx = serialised.indexOf(": ");
  if (colonIdx === -1) return String(value);
  return serialised.slice(colonIdx + 2).trimEnd();
}

/**
 * Serialise a string array to YAML inline flow form: `[a, b, c]`.
 * Empty → `[]`.
 */
function arrayToYamlInline(values: string[]): string {
  if (values.length === 0) return "[]";
  return "[" + values.map((v) => scalarToYaml(v)).join(", ") + "]";
}

/**
 * Apply a panel edit to the document text and return the CM6 ChangeSpec
 * that implements it.
 *
 * Returns null when the edit is a no-op or cannot be applied (e.g. trying to
 * edit a key not found in the model).
 */
export function applyPanelEdit(docText: string, model: FmModel, edit: FmEdit): ChangeSpec | null {
  if (edit.kind === "replace-raw") {
    // Power-user raw replacement of the whole frontmatter block.
    if (!model.hasFrontmatter) return null;
    const { lineFrom } = lineOffsets(docText, model.openFenceLine);
    const { lineTo } = lineOffsets(docText, model.closeFenceLine);
    const raw = edit.rawBlock.endsWith("\n") ? edit.rawBlock : edit.rawBlock + "\n";
    return { from: lineFrom, to: lineTo, insert: raw };
  }

  if (edit.kind === "add") {
    // Insert a new `key: value\n` line before the closing fence.
    const newLine = formatNewLine(edit.key, edit.value);
    if (!model.hasFrontmatter) {
      // No frontmatter yet: create the whole block.
      return { from: 0, to: 0, insert: `---\n${newLine}\n---\n` };
    }
    const { lineFrom } = lineOffsets(docText, model.closeFenceLine);
    return { from: lineFrom, to: lineFrom, insert: newLine + "\n" };
  }

  // For set-scalar, set-array, remove — find the row.
  const allRows = [...model.rows, ...model.builtinRows, ...model.advancedRows];
  const row = allRows.find((r) => r.key === edit.key);

  if (edit.kind === "remove") {
    if (!row) return null;
    // Delete all lines occupied by the key.
    const { lineFrom } = lineOffsets(docText, row.lines[0]);
    const { lineTo } = lineOffsets(docText, row.lines[row.lines.length - 1]);
    return { from: lineFrom, to: lineTo, insert: "" };
  }

  if (edit.kind === "set-scalar") {
    if (!row || row.readOnly) return null;
    const docLines = docText.split("\n");
    const originalLine = docLines[row.lines[0] - 1] ?? "";
    const newValue = scalarToYaml(edit.value);
    const newLine = replaceScalarOnLine(originalLine, edit.key, newValue);
    const { lineFrom, lineTo, newlineIncluded } = lineOffsets(docText, row.lines[0]);
    return {
      from: lineFrom,
      to: lineTo,
      insert: newLine + (newlineIncluded ? "\n" : ""),
    };
  }

  if (edit.kind === "set-array") {
    if (!row || row.readOnly) return null;
    // Rewrite the key's occupancy (may be multi-line block seq) as a single
    // inline flow line.
    const firstLineNo = row.lines[0];
    const lastLineNo = row.lines[row.lines.length - 1];
    const newLine = `${edit.key}: ${arrayToYamlInline(edit.values)}`;
    const { lineFrom } = lineOffsets(docText, firstLineNo);
    const { lineTo } = lineOffsets(docText, lastLineNo);
    // Preserve trailing newline from last occupied line.
    const docLines = docText.split("\n");
    const lastLine = docLines[lastLineNo - 1] ?? "";
    const hasNewline = lastLineNo < docLines.length;
    void lastLine;
    return {
      from: lineFrom,
      to: lineTo,
      insert: newLine + (hasNewline ? "\n" : ""),
    };
  }

  return null;
}

/** Format a new property line for the "add" edit. */
function formatNewLine(key: string, value: string | number | boolean | string[]): string {
  if (Array.isArray(value)) {
    return `${key}: ${arrayToYamlInline(value)}`;
  }
  return `${key}: ${scalarToYaml(value)}`;
}

// ── createFrontmatterBlock (used by add edit when no frontmatter exists) ───────

/**
 * Produce the ChangeSpec that inserts a fresh frontmatter block at position 0.
 * Exposed for tests.
 */
export function createFrontmatterBlock(key: string, value: string | number | boolean): ChangeSpec {
  const line = `${key}: ${scalarToYaml(value)}`;
  return { from: 0, to: 0, insert: `---\n${line}\n---\n` };
}
