# Releasing a new version

The desktop app checks `latest.json` on GitHub (`main` branch) when it opens.

- **Code update (most releases):** buyers click **Update now** in the app. It downloads a signed bundle of the new code
  (`src/`, the dashboard, npm packages) from GitHub Releases, checks the signature and restarts. No redownload.
- **New installer (sometimes):** needed when `electron/` changes, Electron is upgraded, or `autoposter.minShell` in
  `package.json` is raised. Buyers see a banner linking to Gumroad / Lemon Squeezy instead.

## Code update

1. Bump `version` in `package.json` (for example `1.1.0` → `1.1.1`).
2. `npm test`
3. `npm run bundle`: builds `release/autoposter-<version>.bundle`, signs it and updates `latest.json`.
4. Write a short `"notes"` line in `latest.json` (shown in the app).
5. `gh release create v<version> release/autoposter-<version>.bundle --title "Autoposter <version>"`
6. Commit and push `latest.json`. Push it **after** step 5, or apps will try to download a file that isn't there yet.

## New installer

1. Bump `version`. If the new code needs the new shell, set `autoposter.minShell` to the same version.
2. `npm run dist:mac` and `npm run dist:win`, then replace the files on Gumroad and Lemon Squeezy.
3. Steps 3–6 above, so apps that can take the code update still get it, and the rest see the download banner.

## Signing key

Bundles are signed with `~/.autoposter/update-signing-key.pem` (or `AUTOPOSTER_SIGNING_KEY`). Its public half is in
`src/update-key.js`. **Back the key up and never commit it.** If it's lost, installed apps refuse new bundles until
people install a new installer that has a new public key.

## If an update breaks

If updated code fails to start, the app marks that version as bad and goes back to the built-in code. It won't offer
that version again. Ship a fixed higher version.
