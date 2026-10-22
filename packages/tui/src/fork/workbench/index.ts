/**
 * Fork-only fullscreen workbench (custom branch; docs/fork/README.md).
 *
 * Upstream APIs it depends on. After an upstream sync, fix the shell against
 * any of these that changed (docs/fork/workbench-plan.md §11 has locations):
 * - tui.ts: `showOverlay` / `OverlayOptions.fullscreen` and `mouseTracking`
 *   (re-read every frame), `OverlayFocusOwner.ownsOverlayFocusTarget`,
 *   `addInputListener`, `inputDeferred`
 * - root order in `ui.children` (read only, never rearranged): the transcript
 *   root, found by `instanceof TranscriptContainer`, with the HUDs, editor and
 *   status line after it (as InteractiveMode mounts them)
 * - prompt/composer.ts: `Composer.ui` / `Composer.editor` (startup prepaint)
 * - chrome/transcript-container.ts: `blockStates`, `trimBlankEdges`,
 *   `TranscriptPresentationTarget.setTranscriptAllocation` / `AnimationFrame`
 * - chat/user-message.ts `UserMessageComponent`, skill-message.ts,
 *   collab-prompt-message.ts (turns), chat/transcript-outline.ts `stripPromptZones`
 * - components/scroll-view.ts `ScrollView`, mouse.ts `routeSgrMouseInput`,
 *   utils.ts `sliceByColumn`
 * - app-keybindings.ts `KEYBINDINGS` / `Keybindings`, hotkeys-markdown.ts `hotkeyGroups`
 * - overlays/session-selector.ts `rankSessionSearchMatches` / `SessionSelectorEntry`
 * - coding-agent: `beginStartupComposer`, `SessionManager.listForPicker`,
 *   `sessionDisplayName`, `handleResumeSession` / `handleNewCommand`,
 *   `onSessionNameChanged`, `copyToClipboard`, config/registry `register` /
 *   `combine` / `listen`, all-settings `DOMAINS`, pi-utils `getComposerCacheDbPath`
 */
export * from "./layout";
export * from "./rail";
export * from "./selection";
export * from "./shell";
export * from "./sidebar";
export * from "./turn-index";
