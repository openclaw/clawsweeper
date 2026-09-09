# Review revision label proof

Active proof owned by the durable review-comment renderer. From the repository
root after `pnpm run build`, run:

```sh
node docs/proof/review-revision/run-proof.mjs --serve
```

The script invokes the actual compiled renderer with synthetic reports and prior
durable comments. For the baseline it copies the compiled modules into a private
fixture, replaces only the two changed renderer owners with `origin/main` source
stripped by Node's TypeScript loader, then removes that fixture. It asserts that
the history ledger is unchanged and checks first review, Revision 2, same-review
resync, Revision 3, issue comments and a lifetime count beyond the visible ledger
cap (Revision 52).

Generated Markdown, HTML and first-line observations are written under
`.artifacts/review-revision`. `--serve` prints a loopback URL for the before and
after pages; omit it for a non-interactive renderer run. Node 24 may print its
standard experimental warning for `stripTypeScriptTypes`.

The supplied captures were taken in the existing Chrome profile through its
extension-backed browser connection. Both captures were inspected: they contain
only the synthetic review page, with no browser chrome, private data or secrets.
The page renders the production Markdown using markdown-it and local CSS; it is
not a screenshot of a published GitHub comment. No GitHub mutation is used for
proof. The first line visibly gains `(Revision 2)`; first reviews and issue
comments remain unchanged.

| Before | After |
| --- | --- |
| ![Before revision label](https://github.com/user-attachments/assets/e952fe9b-9e73-4427-ae90-c6d72fa4e48a) | ![After revision label](https://github.com/user-attachments/assets/5d7b1375-f29b-4eae-a1d5-a73b66b8c98a) |

The accompanying `observations.json` records the emitted first lines. Update the
proof when freshness rendering or review-history counting changes. Verified with
the accompanying repair on Node 24.20.0. OpenClaw Bay has no schema or observer
change: this affects only rendered GitHub comment text.
