---
id: vim-flavor
name: Vim Flavor
description: Vim-ish bindings with modal editing in the editor zone. j/k navigation in sidebar/entry-list. Not a full vim emulator.
modal: true
---

# Vim-flavor keymap preset

This preset enables the modal editor engine in the editor zone. The sidebar
and palette remain modeless. `j`/`k` navigate entries in the sidebar and
entry list. Inside the editor, normal mode is the default; `i` enters insert.

This is "vim-ish" — not a complete vim emulator.

```bindings
palette.open        cmd+k                           (global)
app.settings        cmd+,                           (global)
entry.create        o                               zone:sidebar
entry.create        o                               zone:entry-list
entry.save          cmd+s                           (global)
entry.search        cmd+p                           (global)
editor.find         /                               zone:editor
focus.sidebar       cmd+shift+s                     (global)
focus.entry-list    cmd+shift+l                     (global)
focus.editor        cmd+shift+e                     (global)
focus.properties    cmd+shift+p                     (global)
focus.calendar      cmd+shift+d                     (global)
view.cheatsheet     ?                               zone:sidebar
view.cheatsheet     ?                               zone:entry-list
view.cheatsheet     cmd+shift+/                     (global)
```
