---
id: default
name: Default
description: Standard modeless keymap with platform-conventional shortcuts.
modal: false
---

# Default keymap preset

The default keymap ships with the app. It is modeless and follows platform
conventions where they exist (cmd+s, cmd+f, cmd+n, cmd+p, cmd+z, etc.).
App-specific bindings fill the remaining slots.

```bindings
palette.open        cmd+k                           (global)
app.settings        cmd+,                           (global)
entry.create        cmd+n                           (global)
entry.save          cmd+s                           (global)
entry.search        cmd+p                           (global)
editor.find         cmd+f                           zone:editor
editor.toggle-checkbox  cmd+shift+c                zone:editor
editor.heading-1    cmd+1                           zone:editor
editor.heading-2    cmd+2                           zone:editor
editor.heading-3    cmd+3                           zone:editor
editor.bold         cmd+b                           zone:editor
editor.italic       cmd+i                           zone:editor
editor.code         cmd+e                           zone:editor
editor.undo         cmd+z                           zone:editor
editor.redo         cmd+shift+z                     zone:editor
focus.sidebar       cmd+shift+s                     (global)
focus.entry-list    cmd+shift+l                     (global)
focus.editor        cmd+shift+e                     (global)
focus.properties    cmd+shift+p                     (global)
focus.calendar      cmd+shift+d                     (global)
view.cheatsheet     ?                               zone:sidebar
view.cheatsheet     ?                               zone:entry-list
view.cheatsheet     ?                               zone:calendar
view.cheatsheet     cmd+shift+/                     (global)
bench.open          (none)                          (global)
```
