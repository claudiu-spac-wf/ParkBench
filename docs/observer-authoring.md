# Observer authoring

Observer adapters implement `ready()` and `sample(context)` and use the bounded
run labels supplied by the coordinator. New adapters must declare a version,
source identifiers, health behavior, and completeness semantics.

The licensed run observer image exposes the native adapter boundary on port 9100.
The database adapter executes the operator-supplied read-only ABL/VST procedure
without a shell and accepts only finite numeric values with declared
`counter`, `gauge`, or `info` types. A PAS adapter reads
`GET /oemanager/applications/{instance}/metrics` from every configured PAS target
with the run-time credential reference. The default instance is `oepas1` and can
be changed with `PARKBENCH_PAS_INSTANCE`. The observer exposes `/metrics`, `/health`, and
`/application-health` for readiness; raw credentials and responses are never
written to artifacts.

Credential references use the form `credential:<identifier>`. The corresponding
secret is supplied at runtime as `PARKBENCH_CREDENTIAL_<IDENTIFIER>` or through
`PARKBENCH_CREDENTIAL_FILE_<IDENTIFIER>`; these values must not be committed.

## Versioned extensions

Custom observer kinds use the form `name_vN` and are registered when the
control-plane platform is created. The registration is used for required
observer compatibility checks and for every normal lifecycle stage:

```ts
createPlatform(config, {
  observerExtensions: [
    {
      kind: "cache_v1",
      factory: (declaration, context) => new CacheObserver(declaration, context)
    }
  ]
});
```

An extension must return an adapter with `ready()` and `sample(context)`;
samples must carry the coordinator's run, experiment, variant, repetition, and
phase labels. Required extensions that are not registered fail preflight before
any run-owned resources are created. Optional extensions remain visible in
completeness and diagnostics when unavailable.

## Readable database collector (feature 017)

`openedge/observers/db/parkbench-db-observer-v2.p` has one internal procedure for each of its 14 VSTs. Each procedure owns its static traversal, selected fields, filters and labels. The shared `addField` helper converts one explicitly named field on a statically bound buffer and checks optional field availability. It does not traverse sources. Every metric field has a nearby comment explaining its raw meaning and units; preserve these comments when changing a field. Some legacy metric names differ from raw vendor terminology, which is documented without changing mappings.

Both modes initialize invocation-local metadata caches before collection. `ttFile` explicitly defines original RECID, table number/name/type; `ttIndex` defines index number/name/original owner RECID. Startup copies these required values from every accessible row, including internal metadata. Use `ttFile.sourceRecid` for ownership, never `RECID(ttFile)`. Later labels/enrichment read only the caches. Tables have no name cap; selected sorted index labels retain the 256 limit. A new invocation refreshes metadata.

The filename v2 preserves normal protocol **3**, the 81-entry catalog and `openedge-db-parameter-capture.v1`. The original source remains as the comparison baseline. `PB_HAS_*` flags remove absent static source bodies at compilation; schema preparation sets these from the connected metaschema, not patch guesses. Optional fields are checked at their explicit uses.

Licensed builds use `/app/openedge/observers/db/parkbench-db-observer-v2.r`. The raw image uses `/app/openedge/observers/db/prepare-run-db-observer.p`, which profiles and compiles only the packaged v2 source in private UUID files, preserves collection mode, and cleans its files. Procedure approval is a finite list; external sources still undergo existing file/read-only checks. Tests use disposable owned native databases and test-only bindings, with no production fixture mode.
