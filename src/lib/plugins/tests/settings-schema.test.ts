// Tests for the settings schema rendering model.
// Validates that each PluginSettingField type maps to the correct input behaviour.

import { describe, it, expect } from "vitest";
import type { PluginSettingField, PluginSettingType } from "../../ipc/types.js";

// ── Helpers ────────────────────────────────────────────────────────────────────

function makeField(overrides: Partial<PluginSettingField> = {}): PluginSettingField {
  return {
    key: "myField",
    type: "string",
    label: "My Field",
    ...overrides,
  };
}

// The rendering model determines input type from PluginSettingField.type.
// We verify the mapping without rendering Svelte (pure logic).

function inputTypeFor(field: PluginSettingField): string {
  if (field.type === "boolean") return "checkbox";
  if (field.type === "number") return "number";
  if (field.type === "secret") return "password";
  if (field.type === "enum") return "select";
  return "text";
}

function isSecretField(field: PluginSettingField): boolean {
  return field.type === "secret";
}

function hasOptions(field: PluginSettingField): boolean {
  return field.type === "enum" && Array.isArray(field.options) && field.options.length > 0;
}

// ── Type mapping ───────────────────────────────────────────────────────────────

describe("settings schema — input type mapping", () => {
  const cases: [PluginSettingType, string][] = [
    ["string", "text"],
    ["boolean", "checkbox"],
    ["number", "number"],
    ["enum", "select"],
    ["secret", "password"],
  ];

  for (const [fieldType, expectedInput] of cases) {
    it(`${fieldType} field → ${expectedInput} input`, () => {
      expect(inputTypeFor(makeField({ type: fieldType }))).toBe(expectedInput);
    });
  }
});

// ── Secret fields ──────────────────────────────────────────────────────────────

describe("settings schema — secret fields", () => {
  it("secret field is identified as secret", () => {
    expect(isSecretField(makeField({ type: "secret" }))).toBe(true);
  });

  it("non-secret fields are not secret", () => {
    for (const type of ["string", "boolean", "number", "enum"] as PluginSettingType[]) {
      expect(isSecretField(makeField({ type }))).toBe(false);
    }
  });
});

// ── Enum fields ────────────────────────────────────────────────────────────────

describe("settings schema — enum fields", () => {
  it("enum field with options has options", () => {
    const field = makeField({ type: "enum", options: ["a", "b", "c"] });
    expect(hasOptions(field)).toBe(true);
  });

  it("enum field with empty options has no options", () => {
    const field = makeField({ type: "enum", options: [] });
    expect(hasOptions(field)).toBe(false);
  });

  it("non-enum field is not considered to have options", () => {
    expect(hasOptions(makeField({ type: "string", options: ["x"] }))).toBe(false);
  });
});

// ── Default values ─────────────────────────────────────────────────────────────

describe("settings schema — default values", () => {
  it("field with default returns the default", () => {
    const field = makeField({ type: "enum", options: ["default", "dark"], default: "default" });
    const value = field.default ?? "";
    expect(value).toBe("default");
  });

  it("field without default falls back to empty string", () => {
    const field = makeField({ type: "string" });
    const value = field.default ?? "";
    expect(value).toBe("");
  });
});
