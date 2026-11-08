# Notes for Claude sessions in this repo

- **Commit author**: commit as the repo owner so the work counts on their GitHub
  profile. Before the first commit in a session run:

  ```bash
  git config user.name "starscreamwashere"
  git config user.email "119345619+starscreamwashere@users.noreply.github.com"
  ```

  Keep the `Co-Authored-By` trailer for Claude at the end of each commit message.
- Where things stand and what is next: `docs/STATUS.md`.
- `npm install` with Node 25 adds a stray `"peer": true` line to `api/package-lock.json`; don't commit it.
