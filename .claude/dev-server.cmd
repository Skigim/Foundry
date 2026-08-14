@echo off
REM Starts the Foundry web dev server on http://localhost:3005
REM
REM NODE_OPTIONS=--openssl-legacy-provider is required: this project still uses
REM webpack 4, which hashes with MD4 via OpenSSL. OpenSSL 3 (bundled with Node
REM 17+) disables MD4 by default, so without this flag the bundle fails with
REM "error:0308010C:digital envelope routines::unsupported".
REM The same flag is documented in test/browser/harness.js's BUILD_COMMAND.

set "NODE_OPTIONS=--openssl-legacy-provider"
cd /d "%~dp0.."
cd gulp
yarn gulp
