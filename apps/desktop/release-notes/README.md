# Release notes

One file per desktop release, named `<version>.md` — the version from
`src-tauri/tauri.conf.json` (e.g. `2.1.0.md` for tag `app-v2.1.0`).

Write the file **before** pushing the `app-v*` tag — the release workflow
checks out the tag, so notes committed after tagging are not picked up.

`.github/workflows/release-desktop.yml` injects the file into two places:

- the GitHub Release body, rendered above GitHub's auto-generated
  "What's Changed" section
- the `notes` field of the updater's `latest.json`, which is what the
  in-app update dialog shows users

If no file exists for the tagged version, the release falls back to a
generic one-liner and the workflow logs a warning.

Keep the content user-facing and short: highlights, fixes, known issues.
Markdown is rendered by GitHub and by the updater dialog. Start the file
with `# RecordForge <version>` (satisfies markdownlint MD041) followed by
`##` sections.
