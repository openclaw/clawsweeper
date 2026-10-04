# Changelog fragments

- Status: active contributor and release runbook
- Owner: ClawSweeper maintainers
- Source of truth: [`scripts/changelog-stitch.mjs`](../scripts/changelog-stitch.mjs)
  and its tests in [`test/changelog-stitch.test.ts`](../test/changelog-stitch.test.ts)
- Last verified: `openclaw/clawsweeper@65f9c3a3057621385b6c4f52640a2ce190c18c57`
- Update when: the fragment format, the stitch, or the release changelog
  procedure changes

This applies to `openclaw/clawsweeper` only. ClawSweeper pull requests record
user-visible changes here instead of editing [`CHANGELOG.md`](../CHANGELOG.md),
so concurrent pull requests never conflict on the top of the Unreleased section.
Target repositories keep their own release-note policy; in `openclaw/openclaw`,
`CHANGELOG.md` stays release-owned and pull requests carry release-note context
in their body and commit message.

## Add an entry

Create one new file per change: `changelog.d/<pr-number-or-slug>.md`, for
example `changelog.d/1719-parked-stale-revisions.md`. Use a name nobody else
will pick; a branch-style slug is fine before the PR number exists.

The file holds exactly one house-style bullet on one line, with no wrapping:

```markdown
- Report retained stale-revision publications as parked instead of ready. Thanks @contributor.
```

Rules enforced by `pnpm run check:changelog`, which also runs in
`pnpm run check`:

- the name is lowercase `[a-z0-9._-]` and ends in `.md`; only regular files
  belong in this directory;
- the content is a single `- ` bullet line ending in one LF newline, with no
  blank lines, trailing whitespace, CRLF, or byte-order mark;
- the bullet is not already listed in `CHANGELOG.md` and is not repeated in
  another fragment, so a merge cannot quietly re-add a stale entry.

Edit or delete your own fragment when the change evolves. Do not edit other
fragments or `CHANGELOG.md` in a normal pull request. ClawSweeper's repair,
autofix, and automerge prompts do not ask workers to edit changelogs; they keep
release-note context in the PR body and commit message.

## Stitch at release time

The release maintainer folds the fragments into `CHANGELOG.md` before
finalizing the version heading:

```bash
pnpm run check:changelog
pnpm run changelog:stitch
```

The stitch inserts every fragment bullet at the top of the single
`## <version> - Unreleased` section in file-name order and deletes the
fragments. It replaces `CHANGELOG.md` before deleting anything; when a fragment
bullet is already in the Unreleased section, as after an interrupted run, the
fragment is deleted without adding a duplicate. A second run reports no
fragments and leaves `CHANGELOG.md` unchanged. The stitch refuses to write when
a fragment is invalid or the changelog does not have exactly one Unreleased
heading.

After stitching, review the diff, rename the Unreleased heading to the released
version and date, and add the next `## <version> - Unreleased` heading in the
same release commit.
