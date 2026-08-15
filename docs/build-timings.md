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
