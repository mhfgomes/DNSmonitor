# DNSmonitor interface direction

## Brief and tokens

A DNS operator's workspace using the supplied plum/pink light and dark palettes. shadcn/ui components use Base UI primitives, Tailwind CSS, and Lucide icons. Both monitor modes receive identical prominence.

Core light palette: background #fdf7fd, surface #faf3fb, raised #fdfafd, ink #501854, muted #8d1255, action #db2777. Core dark palette: background #1f1a24, surface #29232d, raised #2c2631, ink #f9f8fb, muted #e7d0dd, action #a3004c. Supporting tokens preserve the screenshots' sidebar, input, border, message, code, highlight, error and warning colors. Semantic status text uses contrast-adjusted foregrounds where the supplied status color is too faint; the original color remains its marker.

Typography: retain locally bundled IBM Plex Sans for the interface, with IBM Plex Mono for actual hostnames and DNS answers. Use 30/22/16/14/12px hierarchy, moderate weights, tabular figures for counts, left alignment. Monospace is data notation, not decorative labels.

## Layout options and review

Option A: retain a full-width monitor table and place the event stream below. Maximum room for record comparisons, but changes disappear below the fold.

Option B (selected): a broad monitor table with an adjacent, narrower DNS activity stream on wide screens; stack them on smaller screens. A compact health strip summarizes real state. The plum navigation rail and pink selected/action elements provide the identity without adding decorative cards.

```
DNSmonitor    | Monitors                                  Add monitor
              | healthy / warning / critical / unknown / paused
Monitors      | Search and mode filters             | DNS activity
Incidents     | Name / record / state / interval     | Record changes
Notifications | Hostnames and resolver freshness    | Incident events
              |                                     |
Theme         |                                     |
Account       |                                     |
```

Review against brief: rejected a decorative network hero and metric-card grid. DNS answers, status, and change history are the characteristic content. The user's palette drives both themes exactly; surfaces and restrained pink controls provide the emphasis. Keep search and WATCH/EXPECTED filters together, label status with text, avoid gradients and unnecessary animation. Login uses the same visual system and a compact DNS comparison illustration, without marketing claims or fake live statistics.

## Interaction and implementation

Use source-owned shadcn Base UI button, dialog, checkbox and supporting input/select/table components. Tailwind owns shared component styling; app layout rules live in a components layer to avoid overriding utility variants. Preserve form validation, keyboard focus, Escape dismissal, focus restoration and all existing server workflows. Theme preference supports system/light/dark and is saved locally, independent of account credentials. Mobile tables scroll within their own regions. Verify both themes, narrow layouts, keyboard dialogs, and the complete existing operator flow before deploying the updated image.

## Implemented review

Reviewed actual Playwright screenshots at 1600px and 390px, in both themes. Corrected the radio option layout around Base UI hidden inputs, gave form boundaries a contrast-adjusted border while preserving the supplied input surface, and captured settled theme colors instead of transition frames. Dialog content scrolls within the viewport and restores trigger focus. Theme initialization is served as an external script under the existing Content Security Policy. No additional runtime service is needed.
