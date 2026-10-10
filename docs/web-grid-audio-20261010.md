# Browser grid audio — 2026-10-10

The grid used `showOverlay` for both AI/diagnostic overlays and its audio
control. Most tiles disable that overlay. Even when enabled, the player's
`contain: layout paint style; isolation: isolate` stacking context placed the
button underneath CameraTile's full-tile `z-[15]` selection button.

CameraTile now explicitly enables audio independently and supplies a tile-local
portal host (`z-40`). The real player button is rendered into that host, above
selection but still inside the fullscreen element. Empty host space does not
capture pointers. Camera selection and double-click remain on the existing
selection button. Private cameras still mount neither player nor audio host.

The button is 44×44 CSS pixels, has camera-specific accessible labels, and
stops click/double-click propagation. It remains available during audio
activation so the user can mute immediately. Hidden prewarming players retain
the previous `showOverlay=false` default and acquire no audio controls.

No detector polling, frame rate, camera configuration, recording mode or API
logic changes. Initial playback stays muted; only explicit audio activation
requests that player's existing `grid-audio` / `original-audio` profile. Muting
silences the video immediately; it retains the existing negotiated audio
profile to avoid reconnecting on every mute/unmute.

`deploy-viewing-update.py --web-only` requires unchanged API image/schema,
updates only the web container, and checks API identity/start time plus media
service start times. It retains signed-manifest verification and rollback.

Validation evidence is stored vendor-side under runtime-artifacts:
`web-grid-audio-tests-20261010.log` (578 tests),
`web-grid-audio-typecheck-20261010.log`,
`web-grid-audio-deployer-tests-20261010.log`, browser-check and fresh-lab reports.
No APK build is required for this browser correction.
