// Test helper — exports CommandRegistry class for unit testing in isolation.
// Production code uses the `registry` singleton from registry.ts.

import type { Command, WhenContext } from "./registry.js";

export class CommandRegistry {
  private readonly _map = new Map<string, Command>();

  register(cmd: Command): void {
    this._map.set(cmd.id, cmd);
  }

  unregister(id: string): void {
    this._map.delete(id);
  }

  get(id: string): Command | undefined {
    return this._map.get(id);
  }

  all(): Command[] {
    return Array.from(this._map.values());
  }

  query(text: string): Command[] {
    if (!text) return this.all();
    const q = text.toLowerCase();
    return this.all().filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.description.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q),
    );
  }

  forContext(context: WhenContext): Command[] {
    return this.all().filter((c) => !c.when || c.when === context);
  }
}
