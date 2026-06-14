// Shared layout constants for BoardCanvas, RunView, and Minimap.
// Keeping these in one module prevents silent drift when any consumer
// changes its own copy of the numbers.

export const HEADER_W = 210;
export const TASK_W = 176;
export const TASK_H = 52;
export const TASK_GAP = 24;
export const PAD_LEFT = 20;
export const TRACK_H = 64;
export const TRACK_MIN_H = 64;
export const TRACK_MAX_H = 480;
/**
 * Height of a slim folder header bar (sidebar caret + name + count). Folder
 * grouping is editor-only — see TrackFolder in api/client.ts. Picked to be
 * just tall enough to be a clear hit target without dominating the lane
 * stack the way a full track row would.
 */
export const FOLDER_H = 16;
export const CANVAS_PAD_RIGHT = 300;

// Scroll container id used by Minimap to sample canvas scroll extents.
// Both the editor BoardCanvas and the read-only RunView mount their
// scroll container with this id so Minimap can be reused in either mode.
export const BOARD_SCROLL_ID = 'board-scroll';
