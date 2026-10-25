// JSON with comments (JSONC) for host settings files. readJsonc parses to a
// tree that records each node's source span, so an edit can splice text in
// or out and leave the comments and layout elsewhere in the file untouched.

// The document parsed, but its shape is not one we can edit safely.
export class ShapeError extends Error {}

export function readJsonc(text) {
  let i = 0;
  const fail = (why) => {
    throw new SyntaxError(`${why} at offset ${i}`);
  };
  const skip = () => {
    for (;;) {
      while (i < text.length && /\s/.test(text[i])) i++;
      if (text.startsWith('//', i)) {
        const nl = text.indexOf('\n', i);
        i = nl < 0 ? text.length : nl + 1;
      } else if (text.startsWith('/*', i)) {
        const end = text.indexOf('*/', i + 2);
        if (end < 0) fail('unterminated comment');
        i = end + 2;
      } else return;
    }
  };
  const string = () => {
    const start = i++;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    if (i >= text.length) fail('unterminated string');
    i++;
    return JSON.parse(text.slice(start, i));
  };
  const object = () => {
    const start = i++;
    const members = [];
    for (;;) {
      skip();
      if (text[i] === '}') break;
      const keyStart = i;
      if (text[i] !== '"') fail('expected a key');
      const key = string();
      skip();
      if (text[i] !== ':') fail('expected :');
      i++;
      const value = parse();
      members.push({ key, keyStart, value });
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] !== '}') fail('expected , or }');
    }
    i++;
    return { type: 'object', start, end: i, members };
  };
  const array = () => {
    const start = i++;
    for (;;) {
      skip();
      if (text[i] === ']') break;
      parse();
      skip();
      if (text[i] === ',') {
        i++;
        continue;
      }
      if (text[i] !== ']') fail('expected , or ]');
    }
    i++;
    return { type: 'array', start, end: i, members: [] };
  };
  const parse = () => {
    skip();
    const start = i;
    if (text[i] === '{') return object();
    if (text[i] === '[') return array();
    if (text[i] === '"') {
      string();
      return { type: 'string', start, end: i };
    }
    const lit = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/y;
    lit.lastIndex = i;
    const m = lit.exec(text);
    if (!m) fail('unexpected token');
    i += m[0].length;
    return { type: 'literal', start, end: i };
  };
  const root = parse();
  skip();
  if (i !== text.length) fail('unexpected trailing content');
  return root;
}

const memberText = (key, value) => `${JSON.stringify(key)}: ${value}`;

// Body of an entry nested two levels deep (its key sits at 4 spaces).
const entryBody = (entry) =>
  JSON.stringify(entry, null, 2).replace(/\n/g, '\n    ');

// Add `entry` as text[section][name]. Returns the edited text, or null when
// that entry is already present. Throws SyntaxError when the text does not
// parse and ShapeError when the root or section is not an object.
export function addJsoncEntry(text, section, name, entry) {
  if (!text.trim())
    return `${JSON.stringify({ [section]: { [name]: entry } }, null, 2)}\n`;
  const root = readJsonc(text);
  if (root.type !== 'object') throw new ShapeError('invalid settings root');
  const sec = root.members.find((m) => m.key === section);
  if (sec && sec.value.type !== 'object')
    throw new ShapeError(`invalid ${section}`);
  if (sec?.value.members.some((m) => m.key === name)) return null;

  const inner = memberText(name, entryBody(entry));
  let pos;
  let insert;
  if (sec) {
    const { members, start } = sec.value;
    if (members.length) {
      pos = members.at(-1).value.end;
      insert = `,\n    ${inner}`;
    } else {
      pos = start + 1;
      insert = `\n    ${inner}\n  `;
    }
  } else {
    const block = memberText(section, `{\n    ${inner}\n  }`);
    if (root.members.length) {
      pos = root.members.at(-1).value.end;
      insert = `,\n  ${block}`;
    } else {
      pos = root.start + 1;
      insert = `\n  ${block}\n`;
    }
  }
  const out = text.slice(0, pos) + insert + text.slice(pos);
  // The splice must leave a document that parses and holds the entry.
  const holds = readJsonc(out)
    .members.find((m) => m.key === section)
    ?.value.members.some((m) => m.key === name);
  if (!holds) throw new ShapeError('edit did not verify');
  return out;
}

// Remove members[k]. The member takes its own trailing comma, and its whole
// line when it has one to itself, so comments on other lines survive. A last
// member that had no comma of its own also takes the comma after the one
// before it.
function spliceOut(text, members, k) {
  const m = members[k];
  const lineStart = text.lastIndexOf('\n', m.keyStart - 1) + 1;
  const ownLine = /^[ \t]*$/.test(text.slice(lineStart, m.keyStart));
  const tail = /^[ \t]*,?/.exec(text.slice(m.value.end))[0];
  const spans = [[ownLine ? lineStart : m.keyStart, m.value.end + tail.length]];
  if (ownLine) {
    const eol = /^[ \t]*\r?\n/.exec(text.slice(spans[0][1]));
    if (eol) spans[0][1] += eol[0].length;
  }
  if (k > 0 && k === members.length - 1 && !tail.includes(','))
    spans.push([text.indexOf(',', members[k - 1].value.end), text.indexOf(',', members[k - 1].value.end) + 1]);
  let out = text;
  for (const [from, to] of spans.sort((a, b) => b[0] - a[0]))
    out = out.slice(0, from) + out.slice(to);
  return out;
}

// Remove text[section][name], and the section too when that leaves it empty.
// Returns the edited text, or null when the entry was not present.
export function removeJsoncEntry(text, section, name) {
  const root = readJsonc(text);
  if (root.type !== 'object') return null;
  const secIndex = root.members.findIndex((m) => m.key === section);
  if (secIndex < 0 || root.members[secIndex].value.type !== 'object') return null;
  const { members } = root.members[secIndex].value;
  const k = members.findIndex((m) => m.key === name);
  if (k < 0) return null;
  if (members.length === 1) return spliceOut(text, root.members, secIndex);
  return spliceOut(text, members, k);
}
