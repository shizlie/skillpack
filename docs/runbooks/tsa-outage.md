# TSA Outage Runbook (Air-gapped Incident Path)

## Scope

Use this runbook when TSA token freshness is expired and no sneakernet operator is available to import a fresh TSA token for an offline customer deployment.

## Preconditions

- Incident ticket created (`ticketId`)
- Designated operator assigned (`operatorId`)
- Customer and seat identifiers confirmed (`customerId`, `seatId`)
- License server reachable from operator environment

## Procedure

1. Confirm TSA freshness is expired from lease issue response (`tsaState.status = "expired"`).
2. Record a manual time attestation:
   `skillpack tsa manual-attest --server-url <license-server-url> --customer-id <customerId> --seat-id <seatId> --operator-id <operatorId> --ticket-id <ticketId> --reason "<incident reason>" --attested-at-sec <unix-sec>`
3. Verify attestation persistence:
   `skillpack tsa latest-attestation --server-url <license-server-url> --customer-id <customerId> --seat-id <seatId>`
4. Inject the returned attestation record into runtime policy config for the affected runtime execution.
5. Resume customer runtime operations.

## Runtime enforcement requirements

- Runtime must reject execution when TSA freshness is expired and no manual attestation is provided.
- Runtime must reject stale or malformed manual attestation records.
- Runtime must only accept manual attestations within the configured attestation max age window.

## Exit criteria

- Runtime execution resumes in controlled degraded mode with manual attestation.
- Incident ticket includes attestation metadata and timestamps.
- Follow-up task is created to replace manual attestation path with fresh TSA token as soon as available.
