import { errorMessage } from './path-utils.js';

import {
  captureTrialHostWitnessForRoot,
  captureTrialWorkspaceWitnessForRoot,
  type TrialHostWorkspaceManifestCache,
  type TrialHostWitnessWorkerRequest,
  type TrialHostWitnessWorkerResponse,
} from './chat-pipeline-trial-witness.js';

interface TrialWitnessWorkerRequestEnvelope {
  id: number;
  request: TrialHostWitnessWorkerRequest;
}

interface SerializedTrialWitnessWorkerError {
  message: string;
  name?: string;
  stack?: string;
}

interface TrialWitnessWorkerResponseEnvelope {
  id: number;
  ok: boolean;
  response?: TrialHostWitnessWorkerResponse;
  error?: SerializedTrialWitnessWorkerError;
}

let currentWorkspaceRoot: string | null = null;
let currentCache: TrialHostWorkspaceManifestCache | null = null;

function serializeTrialWitnessWorkerError(error: unknown): SerializedTrialWitnessWorkerError {
  if (error instanceof Error) {
    return {
      message: error.message,
      name: error.name,
      stack: error.stack,
    };
  }
  return { message: errorMessage(error) };
}

self.onmessage = (event: MessageEvent<TrialWitnessWorkerRequestEnvelope>) => {
  const { id, request } = event.data;
  if (currentWorkspaceRoot !== request.workspaceRoot) {
    currentWorkspaceRoot = request.workspaceRoot;
    currentCache = null;
  }
  let response: TrialWitnessWorkerResponseEnvelope;
  try {
    if (request.kind === 'workspace') {
      const result = captureTrialWorkspaceWitnessForRoot(request.workspaceRoot, currentCache);
      currentCache = result.cache;
      response = {
        id,
        ok: true,
        response: {
          kind: 'workspace',
          witness: result.witness,
          cacheStats: result.cache.lastStats,
        },
      };
    } else {
      const result = captureTrialHostWitnessForRoot(
        request.workspaceRoot,
        request.prepared,
        currentCache,
      );
      currentCache = result.cache;
      response = {
        id,
        ok: true,
        response: {
          kind: 'host',
          witness: result.witness,
          cacheStats: result.cache.lastStats,
        },
      };
    }
  } catch (error) {
    response = {
      id,
      ok: false,
      error: serializeTrialWitnessWorkerError(error),
    };
    currentCache = null;
  }
  self.postMessage(response);
};
