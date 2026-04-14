// Shared layout constants for BoardCanvas, RunView, and Minimap.
// Keeping these in one module prevents silent drift when any consumer
// changes its own copy of the numbers.

export const HEADER_W = 210;
export const TASK_W = 176;
export const TASK_H = 52;
export const TASK_GAP = 24;
export const PAD_LEFT = 20;
export const TRACK_H = 64;
export const CANVAS_PAD_RIGHT = 300;

// Scroll container id used by Minimap to sample canvas scroll extents.
// Both the editor BoardCanvas and the read-only RunView mount their
// scroll container with this id so Minimap can be reused in either mode.
export const BOARD_SCROLL_ID = 'board-scroll';
