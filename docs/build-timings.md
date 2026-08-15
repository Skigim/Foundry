# Build timings

A tracked record, not a pass/fail assertion. Stage 1 (build tooling) claims a rebuild-speed win; this is
the evidence for or against it.

Numbers are machine-specific and are not comparable across rows unless the machine column matches.
Record the bundler, the machine, and the date every time.

## Method

- **Cold bundle**: `yarn gulp js.web-localhost.dev` with `build.prepare.dev` already done, median of 3.
- **Incremental**: `yarn gulp js.web-localhost.dev.watch`, then touch `src/js/game/belt_path.js` and read
  the rebuild time the bundler prints. Median of 3, first build excluded.
- **Cold prod bundle**: `yarn gulp js.web-shapezio.prod`, single run.

## Results

| date | bundler | machine | cold dev | incremental dev | cold prod |
|---|---|---|---|---|---|
| 2026-08-15 | webpack 4.43 | Windows 11 Home, AMD Ryzen 5 3600 (6-Core), Node v22.17.0 | 8.76s | 980ms | 63.26s |
| 2026-08-15 | rspack 2.1.10 | Windows 11 Home, AMD Ryzen 5 3600 (6-Core), Node v22.17.0 | 4.88s | 67ms | 29.41s |

### Verdict

The Rspack swap delivers substantial speedups across all three metrics on the same hardware: cold dev bundle improved by **1.80x** (8.76s -> 4.88s), cold production bundle improved by **2.15x** (63.26s -> 29.41s), and incremental dev watch rebuilds improved by **14.6x** (980ms -> 67ms). The incremental rebuild time of ~67ms decisively meets and exceeds the Phase 1 Stage 1 "Done when" bar of sub-second incremental rebuilds (comfortably beating Community Edition's reported ~250ms baseline).


## Build variant sweep

Recorded after the Rspack swap. "builds" is the bar for the variants that are never exercised; the two
marked "booted" were launched and played briefly.

| variant | result | notes |
|---|---|---|
| web-localhost | builds | Dev and prod compile cleanly; automated dev browser tests pass |
| web-shapezio-beta | builds | Compiles cleanly |
| web-shapezio | booted | Verified via yarn test:browser:prod (boot smoke test green) |
| standalone-steam | builds | Packaged cleanly via build.standalone-steam |
| standalone-steam-china | builds | Compiles cleanly |
| standalone-steam-demo | builds | Compiles cleanly |
| standalone-steam-china-demo | builds | Compiles cleanly |
| standalone-wegame | builds | Compiles cleanly |
| standalone-gog | builds | Compiles cleanly |

