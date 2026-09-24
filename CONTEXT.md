# agit

A coding agent working a GitHub project as a GitHub App: every write is a Verified commit GitHub creates, and local tripwires stop protected or careless work before it reaches the boundary.

## Language

### Control

**Boundary**:
The one control the agent cannot reach: GitHub, enforcing CODEOWNERS review on the base branch and withholding permissions from the App.
_Avoid_: guard, lock

**Tripwire**:
A local control in front of the Boundary — an editor hook, a publish gate, a merge policy — that an agent with a shell could step over, but never by accident.
_Avoid_: security control, enforcement

**Protected path**:
A path a human must approve: owned in CODEOWNERS, listed in `protected.extra`, or one of the files that define the protection itself.
_Avoid_: control file, owned file

**Impossible path**:
A path the App cannot write at all (by default `.github/workflows/**`), so no Grant unlocks it.

**Protection policy**:
The verdict on paths — impossible, protected, or ordinary — read from CODEOWNERS and `.agit.json` at ONE place: a worktree, a ref, or a branch on GitHub.
_Avoid_: control paths, manifest (CODEOWNERS is the manifest; the policy is what is read from it)

**Base policy**:
The Protection policy as the base branch has it — what GitHub will enforce. Never borrows from the worktree.

### Grants

**Grant**:
A human's scoped, session-bound, expiring lift of one kind of Tripwire (`protected`, `no-verify`, `merge`), with a reason.
_Avoid_: override, bypass, maintainer mode (the mode is the state of having a Grant)

**Session**:
The agent session asking; a Grant unlocks only the Session it names.

### Publishing

**Publish**:
Landing the worktree's in-scope changes as one commit GitHub creates, never `git push`.
_Avoid_: push, commit

**Candidate**:
What a Publish or merge would land, judged before anything is sent: the tree as built (the pre-commit hook included) and the paths it changes. For a merge, only its Resolution.
_Avoid_: dirty paths, changeset

**Resolution**:
The paths of a merge whose content is neither parent's — the agent's own work in it.

**Gate**:
A Tripwire on a Publish — scope, no-verify, validated base, protection, displacement, payload — that refuses before the first write.

**Displacement**:
Content a Publish would silently revert because the worktree's base is older than the branch it lands on.

**Validated base**:
The base commit a green `agit validate` ran against, recorded so a Publish onto a different base is refused.

### Where agit runs

**Context**:
The one answer to "where am I": the checkout, its project config, repo, base branch, common git dir and Grant.
_Avoid_: environment, workspace

**Hook**:
A Claude Code entry point agit answers: a guard (denies a tool call) or a notice (adds context after one).
_Avoid_: git hook (those are the repository's own, which agit runs during a Publish)
