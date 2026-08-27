export const OPENCODE_QUESTION_CONFORMANCE_PROVIDER_ID = 'tagma-question-conformance';
export const OPENCODE_QUESTION_CONFORMANCE_MODEL_ID = 'question-model';
export const OPENCODE_CLASSIFIER_CONFORMANCE_SYSTEM =
  'Tagma classifier conformance: classify without tools and return only the supplied schema.';
export const OPENCODE_CLASSIFIER_CONFORMANCE_MARKER = 'Tagma classifier conformance request';
export const OPENCODE_STRUCTURED_OUTPUT_TOOL_ID = 'StructuredOutput';
export const OPENCODE_CLASSIFIER_CONFORMANCE_RESULT = { kind: 'discussion' } as const;

export const OPENCODE_QUESTION_CONFORMANCE_QUESTIONS = [
  {
    question: 'Which conformance option should be selected?',
    header: 'Conformance',
    options: [
      { label: 'Alpha', description: 'Select the alpha path.' },
      { label: 'Beta', description: 'Select the beta path.' },
    ],
    multiple: false,
  },
];

type ProviderTransport = 'chat-completions' | 'responses' | 'models' | 'unknown';
type ProviderBehavior = 'question' | 'tool-result' | 'classifier';

export interface FakeProviderDiagnostic {
  method: string;
  path: string;
  transport: ProviderTransport;
  stream: boolean | null;
  toolCount: number | null;
  inputShape: 'messages' | 'input' | 'none';
  turnShape: ProviderBehavior | 'unknown';
  status: number;
  structuredFormat?: boolean;
  formatShape?: 'json-schema' | 'json-object' | 'text' | 'none' | 'other';
  classifierMarkerObserved?: boolean;
  structuredOutputToolOffered?: boolean;
  classifierResultKind?: 'discussion';
  expectedAnswerObserved?: boolean;
  toolResultDisposition?:
    'answer' | 'permission-denied' | 'invalid-input' | 'interrupted' | 'other';
}

export interface OpencodeV2FakeProvider {
  baseUrl: string;
  diagnostics(): readonly FakeProviderDiagnostic[];
  stop(): Promise<void>;
}

type JsonObject = Record<string, unknown>;

const MAX_DIAGNOSTICS = 12;

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonResponse(value: unknown, status = 200): Response {
  return Response.json(value, { status });
}

