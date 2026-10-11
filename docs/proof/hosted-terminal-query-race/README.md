# Hosted terminal query race

This historical proof covered a tmux query race in the old post-review terminal
proof controller. That controller and its cleanup helper are now retired.
The standalone driver has been removed; this page is not a current runbook.

The historical claim was that an empty successful tmux query could be accepted
only after fresh matching DONE receipts and server/socket quiescence proved
controller teardown. Live servers and altered receipts still failed without an
extra kill command.

Current hosted review security regressions exercise the retained review-tree
admission owner and credential-free child in `scripts/hosted-review-scan-smoke.mjs`,
not the removed post-review terminal controller.
