# Plan — Prompt 16

## Current State
- Zoom clamp uses hard `Math.max(1.0, ...)` and `_clampZoom()` which snaps to scale=1.0 whenever any side of the video would go out of frame
- User reports this is too restrictive: for a wide video in a tall window, the width might fill but the height doesn't — user should still be allowed to zoom out as long as at least one dimension fills the window
- Toast appears on right side of menu bar via `margin-left: auto` — should be centered with a highlighted background

## Problems to Solve

### 1. Zoom should allow zoom-out until BOTH dimensions are smaller than the window
**Current behavior**: min scale = 1.0 (hard clamp), meaning the canvas-wrapper is always at least its natural CSS-fitted size.
**Desired behavior**: Allow scaling below 1.0, but stop when BOTH the scaled video width AND height are smaller than the container. For a 16:9 video in a square container, the video naturally fits width at scale=1.0 but has vertical letterboxing. The user should be able to zoom out further (scale < 1.0) as long as the video's scaled width still fills the container width.

**Math**: The canvas-wrapper at scale=1.0 is fit to `max-width: 100%; max-height: 100%`, preserving aspect ratio. Its natural size depends on the container and video aspect ratio. We need to compute the minimum scale where at least one dimension (width OR height) of the scaled wrapper still equals the container dimension.

**Minimum scale formula**:
- `wrapperW` = natural width of canvas-wrapper at scale 1.0
- `wrapperH` = natural height of canvas-wrapper at scale 1.0
- `containerW` = cell width
- `containerH` = cell height
- `minScaleW = containerW / wrapperW` — scale where width just fills container
- `minScaleH = containerH / wrapperH` — scale where height just fills container
- `minScale = Math.min(minScaleW, minScaleH)` — as long as ONE dimension fills, it's OK
- But don't let both go smaller, so clamp to `Math.min(minScaleW, minScaleH)`

Actually simpler: at scale=1.0, the wrapper is already fit so one dimension matches. The OTHER dimension is smaller. We want to allow zooming out until the dimension that was matching also gets smaller. So the min scale is actually `min(containerW/wrapperW, containerH/wrapperH)` — but since one of those ratios is already 1.0 (the fitting dimension), `min` = the other ratio (which is < 1.0). That's wrong — that would allow zooming until BOTH dimensions are smaller.

Let me re-think. The user says: "stop zooming out when BOTH sides are starting to become smaller than the frame." This means the min scale is the point where BOTH are just at the boundary. That means `minScale = max(containerW/wrapperW, containerH/wrapperH)`. Since one ratio is 1.0 and the other is > 1.0 (impossible — the wrapper is smaller than or equal to the container in both dimensions), actually one ratio is 1.0 and the other is >= 1.0.

Wait — at scale=1.0, the wrapper fits inside the container with max-width/max-height constraints. So wrapperW <= containerW and wrapperH <= containerH. If the video aspect ratio is wider than the container, wrapperW = containerW and wrapperH < containerH. So containerH/wrapperH > 1.0 and containerW/wrapperW = 1.0.

The user wants to zoom out (scale < 1.0) until both scaled dimensions are smaller than the container. The "both smaller" threshold is when the LARGER ratio's scaled wrapper equals the container:
- scaledW = wrapperW * scale → fills when scale = containerW/wrapperW = 1.0
- scaledH = wrapperH * scale → fills when scale = containerH/wrapperH > 1.0

For both to be smaller: scale < 1.0 (width gets smaller) — but height was ALREADY smaller at scale=1.0. So the min scale where "both are just becoming smaller" is actually... 1.0 again? No.

Let me re-read the user's words: "The video should stop zooming out when **both** sides of the video are starting to become smaller than the frame." This means: you CAN zoom out freely, but STOP when both width AND height of the video content become smaller than the window.

At scale=1.0, for a wide video in a tall window:
- width = containerW (fills), height < containerH (doesn't fill)
- As scale decreases below 1.0: width shrinks below containerW too, AND height is still < containerH
- So at any scale < 1.0, BOTH are smaller → should stop at 1.0

But the user says the current behavior (min 1.0) is "too restrictive." So there must be a different interpretation...

OH — I think the confusion is about the "natural" size of the canvas-wrapper. The canvas element inside has a fixed pixel size (e.g., 1920x1080), and `max-width: 100%` constrains it. So at scale=1.0, the canvas-wrapper could be say 400px wide x 225px tall in a 400x400 cell. But without the max-width constraint, it could be 1920x1080.

The user wants to zoom based on the RAW video resolution vs the container, not the CSS-fitted size. Actually no, the zoom transform is applied ON TOP of the CSS fitting. So scale=1.0 means the CSS-fitted size. Scale < 1.0 would make the video appear even smaller.

OK I think the real issue is different. Let me reconsider what the user is experiencing. They have a rectangular video (say 16:9) in a window that might be nearly square. At scale=1.0, the video is CSS-fit, filling the width but not the height (letterboxed). The user zooms IN, then tries to zoom back out. The current code forces scale back to 1.0, resetting offsets. The user finds this restrictive because the zoom-back-out snaps abruptly instead of smoothly zooming out.

The user's request: allow the video to zoom out past its CSS-fit size, as long as at least one dimension (width OR height) is still filling the window. Only stop when BOTH are smaller.

So the min scale should be: `min(containerW/wrapperW, containerH/wrapperH)`.
- For a 400x225 wrapper in a 400x400 cell: min = min(1.0, 1.78) = 1.0 — not helpful
- For a 300x400 wrapper in a 400x400 cell: min = min(1.33, 1.0) = 1.0 — same

Hmm that's still 1.0. Unless the wrapper dimensions at scale 1 are different from what I think...

Actually, the key insight: the transform is on the canvas-wrapper, which at scale=1 is the CSS-constrained size. Below scale 1, the wrapper appears smaller. The container is the video-cell. We need to compute the minimum scale where at least one dimension of (wrapper * scale) >= container dimension.

minScale = min(containerW/wrapperW, containerH/wrapperH)

For a 16:9 video fitting a 400x400 cell: wrapper = 400x225. containerW/wrapperW = 1.0, containerH/wrapperH = 1.78. min = 1.0.

Since one dimension is always tight at scale=1 and the ratio there is 1.0, the min is always 1.0. That means the user's requested behavior is the same as the current behavior?

Unless... the wrapper at scale 1 doesn't perfectly fill one dimension. Or the user wants something slightly different.

I think what the user is actually asking: when you zoom-out from a zoomed-in state, DON'T snap all the way back to 1.0. Instead, smoothly zoom out. The issue is _clampZoom snaps to 1.0 and resets offsets when scale < 1.001, which feels jarring.

New interpretation: remove the forced clamp. Allow scales slightly below 1.0 naturally, and only enforce the true minimum. The offset clamping at scale 1.0 was also too aggressive (snapping offsets to 0).

I'll compute a proper minScale per view using the wrapper vs container dimensions, and only clamp when below that.

## Steps
1. Replace hard 1.0 minimum scale with a dynamic min based on wrapper/container dimensions
2. Remove _clampZoom's forced snap to 1.0 — instead compute proper minScale per view
3. Only reset offsets when at true minimum scale
4. Center the toast in the menu bar with a highlighted background
