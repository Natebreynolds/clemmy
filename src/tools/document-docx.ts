import { parse, type DefaultTreeAdapterTypes as Html } from 'parse5';

const W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const BLOCKS = new Set(['p', 'div', 'section', 'article', 'main', 'header', 'footer', 'address', 'blockquote', 'pre', 'ul', 'ol', 'table', 'hr', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6']);
const UNSUPPORTED = new Set(['img', 'svg', 'canvas', 'iframe', 'object', 'embed', 'script', 'video', 'audio', 'form', 'input', 'math']);
const ALLOWED = new Set([...BLOCKS, 'span', 'strong', 'b', 'em', 'i', 'u', 'code', 'br', 'a', 's', 'del', 'strike', 'sup', 'sub', 'li', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption']);
const element = (node: Html.Node): node is Html.Element => 'tagName' in node;
const children = (node: Html.Node): Html.ChildNode[] => 'childNodes' in node ? node.childNodes : [];
const attr = (node: Html.Element, name: string): string | undefined => node.attrs.find(a => a.name === name)?.value;

function xml(value: string): string {
  for (const character of value) {
    const code = character.codePointAt(0)!;
    if (!(code === 9 || code === 10 || code === 13 || (code >= 32 && code <= 0xd7ff) || (code >= 0xe000 && code <= 0xfffd) || code >= 0x10000)) {
      throw new Error('DOCX content includes a character that XML cannot represent.');
    }
  }
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

interface Format { bold?: boolean; italic?: boolean; underline?: boolean; strike?: boolean; code?: boolean; vertical?: 'superscript' | 'subscript' }
interface Context { style?: string; bold?: boolean; list?: { id: number; level: number }; listItem?: { emitted: boolean } }

/** Standard WordprocessingML business documents, without executing HTML,
 * fetching linked content, relying on Word/Office or downloading a runtime.
 * HTML/CSS page layout and embedded media require the retained HTML/PDF path.
 */
export function htmlToPortableDocx(html: string): Buffer {
  if (Buffer.byteLength(html) > MAX_HTML_BYTES) throw new Error('DOCX content exceeds the 8 MiB document limit.');
  const document = parse(html);
  let count = 0;
  const validate = (node: Html.Node, depth = 0, inTable = false): void => {
    if (++count > 100_000 || depth > 64) throw new Error('DOCX content has too many elements or too much nesting.');
    if (element(node)) {
      if (UNSUPPORTED.has(node.tagName)) throw new Error(`DOCX does not support embedded ${node.tagName} content; use the rendered HTML or PDF.`);
      if (!ALLOWED.has(node.tagName) && node.tagName !== 'body') throw new Error(`DOCX does not support the ${node.tagName} HTML element; use the rendered HTML or PDF.`);
      if (node.tagName === 'table' && inTable) throw new Error('DOCX does not support nested tables.');
      if (node.attrs.some(a => a.name === 'style')) throw new Error('DOCX does not reproduce inline HTML/CSS layout; use the rendered HTML or PDF.');
      if (node.tagName === 'td' || node.tagName === 'th') {
        if (['colspan', 'rowspan'].some(name => attr(node, name) !== undefined && attr(node, name) !== '1')) throw new Error('DOCX supports simple tables without merged cells; use HTML or PDF for this table.');
      }
    }
    for (const child of children(node)) validate(child, depth + 1, inTable || (element(node) && node.tagName === 'table'));
  };
  const htmlNode = children(document).find(n => element(n) && n.tagName === 'html')!;
  const body = children(htmlNode).find(n => element(n) && n.tagName === 'body')!;
  validate(body);
  const relationships: string[] = [];
  const numbering: string[] = [];
  let numberId = 0;
  const run = (text: string, f: Format): string => {
    if (!text) return '';
    const props = [f.bold ? '<w:b/>' : '', f.italic ? '<w:i/>' : '', f.underline ? '<w:u w:val="single"/>' : '', f.strike ? '<w:strike/>' : '', f.code ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/>' : '', f.vertical ? `<w:vertAlign w:val="${f.vertical}"/>` : ''].join('');
    return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
  };
  const inline = (nodes: Html.ChildNode[], f: Format = {}, preserve = false): string => nodes.map(node => {
    if (node.nodeName === '#text') {
      const text = (node as Html.TextNode).value;
      return preserve ? text.split(/\r\n|\n|\r/).map(s => run(s, f)).join('<w:r><w:br/></w:r>') : run(text.replace(/[ \t\r\n\f]+/g, ' '), f);
    }
    if (!element(node)) return '';
    if (BLOCKS.has(node.tagName)) throw new Error('DOCX cannot flatten block content inside inline formatting; use the rendered HTML or PDF.');
    if (node.tagName === 'br') return '<w:r><w:br/></w:r>';
    const format = { ...f, ...(['strong', 'b'].includes(node.tagName) ? { bold: true } : {}), ...(['em', 'i'].includes(node.tagName) ? { italic: true } : {}), ...(['u'].includes(node.tagName) ? { underline: true } : {}), ...(['s', 'del', 'strike'].includes(node.tagName) ? { strike: true } : {}), ...(node.tagName === 'code' ? { code: true } : {}), ...(node.tagName === 'sup' ? { vertical: 'superscript' as const } : {}), ...(node.tagName === 'sub' ? { vertical: 'subscript' as const } : {}) };
    const rendered = inline(children(node), format, preserve);
    if (node.tagName === 'a' && attr(node, 'href')) {
      const target = attr(node, 'href')!;
      if (target.length > 2048 || !/^(https?:\/\/|mailto:)/i.test(target) || /[\u0000-\u0020]/.test(target)) throw new Error('DOCX links require a bounded HTTP, HTTPS or mailto target.');
      const id = `link${relationships.length + 1}`;
      relationships.push(`<Relationship Id="${id}" Type="${R}/hyperlink" Target="${xml(target)}" TargetMode="External"/>`);
      return `<w:hyperlink r:id="${id}">${rendered}</w:hyperlink>`;
    }
    return rendered;
  }).join('');
  const paragraph = (runs: string, context: Context = {}, border = false): string => {
    const numbered = context.list && !context.listItem?.emitted;
    if (numbered && context.listItem) context.listItem.emitted = true;
    const props = [context.style ? `<w:pStyle w:val="${context.style}"/>` : '', numbered ? `<w:numPr><w:ilvl w:val="${context.list!.level}"/><w:numId w:val="${context.list!.id}"/></w:numPr>` : context.list ? `<w:ind w:left="${720 * (context.list.level + 1)}"/>` : '', border ? '<w:pBdr><w:bottom w:val="single" w:sz="6" w:color="999999"/></w:pBdr>' : ''].join('');
    return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${runs}</w:p>`;
  };
  const blocks = (nodes: Html.ChildNode[], context: Context = {}): string => {
    const out: string[] = []; let pending: Html.ChildNode[] = [];
    const flush = (): void => {
      if (pending.some(n => element(n) || (n.nodeName === '#text' && (n as Html.TextNode).value.trim()))) out.push(paragraph(inline(pending, { bold: context.bold }), context));
      pending = [];
    };
    for (const node of nodes) {
      if (!element(node) || !BLOCKS.has(node.tagName)) { pending.push(node); continue; }
      flush();
      const tag = node.tagName;
      if (tag === 'ul' || tag === 'ol') {
        if (attr(node, 'reversed') !== undefined || (attr(node, 'type') !== undefined && (tag !== 'ol' || attr(node, 'type') !== '1'))) throw new Error('DOCX supports forward decimal or bullet lists; use HTML or PDF for this numbering style.');
        const level = context.list ? context.list.level + 1 : 0;
        if (level > 8) throw new Error('DOCX lists support at most nine nested levels.');
        const id = ++numberId;
        const start = Number(attr(node, 'start') ?? 1);
        if (!Number.isSafeInteger(start) || start < 1 || start > 10_000) throw new Error('DOCX list start must be between 1 and 10000.');
        numbering.push(`<w:num w:numId="${id}"><w:abstractNumId w:val="${tag === 'ul' ? 0 : 1}"/><w:lvlOverride w:ilvl="${level}"><w:startOverride w:val="${start}"/></w:lvlOverride></w:num>`);
        for (const item of children(node)) {
          if (!element(item) || item.tagName !== 'li') {
            if ((item.nodeName === '#text' && !(item as Html.TextNode).value.trim()) || item.nodeName === '#comment') continue;
            throw new Error('DOCX lists require explicit list items; use HTML or PDF for this structure.');
          }
          if (attr(item, 'value') !== undefined) throw new Error('DOCX does not support per-item list number overrides.');
          const itemContext: Context = { ...context, list: { id, level }, listItem: { emitted: false } };
          const rendered = blocks(children(item), itemContext);
          out.push((itemContext.listItem!.emitted ? '' : paragraph('', itemContext)) + rendered);
        }
      } else if (tag === 'table') {
        const caption = children(node).find(n => element(n) && n.tagName === 'caption');
        if (caption) out.push(paragraph(inline(children(caption)), context));
        const rows: Html.Element[] = [];
        const collectRows = (n: Html.Element): void => {
          for (const child of children(n)) if (element(child)) {
            if (child.tagName === 'tr') rows.push(child);
            else if (['thead', 'tbody', 'tfoot'].includes(child.tagName)) collectRows(child);
          }
        };
        collectRows(node);
        const columns = rows.length ? children(rows[0]).filter(n => element(n) && ['td', 'th'].includes(n.tagName)).length : 0;
        if (!columns || columns > 64 || rows.length > 2_000) throw new Error('DOCX table dimensions are unsupported.');
        const width = Math.floor(9360 / columns);
        const renderedRows = rows.map(row => {
          const cells = children(row).filter((n): n is Html.Element => element(n) && ['td', 'th'].includes(n.tagName));
          if (cells.length !== columns) throw new Error('DOCX requires the same number of cells in each table row.');
          return `<w:tr>${cells.every(c => c.tagName === 'th') ? '<w:trPr><w:tblHeader/></w:trPr>' : ''}${cells.map(cell => {
            if (children(cell).some(n => element(n) && n.tagName === 'table')) throw new Error('DOCX does not support nested tables.');
            return `<w:tc><w:tcPr><w:tcW w:w="${width}" w:type="dxa"/></w:tcPr>${blocks(children(cell), { bold: cell.tagName === 'th' }) || paragraph('')}</w:tc>`;
          }).join('')}</w:tr>`;
        }).join('');
        const borders = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV'].map(side => `<w:${side} w:val="single" w:sz="6" w:color="999999"/>`).join('');
        out.push(`<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr><w:tblGrid>${cellsXml(columns, width)}</w:tblGrid>${renderedRows}</w:tbl>`);
      } else if (tag === 'pre') out.push(paragraph(inline(children(node), { code: true }, true), context));
      else if (tag === 'hr') out.push(paragraph('', context, true));
      else if (/^h[1-6]$/.test(tag)) out.push(paragraph(inline(children(node), { bold: context.bold }), { ...context, style: `Heading${tag[1]}` }));
      else if (tag === 'p') out.push(paragraph(inline(children(node), { bold: context.bold }), context));
      else out.push(blocks(children(node), tag === 'blockquote' ? { ...context, style: 'Quote' } : context));
    }
    flush(); return out.join('');
  };
  const bodyXml = blocks(children(body)) || paragraph('');
  const styles = `<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:pPr><w:spacing w:after="160"/></w:pPr><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="24"/></w:rPr></w:style>`
    + [40, 32, 26, 24, 24, 24].map((size, i) => `<w:style w:type="paragraph" w:styleId="Heading${i + 1}"><w:name w:val="heading ${i + 1}"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="${i}"/></w:pPr><w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`).join('')
    + '<w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:ind w:left="360"/></w:pPr><w:rPr><w:i/></w:rPr></w:style>';
  const abstractNumbers = ['bullet', 'decimal'].map((format, i) => `<w:abstractNum w:abstractNumId="${i}"><w:multiLevelType w:val="multilevel"/>${Array.from({ length: 9 }, (_, level) => `<w:lvl w:ilvl="${level}"><w:start w:val="1"/><w:numFmt w:val="${format}"/><w:lvlText w:val="${format === 'bullet' ? '•' : `%${level + 1}.`}"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="${720 * (level + 1)}"/></w:tabs><w:ind w:left="${720 * (level + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join('')}</w:abstractNum>`).join('');
  return storedZip({
    '[Content_Types].xml': `${XML}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/></Types>`,
    '_rels/.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="document" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': `${XML}<w:document xmlns:w="${W}" xmlns:r="${R}"><w:body>${bodyXml}<w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body></w:document>`,
    'word/styles.xml': `${XML}<w:styles xmlns:w="${W}">${styles}</w:styles>`,
    'word/numbering.xml': `${XML}<w:numbering xmlns:w="${W}">${abstractNumbers}${numbering.join('')}</w:numbering>`,
    'word/_rels/document.xml.rels': `${XML}<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="styles" Type="${R}/styles" Target="styles.xml"/><Relationship Id="numbering" Type="${R}/numbering" Target="numbering.xml"/>${relationships.join('')}</Relationships>`,
  });
}

function cellsXml(columns: number, width: number): string {
  return Array.from({ length: columns }, () => `<w:gridCol w:w="${width}"/>`).join('');
}

/** A bounded, stored ZIP container: UTF-8 names, exact CRC and central offsets.
 * Entry names are host constants; document input can never create archive paths.
 */
function storedZip(parts: Record<string, string>): Buffer {
  const local: Buffer[] = [], central: Buffer[] = []; let offset = 0;
  for (const [name, text] of Object.entries(parts)) {
    const filename = Buffer.from(name), data = Buffer.from(text);
    let crc = 0xffffffff;
    for (const byte of data) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(0x21, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46); directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8); directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(crc, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    local.push(header, filename, data); central.push(directory, filename); offset += header.length + filename.length + data.length;
    if (offset > 64 * 1024 * 1024) throw new Error('DOCX output exceeds the 64 MiB document limit.');
  }
  const directoryBytes = Buffer.concat(central), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(central.length / 2, 8); end.writeUInt16LE(central.length / 2, 10); end.writeUInt32LE(directoryBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directoryBytes, end]);
}
