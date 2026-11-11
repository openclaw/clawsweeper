# Terminal acknowledgement fixture proof

Historical proof for `test/terminal-finalization-cancellation-workflow.test.ts`.

## Defect

The 503 case expected a rejection after four requests. The control-plane retry
helper (`scripts/control-plane-curl.sh`) actually makes six attempts with 2, 4,
8, 16 and 32 second backoffs, so the 30-second `execFile` timeout killed the
script after the fourth request. The test passed because of that timeout, not
because the workflow step failed after exhausting its retries.

## Change

The fixture server answers every request with `Retry-After: 0`, which the real
helper honors, so the unchanged workflow step and helper run all six attempts
without waiting. A non-success case must now exit with code 1, no signal and no
timeout kill. The test also checks the complete request path and body, and an
unrecognized 418 response must fail after one request. Production workflow and
helper bytes are unchanged.

## Results

Node 24.22.1, macOS arm64, `node --test test/terminal-finalization-cancellation-workflow.test.ts`:

| Version | Result | Wall time |
| --- | --- | ---: |
| Base | 7 pass, 503 case ends by timeout after 4 requests | about 31 s |
| This change | 8 pass, 503 case exits 1 after 6 requests | 2.1 s |

Control: removing only the `Retry-After: 0` header makes the 503 case fail
(`code: null`, killed by the timeout), so the stronger assertion catches the
original false pass.
