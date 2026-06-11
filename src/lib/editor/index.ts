// Public surface of the editor-core module (issues #11, #12). Checkbox
// interactions (#13), autocomplete (#14), and the properties panel (#15) build
// on these exports.

export { default as Editor } from "./Editor.svelte";
export type { EditorSettings } from "./Editor.svelte";
export { selectionContext } from "./selection-context.js";
export type { SelectionContext, ActiveToken } from "./selection-context.js";

export { baseSetup, markdownExtension } from "./extensions/markdown.js";
export { cursorReveal, computeRevealDecorations } from "./extensions/cursor-reveal.js";
export {
  frontmatterFold,
  detectFrontmatter,
  computeFrontmatterDecorations,
} from "./extensions/frontmatter-fold.js";
export {
  customTokens,
  scanLine,
  TAG_NODE,
  MENTION_NODE,
  WIKILINK_NODE,
} from "./extensions/inline-tokens.js";
export type { ScannedToken, TokenKind } from "./extensions/inline-tokens.js";
export { editorTheme } from "./theme.js";
export {
  chips,
  computeChipDecorations,
  buildCache,
  emptyCache,
  chipsTheme,
} from "./extensions/chips.js";
export type {
  ChipConfig,
  ChipCallbacks,
  ChipMetaCache,
  ComputeChipsOptions,
} from "./extensions/chips.js";
export {
  blocksPlugin,
  blocksTheme,
  pasteDropHandlers,
  extractBlockSpecs,
  headInRange as blockHeadInRange,
  isImagePath,
  isAttachmentPath,
  toggleCheckbox,
} from "./extensions/blocks.js";
export type { BlockCallbacks, AttachmentAction } from "./extensions/blocks.js";
export {
  autocomplete,
  buildCompletionSources,
  rankTags,
  rankPeople,
} from "./extensions/autocomplete.js";
export type { AutocompleteConfig } from "./extensions/autocomplete.js";
export {
  vimCompartment,
  modalEnabled,
  vimModeField,
  setVimMode,
  currentMode,
  isModalActive,
  registerModeListener,
} from "./vim/index.js";
export type { VimMode } from "./vim/index.js";
