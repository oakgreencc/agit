# Verified commits through the Git Database API

The contract the publish primitive depends on, established by probing GitHub live while building `bot-commit` (the SeKtor tool agit was ported from).

## The sequence

1. `GET /git/ref/heads/<branch>` → head commit; `GET /git/commits/<sha>` → its tree.
2. Build the tree **locally** with git in a throwaway index (`read-tree <head>`, `update-index --add --remove -- <paths>`, `write-tree`) — same modes, symlinks and clean filters `git add` would apply.
3. Ship the difference: UTF-8 text rides as `content` on `POST /git/trees` entries (many files per request); binaries, symlinks and blobs over 512 KiB are `POST /git/blobs`, one per second. `POST /git/trees` with `base_tree` = head's tree.
4. **Compare GitHub's tree sha to the local one.** Trees are content-addressed; a mismatch means what would land is not what was validated, and nothing is committed.
5. `POST /git/commits` with `message`, `tree`, `parents` — **and nothing else**.
6. `PATCH /git/refs/heads/<branch>` with `force: false` — a fast-forward; GitHub answers 422 if the branch moved, which is the concurrency guard.

## The invariant

GitHub signs a commit an App creates **only when the request carries no `author`, `committer` or `signature` key.** Presence breaks it, not value: supplying the App's own identity verbatim produces an unsigned commit that renders identically. `commitBody()` in `src/publish/tree.mjs` accepts exactly three keys, and a test pins that.

## Rate limits

GitHub's secondary limit on content-creating requests (~80/minute, ~500/hour) is why text rides inline: a 610-file reformat once made 610 blob POSTs. The client waits out 403/429 refusals (`retry-after`, `x-ratelimit-reset`, or a "rate limit" body), doubling each time, and reports every wait on stderr.

## Why not `createCommitOnBranch`

The GraphQL mutation takes file contents and makes one single-parent commit. It cannot express a merge. The Git Database sequence makes any commit shape — one parent for a publish, two for a merge whose tree the agent resolved locally — with the same fast-forward guarantee.
