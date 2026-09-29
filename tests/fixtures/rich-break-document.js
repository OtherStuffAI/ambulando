// Generic rich-paste reduction: break boundaries, underline and shared italic.
export function richBreakDocumentFixture() {
  const text = (value, marks = []) => ({ type: 'text', text: value, marks });
  const br = () => ({ type: 'hardBreak' });
  const paragraph = (...content) => ({ type: 'paragraph', content });
  const italic = { type: 'italic' };
  const bold = { type: 'bold' };
  const underline = { type: 'underline' };
  const link = { type: 'link', attrs: { href: 'https://example.com/guide' } };
  return { type: 'doc', content: [
    paragraph(text('Opening')),
    paragraph(br(), text('Leading break')),
    paragraph(br()),
    paragraph(text('Before  '), br(), br(), text('After'), br(), br()),
    paragraph(br(), text('Note:', [bold, italic]), text(' read the ', [italic]),
      text('guide', [link, italic, underline]), text(' before editing.', [italic])),
    { type: 'bulletList', content: [{ type: 'listItem', content: [
      paragraph(text('Underlined guide', [link, underline])),
      paragraph(br(), text('Continuation'), br()),
    ] }] },
    paragraph(text('Underlined ', [underline]), text('bold', [bold, underline]), text(' tail', [underline])),
    paragraph(text('Tail retained'), br(), br(), br()),
  ] };
}