function sseResponse(events: readonly unknown[]): Response {
  const body = events
    .map((event) =>
      event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
  return new Response(body, {
    headers: {
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'content-type': 'text/event-stream',
    },
  });
}

function requestToolName(body: JsonObject, transport: ProviderTransport): string | null {
  if (!Array.isArray(body.tools)) return null;
  for (const value of body.tools) {
    if (!isObject(value)) continue;
    if (transport === 'chat-completions') {
      const fn = value.function;
      if (isObject(fn) && fn.name === 'question') return 'question';
      continue;
    }
    if (value.name === 'question') return 'question';
    const fn = value.function;
    if (isObject(fn) && fn.name === 'question') return 'question';
  }
  return null;
}

function hasStructuredOutputTool(body: JsonObject, transport: ProviderTransport): boolean {
  if (!Array.isArray(body.tools)) return false;
  return body.tools.some((value) => {
    if (!isObject(value)) return false;
    if (transport === 'chat-completions') {
      return isObject(value.function) && value.function.name === OPENCODE_STRUCTURED_OUTPUT_TOOL_ID;
    }
    return (
      value.name === OPENCODE_STRUCTURED_OUTPUT_TOOL_ID ||
      (isObject(value.function) && value.function.name === OPENCODE_STRUCTURED_OUTPUT_TOOL_ID)
    );
  });
}

function isToolResultTurn(body: JsonObject, transport: ProviderTransport): boolean {
  if (transport === 'chat-completions') {
    return (
      Array.isArray(body.messages) &&
      body.messages.some((message) => isObject(message) && message.role === 'tool')
    );
  }
  return (
    Array.isArray(body.input) &&
    body.input.some((item) => isObject(item) && item.type === 'function_call_output')
  );
}

function structuredFormatShape(
  body: JsonObject,
  transport: ProviderTransport,
): NonNullable<FakeProviderDiagnostic['formatShape']> {
  let value: unknown;
  if (transport === 'chat-completions') {
    value = isObject(body.response_format) ? body.response_format.type : undefined;
  } else {
    value = isObject(body.text) && isObject(body.text.format) ? body.text.format.type : undefined;
  }
  if (value === undefined) return 'none';
  if (value === 'json_schema') return 'json-schema';
  if (value === 'json_object') return 'json-object';
  if (value === 'text') return 'text';
  return 'other';
}

function hasClassifierMarker(body: JsonObject): boolean {
  const modelInput = JSON.stringify({
    instructions: body.instructions,
    messages: body.messages,
    input: body.input,
  });
  return (
    modelInput.includes(OPENCODE_CLASSIFIER_CONFORMANCE_SYSTEM) &&
    modelInput.includes(OPENCODE_CLASSIFIER_CONFORMANCE_MARKER)
  );
}

function toolResultSummary(
  body: JsonObject,
  transport: ProviderTransport,
): Pick<FakeProviderDiagnostic, 'expectedAnswerObserved' | 'toolResultDisposition'> {
  const outputs =
    transport === 'chat-completions'
      ? Array.isArray(body.messages)
        ? body.messages
            .filter((message) => isObject(message) && message.role === 'tool')
            .map((message) => (message as JsonObject).content)
        : []
      : Array.isArray(body.input)
        ? body.input
            .filter((item) => isObject(item) && item.type === 'function_call_output')
            .map((item) => (item as JsonObject).output)
        : [];
  // Reduce the model-facing tool payload to a bounded category. Diagnostics never
  // retain or expose the answer text or any other captured request bytes.
  const sanitized = outputs.map((output) => JSON.stringify(output)).join(' ');
  if (sanitized.includes('Alpha')) {
    return { expectedAnswerObserved: true, toolResultDisposition: 'answer' };
  }
  if (sanitized.includes('Permission denied')) {
    return { expectedAnswerObserved: false, toolResultDisposition: 'permission-denied' };
  }
  if (sanitized.includes('Invalid tool input')) {
    return { expectedAnswerObserved: false, toolResultDisposition: 'invalid-input' };
  }
  if (sanitized.includes('interrupted')) {
    return { expectedAnswerObserved: false, toolResultDisposition: 'interrupted' };
  }
  return { expectedAnswerObserved: false, toolResultDisposition: 'other' };
}

function chatCompletionResponse(
  body: JsonObject,
  sequence: number,
  behavior: ProviderBehavior,
): Response {
  const id = `chatcmpl-tagma-${sequence}`;
  const model =
    typeof body.model === 'string' ? body.model : OPENCODE_QUESTION_CONFORMANCE_MODEL_ID;
  const created = 1_700_000_000 + sequence;
  const usage = {
    prompt_tokens: 8,
    completion_tokens: 4,
    total_tokens: 12,
  };

  if (behavior === 'classifier' && hasStructuredOutputTool(body, 'chat-completions')) {
    const callID = `call_tagma_classifier_${sequence}`;
    const argumentsJson = JSON.stringify(OPENCODE_CLASSIFIER_CONFORMANCE_RESULT);
    if (body.stream === true) {
      return sseResponse([
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [
            {
              index: 0,
              delta: {
                role: 'assistant',
                tool_calls: [
                  {
                    index: 0,
                    id: callID,
                    type: 'function',
                    function: {
                      name: OPENCODE_STRUCTURED_OUTPUT_TOOL_ID,
                      arguments: argumentsJson,
                    },
                  },
                ],
              },
              finish_reason: null,
            },
          ],
        },
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
        },
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage,
        },
        '[DONE]',
      ]);
    }
    return jsonResponse({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: {
            role: 'assistant',
            content: null,
            tool_calls: [
              {
                id: callID,
                type: 'function',
                function: {
                  name: OPENCODE_STRUCTURED_OUTPUT_TOOL_ID,
                  arguments: argumentsJson,
                },
              },
            ],
          },
          finish_reason: 'tool_calls',
        },
      ],
      usage,
    });
  }

  if (behavior !== 'question') {
    const content = behavior === 'classifier' ? '{"kind":"discussion"}' : 'Recorded.';
    if (body.stream === true) {
      return sseResponse([
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: { role: 'assistant', content }, finish_reason: null }],
        },
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
        },
        {
          id,
          object: 'chat.completion.chunk',
          created,
          model,
          choices: [],
          usage,
        },
        '[DONE]',
      ]);
    }
    return jsonResponse({
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: 'assistant', content },
          finish_reason: 'stop',
        },
      ],
      usage,
    });
  }

  const callID = `call_tagma_question_${sequence}`;
  const argumentsJson = JSON.stringify({ questions: OPENCODE_QUESTION_CONFORMANCE_QUESTIONS });
  if (body.stream === true) {
    return sseResponse([
      {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [
          {
            index: 0,
            delta: {
              role: 'assistant',
              tool_calls: [
                {
                  index: 0,
                  id: callID,
                  type: 'function',
                  function: { name: 'question', arguments: argumentsJson },
                },
              ],
            },
            finish_reason: null,
          },
        ],
      },
      {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      },
      {
        id,
        object: 'chat.completion.chunk',
        created,
        model,
        choices: [],
        usage,
      },
      '[DONE]',
    ]);
  }
  return jsonResponse({
    id,
    object: 'chat.completion',
    created,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: 'assistant',
          content: null,
          tool_calls: [
            {
              id: callID,
              type: 'function',
              function: { name: 'question', arguments: argumentsJson },
            },
          ],
        },
        finish_reason: 'tool_calls',
      },
    ],
    usage,
  });
}

