# Production snapshot and release gate

This branch reconciles accumulated production fixes from the verified content-r22 runtime with the installed release-hardening tools. It is a draft review of a large historical delta; independent review remains required. Unfinished native MySQL workspace adapters are excluded. Existing main is not reset, and this workflow does not deploy.

The deployed isolated candidate passed 25 regression files and desktop/mobile generated-content checks. The workflow builds a pinned test image, runs synthetic browser/OCR, dependency and isolated MySQL OAuth/job gates, then compares an independent clean build. Hosted results are required before considering this branch ready.

Runtime source is copied from the actual deployed image. Secrets, environment files, runtime databases, customer exports/assets and logs are excluded. Original server checkout and recovery sets remain intact. Existing CRLF/trailing-whitespace findings are recorded separately; runtime bytes are preserved.

Required private-repository branch protection is currently unavailable on the GitHub plan (API 403). Dedicated external provider tests and the full native MySQL rollout remain unfinished. No customer migration, financial changes or deployment is performed by this PR.
