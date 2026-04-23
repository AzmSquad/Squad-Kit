/** Canned provider API response bodies for adapter tests. */

export const anthropicMixedContentResponse = {
  content: [
    { type: 'text', text: 'Here is the plan.' },
    {
      type: 'tool_use',
      id: 'toolu_01',
      name: 'read_file',
      input: { path: 'src/a.ts' },
    },
  ],
  stop_reason: 'tool_use',
  usage: { input_tokens: 100, output_tokens: 50 },
};

export const anthropicEndTurnResponse = {
  content: [{ type: 'text', text: 'Done.' }],
  stop_reason: 'end_turn',
  usage: { input_tokens: 10, output_tokens: 5 },
};

export const openaiToolCallsResponse = {
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          {
            id: 'call_1',
            type: 'function',
            function: { name: 'read_file', arguments: '{"path":"b.ts"}' },
          },
        ],
      },
      finish_reason: 'tool_calls',
    },
  ],
  usage: { prompt_tokens: 20, completion_tokens: 10 },
};

export const openaiLengthResponse = {
  choices: [
    {
      message: { content: 'partial' },
      finish_reason: 'length',
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 2 },
};

export const googleFunctionCallResponse = {
  candidates: [
    {
      content: {
        parts: [{ functionCall: { name: 'read_file', args: { path: 'c.ts' } } }],
      },
      finishReason: 'STOP',
    },
  ],
  usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 15 },
};
