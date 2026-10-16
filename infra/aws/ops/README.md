# One-time refresh of disposable Eval test inputs

Authorized scope: stop unfinished Eval Runs, soft-delete existing Projects, Datasets/Data,
Material/Session Bundles and output schemas through the public Eval HTTP API, and upload the
current `fixtures/eval-demo/seed.mjs` inputs. Agent definitions, service accounts and infrastructure
are outside this operation. It creates no Project or Run and makes no model call.

The EC2 wrapper first checks the deployed image and the shared API/Worker Bundle mount. It
quiesces Runs, creates a PostgreSQL dump and a Bundle archive, verifies both backups, then applies
the captured inventory only while its identities still match. It uploads and verifies the fixture
twice, including all 13 file byte reads, and compares new Bundle manifests through both containers.

The manually dispatched workflow uses the existing main-branch GitHub OIDC role and SSM instance
target. No credential is returned to GitHub logs. This one-time workflow and its helpers are removed
after the operation succeeds; the backup stays under `/opt/eval-platform/production/backups`.
