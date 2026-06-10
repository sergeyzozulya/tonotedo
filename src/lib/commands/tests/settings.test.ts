import { describe, it, expect, beforeEach } from "vitest";
import {
  MemorySettingsStore,
  setSettingsStore,
  loadUserBindings,
  saveBinding,
  removeBindingOverride,
  savePreset,
} from "../settings.js";

beforeEach(() => {
  // Use a fresh in-memory store for every test.
  setSettingsStore(new MemorySettingsStore());
});

describe("MemorySettingsStore", () => {
  it("loads empty settings by default", () => {
    const store = new MemorySettingsStore();
    expect(store.load()).toEqual({});
  });

  it("saves and loads settings", () => {
    const store = new MemorySettingsStore();
    store.save({ bindings: { "entry.create": ["meta+n"] } });
    expect(store.load().bindings).toEqual({ "entry.create": ["meta+n"] });
  });

  it("round-trips unknown keys", () => {
    const store = new MemorySettingsStore();
    store.save({ bindings: {}, unknownKey: "preserved" });
    expect(store.load().unknownKey).toBe("preserved");
  });
});

describe("loadUserBindings", () => {
  it("returns empty map when no bindings stored", () => {
    const bindings = loadUserBindings();
    expect(bindings.size).toBe(0);
  });

  it("returns bindings as a Map", () => {
    saveBinding("entry.create", ["meta+shift+n"]);
    const bindings = loadUserBindings();
    expect(bindings.get("entry.create")).toEqual(["meta+shift+n"]);
  });
});

describe("saveBinding", () => {
  it("persists a single binding override", () => {
    saveBinding("editor.bold", ["ctrl+b"]);
    const bindings = loadUserBindings();
    expect(bindings.get("editor.bold")).toEqual(["ctrl+b"]);
  });

  it("merges with existing bindings (does not wipe others)", () => {
    saveBinding("entry.create", ["meta+n"]);
    saveBinding("editor.bold", ["meta+b"]);
    const bindings = loadUserBindings();
    expect(bindings.get("entry.create")).toEqual(["meta+n"]);
    expect(bindings.get("editor.bold")).toEqual(["meta+b"]);
  });

  it("overwrites existing binding for same command", () => {
    saveBinding("entry.create", ["meta+n"]);
    saveBinding("entry.create", ["meta+shift+n"]);
    const bindings = loadUserBindings();
    expect(bindings.get("entry.create")).toEqual(["meta+shift+n"]);
  });

  it("supports multiple bindings per command", () => {
    saveBinding("entry.create", ["meta+n", "ctrl+n"]);
    expect(loadUserBindings().get("entry.create")).toEqual(["meta+n", "ctrl+n"]);
  });
});

describe("removeBindingOverride", () => {
  it("removes a binding override", () => {
    saveBinding("entry.create", ["meta+n"]);
    removeBindingOverride("entry.create");
    expect(loadUserBindings().get("entry.create")).toBeUndefined();
  });

  it("is a no-op when binding does not exist", () => {
    expect(() => removeBindingOverride("nonexistent.cmd")).not.toThrow();
  });

  it("does not affect other bindings", () => {
    saveBinding("entry.create", ["meta+n"]);
    saveBinding("editor.bold", ["meta+b"]);
    removeBindingOverride("entry.create");
    expect(loadUserBindings().get("editor.bold")).toEqual(["meta+b"]);
  });
});

describe("savePreset", () => {
  it("persists preset id and modal flag", () => {
    const store = new MemorySettingsStore();
    setSettingsStore(store);
    savePreset("vim-flavor", true);
    const settings = store.load();
    expect(settings.preset).toBe("vim-flavor");
    expect(settings.modalEditor).toBe(true);
  });

  it("preserves existing bindings when saving preset", () => {
    saveBinding("entry.create", ["meta+n"]);
    savePreset("default", false);
    const bindings = loadUserBindings();
    expect(bindings.get("entry.create")).toEqual(["meta+n"]);
  });
});
