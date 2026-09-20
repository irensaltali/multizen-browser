import type { Env } from "./env.js";
import { authenticate } from "./auth.js";
import { ApiError, ErrorCode, errorResponse, jsonResponse } from "./errors.js";
import {
  optionalLeaseTtlMs,
  parseJsonBody,
  validateDeviceId,
  validateFencingToken,
  validateLeaseId,
  validateOperationId,
  validateProfileId,
  validateRevision,
  validateSnapshotId,
} from "./validation.js";
import { ProfileCoordinator, type CoordinatorResult } from "./profile-coordinator.js";

export { ProfileCoordinator };

/**
 * Deterministic DO routing: `idFromName(profileId)` always maps a given
 * profile id to the same Durable Object instance, so all coordination for a
 * profile is serialized on one object regardless of which edge handled it.
 */
function coordinatorFor(env: Env, profileId: string): DurableObjectStub<ProfileCoordinator> {
  const id = env.PROFILE_COORDINATOR.idFromName(profileId);
  return env.PROFILE_COORDINATOR.get(id) as DurableObjectStub<ProfileCoordinator>;
}

/** Translate a coordinator envelope into a deterministic HTTP response. */
function respond<T>(result: CoordinatorResult<T>): Response {
  if (result.ok) return jsonResponse(result.value, result.status);
  return errorResponse(result.error.code, result.error.message, result.error.details);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof ApiError) return err.toResponse();
      return errorResponse(ErrorCode.INTERNAL, "internal error");
    }
  },
} satisfies ExportedHandler<Env>;

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const segments = url.pathname.split("/").filter(Boolean);

  // GET /health — unauthenticated liveness probe.
  if (segments.length === 1 && segments[0] === "health") {
    if (request.method !== "GET") {
      return errorResponse(ErrorCode.METHOD_NOT_ALLOWED, "GET only");
    }
    return jsonResponse({ status: "ok", service: "multizen-sync-backend" });
  }

  // All /v1/** routes require Cloudflare Access.
  if (segments[0] === "v1") {
    const identity = await authenticate(request, env);

    // /v1/profiles/:id            -> GET current state
    // /v1/profiles/:id/acquire    -> POST
    // /v1/profiles/:id/renew      -> POST
    // /v1/profiles/:id/publish    -> POST
    // /v1/profiles/:id/release    -> POST
    if (segments[1] === "profiles" && segments[2]) {
      let decodedProfileId: string;
      try {
        decodedProfileId = decodeURIComponent(segments[2]);
      } catch {
        // Malformed percent-encoding (e.g. a lone `%`) must not surface as an
        // opaque 500; treat it as a validation failure like any other bad id.
        return errorResponse(ErrorCode.VALIDATION_FAILED, "profileId is not valid URL-encoding", {
          field: "profileId",
        });
      }
      const profileId = validateProfileId(decodedProfileId);
      const action = segments[3];
      const stub = coordinatorFor(env, profileId);

      if (!action) {
        if (request.method !== "GET") {
          return errorResponse(ErrorCode.METHOD_NOT_ALLOWED, "GET only");
        }
        return respond(await stub.getState(profileId));
      }

      if (request.method !== "POST") {
        return errorResponse(ErrorCode.METHOD_NOT_ALLOWED, "POST only");
      }
      const body = await parseJsonBody(request);

      switch (action) {
        case "acquire": {
          const deviceId = validateDeviceId(body.deviceId);
          const operationId = validateOperationId(body.operationId);
          const leaseTtlMs = optionalLeaseTtlMs(body.leaseTtlMs);
          return respond(await stub.acquire({ profileId, deviceId, operationId, leaseTtlMs, identity }));
        }
        case "renew": {
          const deviceId = validateDeviceId(body.deviceId);
          const leaseId = validateLeaseId(body.leaseId);
          const fencingToken = validateFencingToken(body.fencingToken);
          const operationId = validateOperationId(body.operationId);
          const leaseTtlMs = optionalLeaseTtlMs(body.leaseTtlMs);
          return respond(
            await stub.renew({ profileId, deviceId, leaseId, fencingToken, operationId, leaseTtlMs, identity }),
          );
        }
        case "publish": {
          const deviceId = validateDeviceId(body.deviceId);
          const leaseId = validateLeaseId(body.leaseId);
          const fencingToken = validateFencingToken(body.fencingToken);
          const operationId = validateOperationId(body.operationId);
          const expectedRevision = validateRevision(body.expectedRevision, "expectedRevision");
          const latestSnapshotId = validateSnapshotId(body.latestSnapshotId);
          return respond(
            await stub.publish({
              profileId,
              deviceId,
              leaseId,
              fencingToken,
              operationId,
              expectedRevision,
              latestSnapshotId,
              identity,
            }),
          );
        }
        case "release": {
          const deviceId = validateDeviceId(body.deviceId);
          const leaseId = validateLeaseId(body.leaseId);
          const fencingToken = validateFencingToken(body.fencingToken);
          const operationId = validateOperationId(body.operationId);
          return respond(await stub.release({ profileId, deviceId, leaseId, fencingToken, operationId, identity }));
        }
        default:
          return errorResponse(ErrorCode.NOT_FOUND, "unknown profile action", { action });
      }
    }
  }

  return errorResponse(ErrorCode.NOT_FOUND, "not found", { path: url.pathname });
}
