import { errorMessage } from './path-utils.js';

import {
  runTrialHostWitnessWorkerRequest,
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
  let response: TrialWitnessWorkerResponseEnvelope;
  try {
    response = {
      id,
      ok: true,
      response: runTrialHostWitnessWorkerRequest(request),
    };
  } catch (error) {
    response = {
      id,
      ok: false,
      error: serializeTrialWitnessWorkerError(error),
    };
  }
  self.postMessage(response);
};
