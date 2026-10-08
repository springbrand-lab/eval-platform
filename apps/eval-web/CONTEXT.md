# Web Context

`eval-web` is the internal evaluation console.

It will select Project, Dataset, Sample, Subject Agent, Evaluation Agent,
sample count, execution concurrency and evaluation concurrency, then display produced artifacts, evaluation
results, metrics and Evaluation Agent evidence.

It consumes the API and package public contracts. It does not connect directly
to SP Durable Objects or reconstruct trajectory facts from UI state.
