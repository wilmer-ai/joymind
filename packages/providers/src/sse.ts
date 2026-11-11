export interface SseEvent {
  event: string;
  data: string;
}

interface ParsedLine {
  line: string;
  rest: string;
}

function takeLine(buffer: string, atEof = false): ParsedLine | undefined {
  for (let index = 0; index < buffer.length; index += 1) {
    const character = buffer[index];
    if (character === '\n') {
      return { line: buffer.slice(0, index), rest: buffer.slice(index + 1) };
    }
    if (character === '\r') {
      if (index + 1 === buffer.length && !atEof) return undefined;
      const nextIndex = buffer[index + 1] === '\n' ? index + 2 : index + 1;
      return { line: buffer.slice(0, index), rest: buffer.slice(nextIndex) };
    }
  }
  if (atEof && buffer.length > 0) return { line: buffer, rest: '' };
  return undefined;
}

export async function* parseSse(body: ReadableStream<Uint8Array>): AsyncIterable<SseEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let dataLines: string[] = [];
  let eventName = 'message';

  const processLine = (line: string): SseEvent | undefined => {
    if (line === '') {
      if (dataLines.length === 0) {
        eventName = 'message';
        return undefined;
      }
      const event = { event: eventName, data: dataLines.join('\n') };
      dataLines = [];
      eventName = 'message';
      return event;
    }
    if (line.startsWith(':')) return undefined;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'data') dataLines.push(value);
    if (field === 'event') eventName = value;
    return undefined;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let parsed = takeLine(buffer);
      while (parsed) {
        buffer = parsed.rest;
        const event = processLine(parsed.line);
        if (event) yield event;
        parsed = takeLine(buffer);
      }
    }

    buffer += decoder.decode();
    let parsed = takeLine(buffer, true);
    while (parsed) {
      buffer = parsed.rest;
      const event = processLine(parsed.line);
      if (event) yield event;
      parsed = takeLine(buffer, true);
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      // The stream may already be closed or errored.
    }
  }
}