function responsesApiResponse(
  body: JsonObject,
  sequence: number,
  behavior: ProviderBehavior,
): Response {
  const responseID = `resp_tagma_${sequence}`;
  const model =
    typeof body.model === 'string' ? body.model : OPENCODE_QUESTION_CONFORMANCE_MODEL_ID;
  const createdAt = 1_700_000_000 + sequence;
  const usage = {
    input_tokens: 8,
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: 4,
    output_tokens_details: { reasoning_tokens: 0 },
    total_tokens: 12,
  };

  if (behavior === 'classifier' && hasStructuredOutputTool(body, 'responses')) {
    const callID = `call_tagma_classifier_${sequence}`;
    const itemID = `fc_tagma_classifier_${sequence}`;
    const argumentsJson = JSON.stringify(OPENCODE_CLASSIFIER_CONFORMANCE_RESULT);
    const item = {
      id: itemID,
      type: 'function_call',
      status: 'completed',
      arguments: argumentsJson,
      call_id: callID,
      name: OPENCODE_STRUCTURED_OUTPUT_TOOL_ID,
    };
    const completed = {
      id: responseID,
      object: 'response',
      created_at: createdAt,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model,
      output: [item],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: true,
      temperature: 1,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: 1,
      truncation: 'disabled',
      usage,
      user: null,
      metadata: {},
    };
    if (body.stream !== true) return jsonResponse(completed);
    return sseResponse([
      {
        type: 'response.created',
        response: { ...completed, status: 'in_progress', output: [] },
        sequence_number: 0,
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', arguments: '' },
        sequence_number: 1,
      },
      {
        type: 'response.function_call_arguments.delta',
        item_id: itemID,
        output_index: 0,
        delta: argumentsJson,
        sequence_number: 2,
      },
      {
        type: 'response.function_call_arguments.done',
        item_id: itemID,
        output_index: 0,
        arguments: argumentsJson,
        sequence_number: 3,
      },
      { type: 'response.output_item.done', output_index: 0, item, sequence_number: 4 },
      { type: 'response.completed', response: completed, sequence_number: 5 },
      '[DONE]',
    ]);
  }

  if (behavior !== 'question') {
    const content = behavior === 'classifier' ? '{"kind":"discussion"}' : 'Recorded.';
    const item = {
      id: `msg_tagma_${sequence}`,
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [{ type: 'output_text', text: content, annotations: [] }],
    };
    const completed = {
      id: responseID,
      object: 'response',
      created_at: createdAt,
      status: 'completed',
      error: null,
      incomplete_details: null,
      instructions: null,
      max_output_tokens: null,
      model,
      output: [item],
      parallel_tool_calls: true,
      previous_response_id: null,
      reasoning: { effort: null, summary: null },
      store: true,
      temperature: 1,
      text: { format: { type: 'text' } },
      tool_choice: 'auto',
      tools: [],
      top_p: 1,
      truncation: 'disabled',
      usage,
      user: null,
      metadata: {},
    };
    if (body.stream !== true) return jsonResponse(completed);
    return sseResponse([
      {
        type: 'response.created',
        response: { ...completed, status: 'in_progress', output: [] },
        sequence_number: 0,
      },
      {
        type: 'response.output_item.added',
        output_index: 0,
        item: { ...item, status: 'in_progress', content: [] },
        sequence_number: 1,
      },
      {
        type: 'response.content_part.added',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: { type: 'output_text', text: '', annotations: [] },
        sequence_number: 2,
      },
      {
        type: 'response.output_text.delta',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        delta: content,
        sequence_number: 3,
      },
      {
        type: 'response.output_text.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        text: content,
        sequence_number: 4,
      },
      {
        type: 'response.content_part.done',
        item_id: item.id,
        output_index: 0,
        content_index: 0,
        part: item.content[0],
        sequence_number: 5,
      },
      { type: 'response.output_item.done', output_index: 0, item, sequence_number: 6 },
      { type: 'response.completed', response: completed, sequence_number: 7 },
      '[DONE]',
    ]);
  }

  const callID = `call_tagma_question_${sequence}`;
  const itemID = `fc_tagma_${sequence}`;
  const argumentsJson = JSON.stringify({ questions: OPENCODE_QUESTION_CONFORMANCE_QUESTIONS });
  const item = {
    id: itemID,
    type: 'function_call',
    status: 'completed',
    arguments: argumentsJson,
    call_id: callID,
    name: 'question',
  };
  const completed = {
    id: responseID,
    object: 'response',
    created_at: createdAt,
    status: 'completed',
    error: null,
    incomplete_details: null,
    instructions: null,
    max_output_tokens: null,
    model,
    output: [item],
    parallel_tool_calls: true,
    previous_response_id: null,
    reasoning: { effort: null, summary: null },
    store: true,
    temperature: 1,
    text: { format: { type: 'text' } },
    tool_choice: 'auto',
    tools: [],
    top_p: 1,
    truncation: 'disabled',
    usage,
    user: null,
    metadata: {},
  };
  if (body.stream !== true) return jsonResponse(completed);
  return sseResponse([
    {
      type: 'response.created',
      response: { ...completed, status: 'in_progress', output: [] },
      sequence_number: 0,
    },
    {
      type: 'response.output_item.added',
      output_index: 0,
      item: { ...item, status: 'in_progress', arguments: '' },
      sequence_number: 1,
    },
    {
      type: 'response.function_call_arguments.delta',
      item_id: itemID,
      output_index: 0,
      delta: argumentsJson,
      sequence_number: 2,
    },
    {
      type: 'response.function_call_arguments.done',
      item_id: itemID,
      output_index: 0,
      arguments: argumentsJson,
      sequence_number: 3,
    },
    { type: 'response.output_item.done', output_index: 0, item, sequence_number: 4 },
    { type: 'response.completed', response: completed, sequence_number: 5 },
    '[DONE]',
  ]);
}

