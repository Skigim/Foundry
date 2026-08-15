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

