# TSA Outage Runbook (Air-gapped Incident Path)

## Scope

Use this runbook when TSA token freshness is expired and no sneakernet operator is available to import a fresh TSA token for an offline customer deployment.

## Preconditions

- Incident ticket created (`ticketId`)
- Designated operator assigned (`operatorId`)
- Customer and seat identifiers confirmed (`customerId`, `seatId`)
- License server reachable from operator environment

## Procedure

1. Confirm TSA freshness is expired from the lease issue response (`tsaState.status = "expired"`). `skillpack license issue` also prints this warning to stderr when `--last-tsa-token-at-sec` is outside the allowed window.
2. Record a manual time attestation:
   `skillpack tsa manual-attest --server-url <license-server-url> --customer-id <customerId> --seat-id <seatId> --operator-id <operatorId> --ticket-id <ticketId> --reason "<incident reason>" --attested-at-sec <unix-sec>`
3. Verify attestation persistence:
   `skillpack tsa latest-attestation --server-url <license-server-url> --customer-id <customerId> --seat-id <seatId> --ticket-id <ticketId>`
4. Re-issue the lease against the same license server with the same incident ticket identifier:
   `skillpack license issue --server-url <license-server-url> --api-key <api-key> --customer-id <customerId> --seat-id <seatId> --last-tsa-token-at-sec <unix-sec> --tsa-ticket-id <ticketId>`
   The lease issue response automatically embeds `tsaState.latestManualAttestation`.
5. Runtime calls `buildTsaPolicyFromLeaseResponse(response)` from `@skillpack/runtime` and passes the returned policy to `verifyLeaseForRuntime`. No manual injection of attestation records is required.
6. Resume customer runtime operations.

## Runtime enforcement requirements

- Runtime must reject execution when TSA freshness is expired and no manual attestation is provided.
- Runtime must reject stale or malformed manual attestation records.
- Runtime must only accept manual attestations within the configured attestation max age window. The default is 4 hours; override it through `maxManualAttestationAgeSec` when customer policy requires a different window.

## Exit criteria

- Runtime execution resumes in controlled degraded mode with manual attestation.
- Incident ticket includes attestation metadata and timestamps.
- Follow-up task is created to replace manual attestation path with fresh TSA token as soon as available.

## Deferred

- Structured TSA incident timeline storage/export is intentionally deferred until a design partner specifies the audit format.
