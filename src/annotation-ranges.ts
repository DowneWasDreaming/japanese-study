export interface TextAnchor { start: number; end: number; text: string; }
export interface HighlightAnchor extends TextAnchor { id: string; }

/** Offsets deliberately use JavaScript/DOM UTF-16 units, matching saved question strings. */
export function isTextBoundary(text: string, index: number) {
  if (!Number.isInteger(index) || index < 0 || index > text.length) return false;
  if (index === 0 || index === text.length) return true;
  const before = text.charCodeAt(index - 1), after = text.charCodeAt(index);
  return !(before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff);
}

export function validTextAnchor(source: string, anchor: TextAnchor, maxLength = 500) {
  return isTextBoundary(source, anchor.start) && isTextBoundary(source, anchor.end)
    && anchor.end > anchor.start && anchor.text.trim().length > 0
    && anchor.text.length <= maxLength && source.slice(anchor.start, anchor.end) === anchor.text;
}

export function findTextOccurrences(source: string, text: string): TextAnchor[] {
  if (!text.trim() || text.length > 500) return [];
  const matches: TextAnchor[] = [];
  let start = source.indexOf(text);
  while (start !== -1) {
    const anchor = { start, end: start + text.length, text };
    if (validTextAnchor(source, anchor)) matches.push(anchor);
    start = source.indexOf(text, start + 1);
  }
  return matches;
}

/** Split at every boundary so overlapping selections never duplicate or alter source text. */
export function highlightTextSegments(source: string, anchors: HighlightAnchor[]) {
  const valid = anchors.filter(anchor => validTextAnchor(source, anchor));
  const boundaries = [...new Set([0, source.length, ...valid.flatMap(anchor => [anchor.start, anchor.end])])].sort((a, b) => a - b);
  return boundaries.slice(0, -1).map((start, index) => {
    const end = boundaries[index + 1];
    return { start, end, text: source.slice(start, end), ids: valid.filter(anchor => anchor.start < end && anchor.end > start).map(anchor => anchor.id) };
  });
}