export function startOpencodeV2FakeProvider(): OpencodeV2FakeProvider {
  const diagnostics: FakeProviderDiagnostic[] = [];
  let sequence = 0;
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request): Promise<Response> {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const transport: ProviderTransport = url.pathname.endsWith('/chat/completions')
        ? 'chat-completions'
        : url.pathname.endsWith('/responses')
          ? 'responses'
          : url.pathname.endsWith('/models')
            ? 'models'
            : 'unknown';

      if (method === 'GET' && transport === 'models') {
        diagnostics.push({
          method,
          path: url.pathname,
          transport,
          stream: null,
          toolCount: null,
          inputShape: 'none',
          turnShape: 'unknown',
          status: 200,
        });
        diagnostics.splice(0, Math.max(0, diagnostics.length - MAX_DIAGNOSTICS));
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: OPENCODE_QUESTION_CONFORMANCE_MODEL_ID,
              object: 'model',
              created: 1_700_000_000,
              owned_by: 'tagma-conformance',
            },
          ],
        });
      }

      if (method !== 'POST' || (transport !== 'chat-completions' && transport !== 'responses')) {
        diagnostics.push({
          method,
          path: url.pathname,
          transport,
          stream: null,
          toolCount: null,
          inputShape: 'none',
          turnShape: 'unknown',
          status: 404,
        });
        diagnostics.splice(0, Math.max(0, diagnostics.length - MAX_DIAGNOSTICS));
        return jsonResponse({ error: { message: 'unsupported fake-provider route' } }, 404);
      }

      let body: JsonObject;
      try {
        const parsed = await request.json();
        if (!isObject(parsed)) throw new Error('request body is not an object');
        body = parsed;
      } catch {
        diagnostics.push({
          method,
          path: url.pathname,
          transport,
          stream: null,
          toolCount: null,
          inputShape: 'none',
          turnShape: 'unknown',
          status: 400,
        });
        diagnostics.splice(0, Math.max(0, diagnostics.length - MAX_DIAGNOSTICS));
        return jsonResponse({ error: { message: 'invalid fake-provider request shape' } }, 400);
      }

      const toolResult = isToolResultTurn(body, transport);
      const formatShape = structuredFormatShape(body, transport);
      const classifierMarker = hasClassifierMarker(body);
      const structuredOutputTool = hasStructuredOutputTool(body, transport);
      const classifier =
        classifierMarker || formatShape === 'json-schema' || formatShape === 'json-object';
      const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
      const inputShape = Array.isArray(body.messages)
        ? 'messages'
        : Array.isArray(body.input)
          ? 'input'
          : 'none';
      const hasQuestionTool = requestToolName(body, transport) === 'question';
      const status = toolResult || classifier || hasQuestionTool ? 200 : 422;
      const behavior: ProviderBehavior | null = toolResult
        ? 'tool-result'
        : classifier
          ? 'classifier'
          : hasQuestionTool
            ? 'question'
            : null;
      diagnostics.push({
        method,
        path: url.pathname,
        transport,
        stream: body.stream === true,
        toolCount,
        inputShape,
        turnShape: behavior ?? 'unknown',
        status,
        structuredFormat: formatShape === 'json-schema' || formatShape === 'json-object',
        formatShape,
        classifierMarkerObserved: classifierMarker,
        structuredOutputToolOffered: structuredOutputTool,
        ...(behavior === 'classifier' ? { classifierResultKind: 'discussion' as const } : {}),
        ...(toolResult ? toolResultSummary(body, transport) : {}),
      });
      diagnostics.splice(0, Math.max(0, diagnostics.length - MAX_DIAGNOSTICS));

      if (!behavior) {
        return jsonResponse({ error: { message: 'question tool was not offered' } }, 422);
      }

      sequence += 1;
      return transport === 'chat-completions'
        ? chatCompletionResponse(body, sequence, behavior)
        : responsesApiResponse(body, sequence, behavior);
    },
  });

  return {
    baseUrl: new URL('/v1', server.url).toString().replace(/\/$/, ''),
    diagnostics: () => diagnostics.map((entry) => ({ ...entry })),
    async stop(): Promise<void> {
      await server.stop(true);
    },
  };
}
