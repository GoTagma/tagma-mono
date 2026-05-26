# Agent Instructions

## Git Commit Summary Files

When an agent creates a git commit in this repository:

1. Write the commit message first and create the commit.
2. Read the final commit id after the commit is created.
3. Ensure the repository-root `changelog/` directory exists; create it first if it is missing.
4. Add one English summary file under `changelog/`, named after the final commit id:
   - `<commit-id>.en.md`
5. In the file, write the commit message as a real multiline bullet list. Use real newline characters and lines that start with `- `; do not write escaped `\n` sequences.
6. The `changelog/` directory is intentionally ignored by git, so these local summary files should not affect the commit contents or repository status.

If one task creates commits in multiple related repositories, such as this repository and a nested `apps` repository, create one combined changelog file in this repository root only. Name it after this repository's final commit id, and include all related commit messages from that task in the same file, including both the nested repository commit message and the parent repository commit message.

Do not amend the same commit to include these files after naming them with the commit id. Amending changes the commit id and makes the filenames stale. If these summary files need to be committed, make a separate explicit follow-up commit.
