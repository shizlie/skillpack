1. ⚠️ TSA outage past 7d for air-gapped customer with no sneakernet operator — silent failure mode. Customer's self-hosted server stops issuing leases → in-field skills die at
   TTL boundary. Mitigation needed: TSA token expiry warnings emitted via license-server logs + a "manual time-attestation" CLI escape hatch for incident response. Flagging as
   1 critical gap, recommend addressing in implementation.

2. Expose the WIKI via MCP

3. Package as skill and bundle as .mcpb
