# Verified commits through the Git Database API

The contract the publish primitive depends on, established by probing GitHub live while building `bot-commit` (the SeKtor tool agit was ported from).

## The sequence

1. `GET /git/ref/heads/<branch>` → head commit; `GET /git/commits/<sha>` → its tree.
2. Build the tree **locally** with git in a throwaway index (`read-tree <head>`, `update-index --add --remove -- <paths>`, `write-tree`) — same modes, symlinks and clean filters `git add` would apply.
3. Ship the difference: UTF-8 text rides as `content` on `POST /git/trees` entries (many files per request); binaries, symlinks and blobs over 512 KiB are `POST /git/blobs`, one per second. `POST /git/trees` with `base_tree` = head's tree — or, for a merge, the tree of whichever parent the resolved tree is nearer (fewer differing paths; the head on a tie). A stale branch's merge built on its head sends every path the merge brought in, and a large enough request 502s the trees endpoint.
4. **Compare GitHub's tree sha to the local one.** Trees are content-addressed; a mismatch means what would land is not what was validated, and nothing is committed.
5. `POST /git/commits` with `message`, `tree`, `parents` — **and nothing else**.
6. `PATCH /git/refs/heads/<branch>` with `force: false` — a fast-forward; GitHub answers 422 if the branch moved, which is the concurrency guard.

## The invariant

GitHub signs a commit an App creates **only when the request carries no `author`, `committer` or `signature` key.** Presence breaks it, not value: supplying the App's own identity verbatim produces an unsigned commit that renders identically. `commitBody()` in `src/publish/tree.mjs` accepts exactly three keys, and a test pins that.

## Rate limits

GitHub's secondary limit on content-creating requests (~80/minute, ~500/hour) is why text rides inline: a 610-file reformat once made 610 blob POSTs. The client waits out 403/429 refusals (`retry-after`, `x-ratelimit-reset`, or a "rate limit" body), doubling each time, and reports every wait on stderr.

A 500/502/503/504 is different: it does not say whether GitHub performed the write. Only the content-addressed writes — `POST /git/blobs` and `POST /git/trees`, whose answer is a sha fixed by the body — are repeated on a 5xx (1s, doubling, four times, each wait reported). `POST /git/commits` and ref updates never are: a repeat could create a second commit.

## Merges

`agit merge` publishes a merge in progress (`git merge --no-commit`, resolve, `git add`) — parents `[HEAD, MERGE_HEAD]`, the real index's tree after the pre-commit hook, and `MERGE_MSG` without its comments, run through commit-msg — or a merge already committed locally. No local commit is needed. An index with unmerged paths is refused by name. Advancing afterwards clears the merge state with `git merge --quit`, never `reset --merge`.

## A retry after a lost response

If a publish's commit landed but its response did not, the worktree was never advanced. Re-running the same publish finds the branch head already holds this content and answers `nothing to publish: … already has this content — no commit made`, writes nothing, reuses an open PR, and advances.

## Why not `createCommitOnBranch`

The GraphQL mutation takes file contents and makes one single-parent commit. It cannot express a merge. The Git Database sequence makes any commit shape — one parent for a publish, two for a merge whose tree the agent resolved locally — with the same fast-forward guarantee.
