# Security Policy

## Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 1.x.x   | :white_check_mark: |
| < 1.4.2 | :x:                |

---

## Reporting a Vulnerability

We take the security and privacy of our users very seriously. If you discover a security vulnerability in **recordForge**, please report it responsibly rather than opening a public GitHub issue.

### How to Report

1. **Email:** Send details of the vulnerability to **security@prestigetech.dev**.
2. **Include Details:**
   - Detailed description of the vulnerability.
   - Steps to reproduce or proof-of-concept exploit.
   - Operating system and recordForge version tested.
   - Any potential mitigations you have identified.

### What to Expect

- We will acknowledge receipt of your vulnerability report within **48 hours**.
- We will provide an assessment and timeline for a patch within **7 days**.
- Once a fix is verified, a security release will be published, and you will be credited in the release notes (unless you prefer anonymity).

---

## Security Architecture Principles

recordForge follows a strict zero-trust desktop security model:

1. **OS Credential Vault Exclusivity:** S3 access keys, Google OAuth tokens, and sensitive secrets are never stored in SQLite, flat files, or logs. They are strictly committed to the native **OS Credential Vault** (Windows Credential Manager, macOS Keychain, Linux Secret Service).
2. **Narrow Capabilities:** Tauri v2 security scopes are restricted to minimal required filesystem paths. Arbitrary command execution is disabled.
3. **Privacy First:** The recorder does not contain telemetry tracking or automatic cloud uploads. All network requests are user-initiated.
4. **Signed Updates:** Official update artifacts are signed with the Tauri updater key and published through GitHub Releases. The public key may be embedded in the release configuration; the private key is restricted to GitHub Actions secrets.
5. **Update Safety:** The native update gate refuses installation while recording, finalizing media, processing jobs, uploading, or starting another native operation.

## Updater Reporting

When reporting an updater problem, include the RecordForge version, operating system, and the release tag or installer URL if known. Do not include updater private keys, tokens, local media paths, or recording content in an issue or security report.
