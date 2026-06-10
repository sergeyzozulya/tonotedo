---
id: emacs-flavor
name: Emacs Flavor
description: Emacs-ish bindings using ctrl-based chord sequences. Modeless.
modal: false
---

# Emacs-flavor keymap preset

Emacs-ish modeless bindings. Uses ctrl-based chords. Not a full emulator.

```bindings
palette.open        cmd+k                           (global)
app.settings        cmd+,                           (global)
entry.create        ctrl+x ctrl+n                   (global)
entry.save          ctrl+x ctrl+s                   (global)
entry.search        ctrl+s                          (global)
editor.find         ctrl+s                          zone:editor
editor.undo         ctrl+/                          zone:editor
focus.sidebar       ctrl+x ctrl+1                   (global)
focus.entry-list    ctrl+x ctrl+2                   (global)
focus.editor        ctrl+x ctrl+e                   (global)
view.cheatsheet     ?                               zone:sidebar
view.cheatsheet     ?                               zone:entry-list
view.cheatsheet     cmd+shift+/                     (global)
```
