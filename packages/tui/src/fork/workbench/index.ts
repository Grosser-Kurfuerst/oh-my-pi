/**
 * Fork-only fullscreen workbench (custom branch; docs/fork/README.md).
 *
 * Upstream APIs it depends on. After an upstream sync, fix the shell against
 * any of these that changed (docs/fork/workbench-plan.md §11 has locations):
 * - tui.ts: `showOverlay` / `OverlayOptions.fullscreen` and `mouseTracking`
 *   (re-read every frame), `OverlayFocusOwner.ownsOverlayFocusTarget`,
 *   `addInputListener`, `inputDeferred`
 * - prompt/composer.ts: chatContainer's place in `ui.children`
 *   (`setRuntimeChildren`), `Composer.ui` / `Composer.editor`
 * - chrome/transcript-container.ts: `beginFrame`, `getChildStartRow`
 * - chat/user-message.ts `UserMessageComponent` (turns),
 *   chat/transcript-outline.ts `stripPromptZones`
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
