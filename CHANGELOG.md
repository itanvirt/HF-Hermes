# Changelog

Notable fixes and changes, in case you hit the same symptom on a duplicated
Space.

## Unreleased

- **Backup no longer builds a tarball.** `app/backup.py` now mirrors
  `~/.hermes` into the backup dataset file-by-file via
  `huggingface_hub.upload_folder`/`snapshot_download` instead of building a
  `.tar.gz` and uploading a new one every cycle. Only changed files are
  transferred, and `delete_patterns=["*"]` keeps the dataset an exact mirror
  (including cleaning up old `backups/*.tar.gz` / `priority/*.md` artifacts
  from the previous scheme on the first sync after upgrading). Change
  detection is now two-tier: a cheap `(file_count, total_size, newest_mtime)`
  marker first, then a full SHA-256 content hash to confirm before paying
  for an upload — avoids a real sync on a no-op `touch`.
- **Backup dataset grew to 83.9GB.** Root cause: every 10-minute backup
  cycle uploaded a brand-new timestamped tarball with no retention, so the
  dataset grew unbounded. First fix added retention + history squashing;
  that fix didn't actually prune because it deleted stale files one at a
  time (one commit per file) instead of in a single batched commit. Both
  problems are now moot under the no-tarball design above — there is only
  ever one "live" copy of each file, so unbounded growth from repeated
  cycles isn't possible by construction.
- **Auth token comparison wasn't timing-safe.** `app/auth.py`'s
  `verify_token()` used a plain `==` comparison against `GATEWAY_TOKEN`,
  which leaks timing information. Switched to `hmac.compare_digest`.
- **Terminal installs didn't survive a restart.** Packages installed
  interactively from `/terminal` (`apt install`, `pip install`, etc.) were
  lost on the next container rebuild unless you remembered to also add them
  to `STARTUP_APT_PACKAGES`/`STARTUP_PIP_PACKAGES` ahead of time. Added
  shell-capture wrapper functions (installed into `~/.bashrc` by
  `scripts/configure_startup.sh`) that auto-append successful installs to
  `data/startup.sh`, which is already replayed on every boot — so the
  Terminal now "remembers" what you installed without any pre-declaration.
- **SOUL.md (agent persona) was being written to the wrong path** by the
  agent and getting wiped on every container rebuild. Backup/restore/configure
  scripts now check and mirror all observed candidate paths
  (`~/.hermes/SOUL.md`, `~/.hermes/workspace/SOUL.md`, `~/SOUL.md`) so the
  persona survives regardless of which one the agent writes to.
