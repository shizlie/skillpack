import {
  evaluateTsaTokenFreshness,
  validateManualTimeAttestation,
} from "@skillpack/protocol";

export function createTsaMonitor({
  maxTokenAgeSec,
  warningWindowSec,
  onWarning = () => {},
} = {}) {
  return {
    evaluate({ lastTsaTokenAtSec, nowSec }) {
      const state = evaluateTsaTokenFreshness(lastTsaTokenAtSec, nowSec, {
        maxTokenAgeSec,
        warningWindowSec,
      });
      if (state.status === "warning" || state.status === "expired") {
        onWarning({
          code:
            state.status === "warning"
              ? "tsa_token_expiring_soon"
              : "tsa_token_expired",
          ...state,
        });
      }
      return state;
    },
  };
}

export function createManualTimeAttestationContract({
  nowSec = () => Math.floor(Date.now() / 1000),
} = {}) {
  return {
    commandName: "skillpack tsa manual-attest",
    requiredFields: ["operatorId", "ticketId", "reason", "attestedAtSec"],
    validate(input) {
      return validateManualTimeAttestation(input);
    },
    createRecord(input) {
      const valid = validateManualTimeAttestation(input);
      return {
        ...valid,
        recordedAtSec: nowSec(),
        source: "manual-time-attestation",
      };
    },
  };
}
