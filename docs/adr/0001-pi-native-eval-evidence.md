# New Eval runs freeze Pi-native evidence; old event bundles are not reinterpreted

The user approved a breaking cutover because a `turn.finished`/UniversalTelemetryEvent
bundle is not Pi history. New runs use SP's published `sp-pi-trajectory/v1` page and
immutable schema-2 manifest, saving every safe `{ingestSeq,record}` unchanged; Metrics
interprets native facts without reconstructing generation inputs. We **do not**
add a live version-1 decoder or migrate old bytes, hashes, refs, resource rows or
accepted scores. This trades historical evidence readability in new code for
non-deceptive native evidence; artifacts remain primary and charges still come
from independent usage/settlement facts. See [SP/Eval parity gate](../pi-native-eval-cutover.md)
before deploying, because the required `@springbrand/eval-harness` release is not
yet published.
