# Exact Azure endpoint-rejection fixture

The change admits only the maintainer-qualified synthetic URI literal in Crabbox's `TestAzureDynamicSessionsEndpointRejectsUnsafeTokenDestinations`, bound to its exact native Raw/RawV2 hashes, PLAIN decoder, full line, path, mode and committed source attribution. The test requires endpoint rejection; this is not a credential source. No detector or path exemption is introduced.

Before changing policy, scan the complete Crabbox committed range from `226db96ab9beb6988f2e8601a751dd7e19d96367` to `f0950d96ead0e2feaf1ca10285a874e5ab06cc97` through the real `scanAgentInput` staging/admission path. Trusted TruffleHog 3.97.4 uses normal verification and scan-completion checks. Baseline must refuse; candidate must admit every finding in the full range. Use an isolated environment and controlled nonsecret prompt; do not invoke a model. Raw findings stay in private evidence, while reports contain only sanitized scanner diagnostics and identity hashes.

Existing fixture mutation tests must also cover the added row: wrong value, line, path, mode, role, decoder, extra occurrence, mixed attribution, duplicate finding, verified finding and incomplete completion remain rejected. Full hosted review remains necessary because its prompt and schema are distinct inputs. No public publication is part of this preparation task.
