// Permission label map — translates raw permission strings into plain English.
//
// Spec 0010 §"Permissions": read-entries, write-entries, network:<host>,
// filesystem:<path>. The user must see plain language, not internal strings.

/** Return a plain-language label for a permission string. */
export function permissionLabel(perm: string): string {
  if (perm === "read-entries") return "Read your notes";
  if (perm === "write-entries") return "Create and edit notes";
  if (perm.startsWith("network:")) {
    const host = perm.slice("network:".length);
    return `Connect to ${host}`;
  }
  if (perm.startsWith("filesystem:")) {
    const path = perm.slice("filesystem:".length);
    return `Access files at ${path}`;
  }
  // Unknown future permission — show it as-is but in a readable form.
  return perm.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** Return a short description of what the permission allows. */
export function permissionDetail(perm: string): string {
  if (perm === "read-entries") return "The plugin can read the text of your notes.";
  if (perm === "write-entries") return "The plugin can create and modify notes in your library.";
  if (perm.startsWith("network:")) {
    const host = perm.slice("network:".length);
    return `The plugin can make outbound network requests to ${host}.`;
  }
  if (perm.startsWith("filesystem:")) {
    const path = perm.slice("filesystem:".length);
    return `The plugin can read and write files at ${path}.`;
  }
  return "This permission is not yet described.";
}
